import { Request, RequestHandler, Router } from "express";
import { config } from "../config";
import { transformAnthropicChatResponseToOpenAI } from "./anthropic";
import { ipLimiter } from "./rate-limit";
import {
  createPreprocessorMiddleware,
  finalizeSignedRequest,
  signGcpRequest,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

const LATEST_GCP_SONNET_MINOR_VERSION = "20240229";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.gcpCredentials) return { object: "list", data: [] };

  // https://docs.anthropic.com/en/docs/about-claude/models
  const variants = [
    "claude-3-haiku@20240307",
    "claude-3-5-haiku@20241022",
    "claude-3-sonnet@20240229",
    "claude-3-5-sonnet@20240620",
    "claude-3-5-sonnet-v2@20241022",
    "claude-3-opus@20240229",
  ];

  const models = variants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "anthropic",
    permission: [],
    root: "claude",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const gcpBlockingResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  switch (`${req.inboundApi}<-${req.outboundApi}`) {
    case "openai<-anthropic-chat":
      req.log.info("Transforming Anthropic Chat back to OpenAI format");
      newBody = transformAnthropicChatResponseToOpenAI(body);
      break;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const gcpProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }) => {
    if (!signedRequest) throw new Error("Must sign request before proxying");
    return `${signedRequest.protocol}//${signedRequest.hostname}`;
  },
  mutations: [signGcpRequest, finalizeSignedRequest],
  blockingResponseHandler: gcpBlockingResponseHandler,
});

const oaiToChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "openai", outApi: "anthropic-chat", service: "gcp" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes an OpenAI prompt to either the legacy Claude text completion endpoint
 * or the new Claude chat completion endpoint, based on the requested model.
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  oaiToChatPreprocessor(req, res, next);
};

const gcpRouter = Router();
gcpRouter.get("/v1/models", handleModelRequest);
// Native Anthropic chat completion endpoint.
gcpRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic-chat", outApi: "anthropic-chat", service: "gcp" },
    { afterTransform: [maybeReassignModel] }
  ),
  gcpProxy
);

// OpenAI-to-GCP Anthropic compatibility endpoint.
gcpRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  gcpProxy
);

/**
 * Tries to deal with:
 * - frontends sending GCP model names even when they want to use the OpenAI-
 *   compatible endpoint
 * - frontends sending Anthropic model names that GCP doesn't recognize
 * - frontends sending OpenAI model names because they expect the proxy to
 *   translate them
 *
 * If client sends GCP model ID it will be used verbatim. Otherwise, various
 * strategies are used to try to map a non-GCP model name to GCP model ID.
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;

  // If it looks like an GCP model, use it as-is
  // if (model.includes("anthropic.claude")) {
  if (model.startsWith("claude-") && model.includes("@")) {
    return;
  }

  // Anthropic model names can look like:
  // - claude-v1
  // - claude-2.1
  // - claude-3-5-sonnet-20240620-v1:0
  const pattern =
    /^(claude-)?(instant-)?(v)?(\d+)([.-](\d{1}))?(-\d+k)?(-sonnet-|-opus-|-haiku-)?(\d*)/i;
  const match = model.match(pattern);

  // If there's no match, fallback to Claude3 Sonnet as it is most likely to be
  // available on GCP.
  if (!match) {
    req.body.model = `claude-3-sonnet@${LATEST_GCP_SONNET_MINOR_VERSION}`;
    return;
  }

  const [_, _cl, instant, _v, major, _sep, minor, _ctx, name, rev] = match;

  // TODO: rework this to function similarly to aws-claude.ts maybeReassignModel
  const ver = minor ? `${major}.${minor}` : major;
  switch (ver) {
    case "3":
    case "3.0":
      if (name.includes("opus")) {
        req.body.model = "claude-3-opus@20240229";
      } else if (name.includes("haiku")) {
        req.body.model = "claude-3-haiku@20240307";
      } else {
        req.body.model = "claude-3-sonnet@20240229";
      }
      return;
    case "3.5":
      switch (name) {
        case "sonnet":
          switch (rev) {
            case "20241022":
            case "latest":
              req.body.model = "claude-3-5-sonnet-v2@20241022";
              return;
            case "20240620":
              req.body.model = "claude-3-5-sonnet@20240620";
              return;
          }
          break;
        case "haiku":
          req.body.model = "claude-3-5-haiku@20241022";
          return;
        case "opus":
          // Add after model ids are announced late 2024
          break;
      }
  }

  // Fallback to Claude3 Sonnet
  req.body.model = `claude-3-sonnet@${LATEST_GCP_SONNET_MINOR_VERSION}`;
  return;
}

export const gcp = gcpRouter;
