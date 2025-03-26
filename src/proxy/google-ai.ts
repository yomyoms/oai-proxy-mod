import { Request, RequestHandler, Router } from "express";
import { v4 } from "uuid";
import { GoogleAIKey, keyPool } from "../shared/key-management";
import { config } from "../config";
import { ipLimiter } from "./rate-limit";
import {
  createPreprocessorMiddleware,
  finalizeSignedRequest,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { addGoogleAIKey } from "./middleware/request/mutators/add-google-ai-key";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

let modelsCache: any = null;
let modelsCacheTime = 0;

// https://ai.google.dev/models/gemini
// TODO: list models https://ai.google.dev/tutorials/rest_quickstart#list_models

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.googleAIKey) return { object: "list", data: [] };

  const keys = keyPool
    .list()
    .filter((k) => k.service === "google-ai") as GoogleAIKey[];
  if (keys.length === 0) {
    modelsCache = { object: "list", data: [] };
    modelsCacheTime = new Date().getTime();
    return modelsCache;
  }

  const modelIds = Array.from(
    new Set(keys.map((k) => k.modelIds).flat())
  ).filter((id) => id.startsWith("models/gemini"));
  const models = modelIds.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "google",
    permission: [],
    root: "google",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const googleAIBlockingResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  if (req.inboundApi === "openai") {
    req.log.info("Transforming Google AI response to OpenAI format");
    newBody = transformGoogleAIResponse(body, req);
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function transformGoogleAIResponse(
  resBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  const parts = resBody.candidates[0].content?.parts ?? [{ text: "" }];
  const content = parts[0].text.replace(/^(.{0,50}?): /, () => "");
  return {
    id: "goo-" + v4(),
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
        message: { role: "assistant", content },
        finish_reason: resBody.candidates[0].finishReason,
        index: 0,
      },
    ],
  };
}

const googleAIProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }) => {
    if (!signedRequest) throw new Error("Must sign request before proxying");
    const { protocol, hostname} = signedRequest;
    return `${protocol}//${hostname}`;
  },
  mutations: [addGoogleAIKey, finalizeSignedRequest],
  blockingResponseHandler: googleAIBlockingResponseHandler,
});

const googleAIRouter = Router();
googleAIRouter.get("/v1/models", handleModelRequest);

// Native Google AI chat completion endpoint
googleAIRouter.post(
  "/v1beta/models/:modelId:(generateContent|streamGenerateContent)",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "google-ai", outApi: "google-ai", service: "google-ai" },
    { beforeTransform: [maybeReassignModel], afterTransform: [setStreamFlag] }
  ),
  googleAIProxy
);

// OpenAI-to-Google AI compatibility endpoint.
googleAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "google-ai", service: "google-ai" },
    { afterTransform: [maybeReassignModel] }
  ),
  googleAIProxy
);

function setStreamFlag(req: Request) {
  const isStreaming = req.url.includes("streamGenerateContent");
  if (isStreaming) {
    req.body.stream = true;
    req.isStreaming = true;
  } else {
    req.body.stream = false;
    req.isStreaming = false;
  }
}

/**
 * Replaces requests for non-Google AI models with gemini-1.5-pro-latest.
 * Also strips models/ from the beginning of the model IDs.
 **/
function maybeReassignModel(req: Request) {
  // Ensure model is on body as a lot of middleware will expect it.
  const model = req.body.model || req.url.split("/").pop()?.split(":").shift();
  if (!model) {
    throw new Error("You must specify a model with your request.");
  }
  req.body.model = model;

  const requested = model;
  if (requested.startsWith("models/")) {
    req.body.model = requested.slice("models/".length);
  }

  if (requested.includes("gemini")) {
    return;
  }

  req.log.info({ requested }, "Reassigning model to gemini-1.5-pro-latest");
  req.body.model = "gemini-1.5-pro-latest";
}

export const googleAI = googleAIRouter;
