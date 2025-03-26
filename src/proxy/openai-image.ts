import { Request, RequestHandler, Router } from "express";
import { OpenAIImageGenerationResult } from "../shared/file-storage/mirror-generated-image";
import { generateModelList } from "./openai";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

const KNOWN_MODELS = ["dall-e-2", "dall-e-3"];

let modelListCache: any = null;
let modelListValid = 0;
const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelListValid < 1000 * 60) {
    return res.status(200).json(modelListCache);
  }
  const result = generateModelList("openai").filter((m: { id: string }) =>
    KNOWN_MODELS.includes(m.id)
  );
  modelListCache = { object: "list", data: result };
  modelListValid = new Date().getTime();
  res.status(200).json(modelListCache);
};

const openaiImagesResponseHandler: ProxyResHandlerWithBody = async (
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
    req.log.info("Transforming OpenAI image response to OpenAI chat format");
    newBody = transformResponseForChat(
      body as OpenAIImageGenerationResult,
      req
    );
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

/**
 * Transforms a DALL-E image generation response into a chat response, simply
 * embedding the image URL into the chat message as a Markdown image.
 */
function transformResponseForChat(
  imageBody: OpenAIImageGenerationResult,
  req: Request
): Record<string, any> {
  const prompt = imageBody.data[0].revised_prompt ?? req.body.prompt;
  const content = imageBody.data
    .map((item) => {
      const { url, b64_json } = item;
      if (b64_json) {
        return `![${prompt}](data:image/png;base64,${b64_json})`;
      } else {
        return `![${prompt}](${url})`;
      }
    })
    .join("\n\n");

  return {
    id: "dalle-" + req.id,
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: req.outputTokens,
      total_tokens: req.outputTokens,
    },
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: "stop",
        index: 0,
      },
    ],
  };
}

function replacePath(manager: ProxyReqManager) {
  const req = manager.request;
  const pathname = req.url.split("?")[0];
  req.log.debug({ pathname }, "OpenAI image path filter");
  if (req.path.startsWith("/v1/chat/completions")) {
    manager.setPath("/v1/images/generations");
  }
}

const openaiImagesProxy = createQueuedProxyMiddleware({
  target: "https://api.openai.com",
  mutations: [replacePath, addKey, finalizeBody],
  blockingResponseHandler: openaiImagesResponseHandler,
});

const openaiImagesRouter = Router();
openaiImagesRouter.get("/v1/models", handleModelRequest);
openaiImagesRouter.post(
  "/v1/images/generations",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-image",
    outApi: "openai-image",
    service: "openai",
  }),
  openaiImagesProxy
);
openaiImagesRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai",
    outApi: "openai-image",
    service: "openai",
  }),
  openaiImagesProxy
);
export const openaiImage = openaiImagesRouter;
