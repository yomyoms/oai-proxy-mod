import { Request, RequestHandler, Router } from "express";
import { v4 } from "uuid";
import {
  transformAnthropicChatResponseToAnthropicText,
  transformAnthropicChatResponseToOpenAI,
} from "./anthropic";
import { ipLimiter } from "./rate-limit";
import {
  createPreprocessorMiddleware,
  finalizeSignedRequest,
  signAwsRequest,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

const awsBlockingResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  // Complete raw passthrough - send the exact response back
  res.status(200).send(body);
};

function transformAwsTextResponseToOpenAI(
  awsBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "aws-" + v4(),
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: awsBody.completion?.trim(),
        },
        finish_reason: awsBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const awsClaudeProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }) => {
    if (!signedRequest) throw new Error("Must sign request before proxying");
    return `${signedRequest.protocol}//${signedRequest.hostname}`;
  },
  mutations: [signAwsRequest, finalizeSignedRequest],
  blockingResponseHandler: awsBlockingResponseHandler,
});

const nativeTextPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-text", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

const textToChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-chat", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes text completion prompts to aws anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const preprocessAwsTextRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.includes("claude-3")) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const oaiToNativePreprocessor = createPreprocessorMiddleware({
  inApi: "openai",
  outApi: "openai",
  service: "aws",
});

/**
 * Routes an OpenAI prompt directly without API transformation, except for thinking parameter
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  // If thinking parameter is present, we need to ensure it's properly handled
  if (req.body.thinking !== undefined) {
    const thinkingPreprocessor = createPreprocessorMiddleware({
      inApi: "openai",
      outApi: "anthropic-chat",
      service: "aws"
    }, { afterTransform: [maybeReassignModel] });
    thinkingPreprocessor(req, res, next);
  } else {
    // Otherwise use the default passthrough
    oaiToNativePreprocessor(req, res, next);
  }
};

const awsClaudeRouter = Router();
// Native(ish) Anthropic text completion endpoint.
awsClaudeRouter.post(
  "/v1/complete",
  ipLimiter,
  preprocessAwsTextRequest,
  awsClaudeProxy
);
// Native Anthropic chat completion endpoint.
awsClaudeRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic-chat", outApi: "anthropic-chat", service: "aws" },
    { afterTransform: [maybeReassignModel] }
  ),
  awsClaudeProxy
);

// OpenAI-to-AWS Anthropic compatibility endpoint.
awsClaudeRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  awsClaudeProxy
);

/**
 * Tries to deal with:
 * - frontends sending AWS model names even when they want to use the OpenAI-
 *   compatible endpoint
 * - frontends sending Anthropic model names that AWS doesn't recognize
 * - frontends sending OpenAI model names because they expect the proxy to
 *   translate them
 *
 * If client sends AWS model ID it will be used verbatim. Otherwise, various
 * strategies are used to try to map a non-AWS model name to AWS model ID.
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;

  // If it looks like an AWS model, use it as-is
  if (model.includes("anthropic.claude")) {
    return;
  }

  // Anthropic model names can look like:
  // - claude-v1
  // - claude-2.1
  // - claude-3-5-sonnet-20240620
  // - claude-3-opus-latest
  const pattern =
    /^(claude-)?(instant-)?(v)?(\d+)([.-](\d))?(-\d+k)?(-sonnet-|-opus-|-haiku-)?(latest|\d*)/i;
  const match = model.match(pattern);

  if (!match) {
    throw new Error(`Provided model name (${model}) doesn't resemble a Claude model ID.`);
  }

  const [_, _cl, instant, _v, major, _sep, minor, _ctx, rawName, rev] = match;

  if (instant) {
    req.body.model = "anthropic.claude-instant-v1";
    return;
  }

  const ver = minor ? `${major}.${minor}` : major;
  const name = rawName?.match(/([a-z]+)/)?.[1] || "";

  switch (ver) {
    case "1":
    case "1.0":
      req.body.model = "anthropic.claude-v1";
      return;
    case "2":
    case "2.0":
      req.body.model = "anthropic.claude-v2";
      return;
    case "2.1":
      req.body.model = "anthropic.claude-v2:1";
      return;
    case "3":
    case "3.0":
      // there is only one snapshot for all Claude 3 models so there is no need
      // to check the revision
      switch (name) {
        case "sonnet":
          req.body.model = "anthropic.claude-3-sonnet-20240229-v1:0";
          return;
        case "haiku":
          req.body.model = "anthropic.claude-3-haiku-20240307-v1:0";
          return;
        case "opus":
          req.body.model = "anthropic.claude-3-opus-20240229-v1:0";
          return;
      }
      break;
    case "3.5":
      switch (name) {
        case "sonnet":
          switch (rev) {
            case "20241022":
            case "latest":
              req.body.model = "anthropic.claude-3-5-sonnet-20241022-v2:0";
              return;
            case "20240620":
              req.body.model = "anthropic.claude-3-5-sonnet-20240620-v1:0";
              return;
          }
          break;
        case "haiku":
          switch (rev) {
            case "20241022":
            case "latest":
              req.body.model = "anthropic.claude-3-5-haiku-20241022-v1:0";
              return;
          }
        case "opus":
          // Add after model id is announced never
          break;
      }
  }

  throw new Error(`Provided model name (${model}) could not be mapped to a known AWS Claude model ID.`);
}

export const awsClaude = awsClaudeRouter;
