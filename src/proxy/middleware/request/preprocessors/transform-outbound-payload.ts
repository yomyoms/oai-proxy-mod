import { Request } from "express";
import {
  API_REQUEST_VALIDATORS,
  API_REQUEST_TRANSFORMERS,
} from "../../../../shared/api-schemas";
import { BadRequestError } from "../../../../shared/errors";
import { fixMistralPrompt } from "../../../../shared/api-schemas/mistral-ai";
import {
  isImageGenerationRequest,
  isTextGenerationRequest,
} from "../../common";
import { RequestPreprocessor } from "../index";

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable =
    !isTextGenerationRequest(req) && !isImageGenerationRequest(req);

  if (alreadyTransformed) {
    return;
  } else if (notTransformable) {
    // This is probably an indication of a bug in the proxy.
    const { inboundApi, outboundApi, method, path } = req;
    req.log.warn(
      { inboundApi, outboundApi, method, path },
      "`transformOutboundPayload` called on a non-transformable request."
    );
    return;
  }

  applyMistralPromptFixes(req);

  // Native prompts are those which were already provided by the client in the
  // target API format. We don't need to transform them.
  const isNativePrompt = req.inboundApi === req.outboundApi;
  if (isNativePrompt) {
    const result = API_REQUEST_VALIDATORS[req.inboundApi].parse(req.body);
    req.body = result;
    return;
  }

  // Prompt requires translation from one API format to another.
  const transformation = `${req.inboundApi}->${req.outboundApi}` as const;
  const transFn = API_REQUEST_TRANSFORMERS[transformation];

  if (transFn) {
    req.log.info({ transformation }, "Transforming request...");
    req.body = await transFn(req);
    return;
  }

  throw new BadRequestError(
    `${transformation} proxying is not supported. Make sure your client is configured to send requests in the correct format and to the correct endpoint.`
  );
};

// handles weird cases that don't fit into our abstractions
function applyMistralPromptFixes(req: Request): void {
  if (req.inboundApi === "mistral-ai") {
    // Mistral Chat is very similar to OpenAI but not identical and many clients
    // don't properly handle the differences. We will try to validate the
    // mistral prompt and try to fix it if it fails. It will be re-validated
    // after this function returns.
    const result = API_REQUEST_VALIDATORS["mistral-ai"].parse(req.body);
    req.body.messages = fixMistralPrompt(result.messages);
    req.log.info(
      { n: req.body.messages.length, prev: result.messages.length },
      "Applied Mistral chat prompt fixes."
    );

    // If the prompt relies on `prefix: true` for the last message, we need to
    // convert it to a text completions request because AWS Mistral support for
    // this feature is broken.
    // On Mistral La Plateforme, we can't do this because they don't expose
    // a text completions endpoint.
    const { messages } = req.body;
    const lastMessage = messages && messages[messages.length - 1];
    if (lastMessage?.role === "assistant" && req.service === "aws") {
      // enable prefix if client forgot, otherwise the template will insert an
      // eos token which is very unlikely to be what the client wants.
      lastMessage.prefix = true;
      req.outboundApi = "mistral-text";
      req.log.info(
        "Native Mistral chat prompt relies on assistant message prefix. Converting to text completions request."
      );
    }
  }
}
