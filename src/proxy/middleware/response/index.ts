/* This file is fucking horrendous, sorry */
// TODO: extract all per-service error response handling into its own modules
import { Request, Response } from "express";
import * as http from "http";
import { config } from "../../../config";
import { HttpError, RetryableError } from "../../../shared/errors";
import { keyPool } from "../../../shared/key-management";
import { getOpenAIModelFamily } from "../../../shared/models";
import { countTokens } from "../../../shared/tokenization";
import {
  incrementPromptCount,
  incrementTokenCount,
} from "../../../shared/users/user-store";
import { assertNever } from "../../../shared/utils";
import { reenqueueRequest, trackWaitTime } from "../../queue";
import { refundLastAttempt } from "../../rate-limit";
import {
  getCompletionFromBody,
  isImageGenerationRequest,
  isTextGenerationRequest,
  sendProxyError,
} from "../common";
import { handleBlockingResponse } from "./handle-blocking-response";
import { handleStreamedResponse } from "./handle-streamed-response";
import { logPrompt } from "./log-prompt";
import { logEvent } from "./log-event";
import { saveImage } from "./save-image";

/**
 * Either decodes or streams the entire response body and then resolves with it.
 * @returns The response body as a string or parsed JSON object depending on the
 * response's content-type.
 */
export type RawResponseBodyHandler = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => Promise<string | Record<string, any>>;

export type ProxyResHandlerWithBody = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response,
  /**
   * This will be an object if the response content-type is application/json,
   * or if the response is a streaming response. Otherwise it will be a string.
   */
  body: string | Record<string, any>
) => Promise<void>;
export type ProxyResMiddleware = ProxyResHandlerWithBody[] | undefined;

/**
 * Returns a on.proxyRes handler that executes the given middleware stack after
 * the common proxy response handlers have processed the response and decoded
 * the body.  Custom middleware won't execute if the response is determined to
 * be an error from the upstream service as the response will be taken over by
 * the common error handler.
 *
 * For streaming responses, the handleStream middleware will block remaining
 * middleware from executing as it consumes the stream and forwards events to
 * the client. Once the stream is closed, the finalized body will be attached
 * to res.body and the remaining middleware will execute.
 *
 * @param apiMiddleware - Custom middleware to execute after the common response
 * handlers. These *only* execute for non-streaming responses, so should be used
 * to transform non-streaming responses into the desired format.
 */
export const createOnProxyResHandler = (apiMiddleware: ProxyResMiddleware) => {
  return async (
    proxyRes: http.IncomingMessage,
    req: Request,
    res: Response
  ) => {
    // Proxied request has by now been sent to the upstream API, so we revert
    // tracked mutations that were only needed to send the request.
    // This generally means path adjustment, headers, and body serialization.
    if (req.changeManager) {
      req.changeManager.revert();
    }

    const initialHandler = req.isStreaming
      ? handleStreamedResponse
      : handleBlockingResponse;
    let lastMiddleware = initialHandler.name;

    if (Buffer.isBuffer(req.body)) {
      req.body = JSON.parse(req.body.toString());
    }

    try {
      const body = await initialHandler(proxyRes, req, res);
      const middlewareStack: ProxyResMiddleware = [];

      if (req.isStreaming) {
        // Handlers for streaming requests must never write to the response.
        middlewareStack.push(
          trackKeyRateLimit,
          countResponseTokens,
          incrementUsage,
          logPrompt,
          logEvent
        );
      } else {
        middlewareStack.push(
          trackKeyRateLimit,
          injectProxyInfo,
          handleUpstreamErrors,
          countResponseTokens,
          incrementUsage,
          copyHttpHeaders,
          saveImage,
          logPrompt,
          logEvent,
          ...(apiMiddleware ?? [])
        );
      }

      for (const middleware of middlewareStack) {
        lastMiddleware = middleware.name;
        await middleware(proxyRes, req, res, body);
      }

      trackWaitTime(req);
    } catch (error) {
      // Hack: if the error is a retryable rate-limit error, the request has
      // been re-enqueued and we can just return without doing anything else.
      if (error instanceof RetryableError) {
        return;
      }

      // Already logged and responded to the client by handleUpstreamErrors
      if (error instanceof HttpError) {
        if (!res.writableEnded) res.end();
        return;
      }

      const { stack, message } = error;
      const details = { stack, message, lastMiddleware, key: req.key?.hash };
      const description = `Error while executing proxy response middleware: ${lastMiddleware} (${message})`;

      if (res.headersSent) {
        req.log.error(details, description);
        if (!res.writableEnded) res.end();
        return;
      } else {
        req.log.error(details, description);
        res
          .status(500)
          .json({ error: "Internal server error", proxy_note: description });
      }
    }
  };
};

type ProxiedErrorPayload = {
  error?: Record<string, any>;
  message?: string;
  proxy_note?: string;
};

/**
 * Handles non-2xx responses from the upstream service.  If the proxied response
 * is an error, this will respond to the client with an error payload and throw
 * an error to stop the middleware stack.
 * On 429 errors, if request queueing is enabled, the request will be silently
 * re-enqueued.  Otherwise, the request will be rejected with an error payload.
 * @throws {HttpError} On HTTP error status code from upstream service
 */
const handleUpstreamErrors: ProxyResHandlerWithBody = async (
  proxyRes,
  req,
  res,
  body
) => {
  const statusCode = proxyRes.statusCode || 500;
  const statusMessage = proxyRes.statusMessage || "Internal Server Error";
  const service = req.key!.service;
  // Not an error, continue to next response handler
  if (statusCode < 400) return;

  // Parse the error response body
  let errorPayload: ProxiedErrorPayload;
  try {
    assertJsonResponse(body);
    errorPayload = body;
  } catch (parseError) {
    const strBody = String(body).slice(0, 128);
    req.log.error({ statusCode, strBody }, "Error body is not JSON");

    const details = {
      error: parseError.message,
      status: statusCode,
      statusMessage,
      proxy_note: `Proxy got back an error, but it was not in JSON format. This is likely a temporary problem with the upstream service. Response body: ${strBody}`,
    };

    sendProxyError(req, res, statusCode, statusMessage, details);
    throw new HttpError(statusCode, parseError.message);
  }

  // Extract the error type from the response body depending on the service
  if (service === "gcp") {
    if (Array.isArray(errorPayload)) {
      errorPayload = errorPayload[0];
    }
  }
  const errorType =
    errorPayload.error?.code ||
    errorPayload.error?.type ||
    getAwsErrorType(proxyRes.headers["x-amzn-errortype"]);

  req.log.warn(
    { statusCode, statusMessage, errorType, errorPayload, key: req.key?.hash },
    `API returned an error.`
  );

  // Try to convert response body to a ProxiedErrorPayload with message/type
  if (service === "aws") {
    errorPayload.error = { message: errorPayload.message, type: errorType };
    delete errorPayload.message;
  } else if (service === "gcp") {
    if (errorPayload.error?.code) {
      errorPayload.error = {
        message: errorPayload.error.message,
        type: errorPayload.error.status || errorPayload.error.code,
      };
    }
  }

  // Figure out what to do with the error
  // TODO: separate error handling for each service
  if (statusCode === 400) {
    switch (service) {
      case "openai":
      case "mistral-ai":
      case "azure":
        const filteredCodes = ["content_policy_violation", "content_filter"];
        if (filteredCodes.includes(errorPayload.error?.code)) {
          errorPayload.proxy_note = `Request was filtered by the upstream API's content moderation system. Modify your prompt and try again.`;
          refundLastAttempt(req);
        } else if (errorPayload.error?.code === "billing_hard_limit_reached") {
          // For some reason, some models return this 400 error instead of the
          // same 429 billing error that other models return.
          await handleOpenAIRateLimitError(req, errorPayload);
        } else {
          errorPayload.proxy_note = `The upstream API rejected the request. Check the error message for details.`;
        }
        break;
      case "anthropic":
      case "aws":
      case "gcp":
        await handleAnthropicAwsBadRequestError(req, errorPayload);
        break;
      case "google-ai":
        await handleGoogleAIBadRequestError(req, errorPayload);
        break;
      default:
        assertNever(service);
    }
  } else if (statusCode === 401) {
    // Key is invalid or was revoked
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `Assigned API key is invalid or revoked, please try again.`;
  } else if (statusCode === 403) {
    switch (service) {
      case "anthropic":
        if (
          errorType === "permission_error" &&
          errorPayload.error?.message?.toLowerCase().includes("multimodal")
        ) {
          keyPool.update(req.key!, { allowsMultimodality: false });
          await reenqueueRequest(req);
          throw new RetryableError(
            "Claude request re-enqueued because key does not support multimodality."
          );
        } else {
          keyPool.disable(req.key!, "revoked");
          errorPayload.proxy_note = `Assigned API key is invalid or revoked, please try again.`;
        }
        return;
      case "aws":
        switch (errorType) {
          case "UnrecognizedClientException":
            // Key is invalid.
            keyPool.disable(req.key!, "revoked");
            errorPayload.proxy_note = `Assigned API key is invalid or revoked, please try again.`;
            break;
          case "AccessDeniedException":
            const isModelAccessError =
              errorPayload.error?.message?.includes(`specified model ID`);
            if (!isModelAccessError) {
              req.log.error(
                { key: req.key?.hash, model: req.body?.model },
                "Disabling key due to AccessDeniedException when invoking model. If credentials are valid, check IAM permissions."
              );
              keyPool.disable(req.key!, "revoked");
            }
            errorPayload.proxy_note = `API key doesn't have access to the requested resource. Model ID: ${req.body?.model}`;
            break;
          default:
            errorPayload.proxy_note = `Received 403 error. Key may be invalid.`;
        }
        return;
      case "mistral-ai":
      case "gcp":
        keyPool.disable(req.key!, "revoked");
        errorPayload.proxy_note = `Assigned API key is invalid or revoked, please try again.`;
        return;
    }
  } else if (statusCode === 429) {
    switch (service) {
      case "openai":
        await handleOpenAIRateLimitError(req, errorPayload);
        break;
      case "anthropic":
        await handleAnthropicRateLimitError(req, errorPayload);
        break;
      case "aws":
        await handleAwsRateLimitError(req, errorPayload);
        break;
      case "gcp":
        await handleGcpRateLimitError(req, errorPayload);
        break;
      case "azure":
      case "mistral-ai":
        await handleAzureRateLimitError(req, errorPayload);
        break;
      case "google-ai":
        await handleGoogleAIRateLimitError(req, errorPayload);
        break;
      default:
        assertNever(service);
    }
  } else if (statusCode === 404) {
    // Most likely model not found
    switch (service) {
      case "openai":
        if (errorType === "model_not_found") {
          const requestedModel = req.body.model;
          const modelFamily = getOpenAIModelFamily(requestedModel);
          errorPayload.proxy_note = `The key assigned to your prompt does not support the requested model (${requestedModel}, family: ${modelFamily}).`;
          req.log.error(
            { key: req.key?.hash, model: requestedModel, modelFamily },
            "Prompt was routed to a key that does not support the requested model."
          );
        }
        break;
      case "anthropic":
      case "google-ai":
      case "mistral-ai":
      case "aws":
      case "gcp":
      case "azure":
        errorPayload.proxy_note = `The key assigned to your prompt does not support the requested model.`;
        break;
      default:
        assertNever(service);
    }
  } else if (statusCode === 503) {
    switch (service) {
      case "aws":
        if (
          errorType === "ServiceUnavailableException" &&
          errorPayload.error?.message?.match(/too many connections/i)
        ) {
          errorPayload.proxy_note = `The requested AWS Bedrock model is overloaded. Try again in a few minutes, or try another model.`;
        }
        break;
      default:
        errorPayload.proxy_note = `Upstream service unavailable. Try again later.`;
        break;
    }
  } else {
    errorPayload.proxy_note = `Unrecognized error from upstream service.`;
  }

  // Redact the OpenAI org id from the error message
  if (errorPayload.error?.message) {
    errorPayload.error.message = errorPayload.error.message.replace(
      /org-.{24}/gm,
      "org-xxxxxxxxxxxxxxxxxxx"
    );
  }

  // Send the error to the client
  sendProxyError(req, res, statusCode, statusMessage, errorPayload);

  // Re-throw the error to bubble up to onProxyRes's handler for logging
  throw new HttpError(statusCode, errorPayload.error?.message);
};

async function handleAnthropicAwsBadRequestError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const { error } = errorPayload;
  const isMissingPreamble = error?.message.startsWith(
    `prompt must start with "\n\nHuman:" turn`
  );

  // Some keys mandate a \n\nHuman: preamble, which we can add and retry
  if (isMissingPreamble) {
    req.log.warn(
      { key: req.key?.hash },
      "Request failed due to missing preamble. Key will be marked as such for subsequent requests."
    );
    keyPool.update(req.key!, { requiresPreamble: true });
    await reenqueueRequest(req);
    throw new RetryableError("Claude request re-enqueued to add preamble.");
  }

  // {"type":"error","error":{"type":"invalid_request_error","message":"Usage blocked until 2024-03-01T00:00:00+00:00 due to user specified spend limits."}}
  // {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits."}}
  const isOverQuota =
    error?.message?.match(/usage blocked until/i) ||
    error?.message?.match(/credit balance is too low/i);
  if (isOverQuota) {
    req.log.warn(
      { key: req.key?.hash, message: error?.message },
      "Anthropic key has hit spending limit and will be disabled."
    );
    keyPool.disable(req.key!, "quota");
    errorPayload.proxy_note = `Assigned key has hit its spending limit. ${error?.message}`;
    return;
  }

  const isDisabled =
    error?.message?.match(/organization has been disabled/i) ||
    error?.message?.match(/^operation not allowed/i);
  if (isDisabled) {
    req.log.warn(
      { key: req.key?.hash, message: error?.message },
      "Anthropic/AWS key has been disabled."
    );
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `Assigned key has been disabled. (${error?.message})`;
    return;
  }

  errorPayload.proxy_note = `Unrecognized error from the API. (${error?.message})`;
}

async function handleAnthropicRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  if (errorPayload.error?.type === "rate_limit_error") {
    keyPool.markRateLimited(req.key!);
    await reenqueueRequest(req);
    throw new RetryableError("Claude rate-limited request re-enqueued.");
  } else {
    errorPayload.proxy_note = `Unrecognized 429 Too Many Requests error from the API.`;
  }
}

async function handleAwsRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const errorType = errorPayload.error?.type;
  switch (errorType) {
    case "ThrottlingException":
      keyPool.markRateLimited(req.key!);
      await reenqueueRequest(req);
      throw new RetryableError("AWS rate-limited request re-enqueued.");
    case "ModelNotReadyException":
      errorPayload.proxy_note = `The requested model is overloaded. Try again in a few seconds.`;
      break;
    default:
      errorPayload.proxy_note = `Unrecognized rate limit error from AWS. (${errorType})`;
  }
}

async function handleGcpRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  if (errorPayload.error?.type === "RESOURCE_EXHAUSTED") {
    keyPool.markRateLimited(req.key!);
    await reenqueueRequest(req);
    throw new RetryableError("GCP rate-limited request re-enqueued.");
  } else {
    errorPayload.proxy_note = `Unrecognized 429 Too Many Requests error from GCP.`;
  }
}

async function handleOpenAIRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
): Promise<Record<string, any>> {
  const type = errorPayload.error?.type;
  switch (type) {
    case "insufficient_quota":
    case "invalid_request_error": // this is the billing_hard_limit_reached error seen in some cases
      // Billing quota exceeded (key is dead, disable it)
      keyPool.disable(req.key!, "quota");
      errorPayload.proxy_note = `Assigned key's quota has been exceeded. Please try again.`;
      break;
    case "access_terminated":
      // Account banned (key is dead, disable it)
      keyPool.disable(req.key!, "revoked");
      errorPayload.proxy_note = `Assigned key has been banned by OpenAI for policy violations. Please try again.`;
      break;
    case "billing_not_active":
      // Key valid but account billing is delinquent
      keyPool.disable(req.key!, "quota");
      errorPayload.proxy_note = `Assigned key has been disabled due to delinquent billing. Please try again.`;
      break;
    case "requests":
    case "tokens":
      keyPool.markRateLimited(req.key!);
      if (errorPayload.error?.message?.match(/on requests per day/)) {
        // This key has a very low rate limit, so we can't re-enqueue it.
        errorPayload.proxy_note = `Assigned key has reached its per-day request limit for this model. Try another model.`;
        break;
      }

      // Per-minute request or token rate limit is exceeded, which we can retry
      await reenqueueRequest(req);
      throw new RetryableError("Rate-limited request re-enqueued.");
    default:
      errorPayload.proxy_note = `This is likely a temporary error with the API. Try again in a few seconds.`;
      break;
  }
  return errorPayload;
}

async function handleAzureRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const code = errorPayload.error?.code;
  switch (code) {
    case "429":
      keyPool.markRateLimited(req.key!);
      await reenqueueRequest(req);
      throw new RetryableError("Rate-limited request re-enqueued.");
    default:
      errorPayload.proxy_note = `Unrecognized rate limit error from Azure (${code}). Please report this.`;
      break;
  }
}

//{"error":{"code":400,"message":"API Key not found. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com","metadata":{"service":"generativelanguage.googleapis.com"}}]}}
//{"error":{"code":400,"message":"Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.","status":"FAILED_PRECONDITION"}}
async function handleGoogleAIBadRequestError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const error = errorPayload.error || {};
  const { message, status, details } = error;

  if (status === "INVALID_ARGUMENT") {
    const reason = details?.[0]?.reason;
    if (reason === "API_KEY_INVALID") {
      req.log.warn(
        { key: req.key?.hash, status, reason, msg: error.message },
        "Received `API_KEY_INVALID` error from Google AI. Check the configured API key."
      );
      keyPool.disable(req.key!, "revoked");
      errorPayload.proxy_note = `Assigned API key is invalid.`;
    }
  } else if (status === "FAILED_PRECONDITION") {
    if (message.match(/please enable billing/i)) {
      req.log.warn(
        { key: req.key?.hash, status, msg: error.message },
        "Cannot use key due to billing restrictions."
      );
      keyPool.disable(req.key!, "revoked");
      errorPayload.proxy_note = `Assigned API key cannot be used.`;
    }
  } else {
    req.log.warn(
      { key: req.key?.hash, status, msg: error.message },
      "Received unexpected 400 error from Google AI."
    );
  }
}

//{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}
async function handleGoogleAIRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const status = errorPayload.error?.status;
  switch (status) {
    case "RESOURCE_EXHAUSTED":
      keyPool.markRateLimited(req.key!);
      await reenqueueRequest(req);
      throw new RetryableError("Rate-limited request re-enqueued.");
    default:
      errorPayload.proxy_note = `Unrecognized rate limit error from Google AI (${status}). Please report this.`;
      break;
  }
}

const incrementUsage: ProxyResHandlerWithBody = async (_proxyRes, req) => {
  if (isTextGenerationRequest(req) || isImageGenerationRequest(req)) {
    const model = req.body.model;
    const tokensUsed = req.promptTokens! + req.outputTokens!;
    req.log.debug(
      {
        model,
        tokensUsed,
        promptTokens: req.promptTokens,
        outputTokens: req.outputTokens,
      },
      `Incrementing usage for model`
    );
    keyPool.incrementUsage(req.key!, model, tokensUsed);
    if (req.user) {
      incrementPromptCount(req.user.token);
      incrementTokenCount(req.user.token, model, req.outboundApi, tokensUsed);
    }
  }
};

const countResponseTokens: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  body
) => {
  if (req.outboundApi === "openai-image") {
    req.outputTokens = req.promptTokens;
    req.promptTokens = 0;
    return;
  }

  // This function is prone to breaking if the upstream API makes even minor
  // changes to the response format, especially for SSE responses. If you're
  // seeing errors in this function, check the reassembled response body from
  // handleStreamedResponse to see if the upstream API has changed.
  try {
    assertJsonResponse(body);
    const service = req.outboundApi;
    const completion = getCompletionFromBody(req, body);
    const tokens = await countTokens({ req, completion, service });

    if (req.service === "openai" || req.service === "azure") {
      // O1 consumes (a significant amount of) invisible tokens for the chain-
      // of-thought reasoning. We have no way to count these other than to check
      // the response body.
      tokens.reasoning_tokens =
        body.usage?.completion_tokens_details?.reasoning_tokens;
    }

    req.log.debug(
      { service, prevOutputTokens: req.outputTokens, tokens },
      `Counted tokens for completion`
    );
    if (req.tokenizerInfo) {
      req.tokenizerInfo.completion_tokens = tokens;
    }

    req.outputTokens = tokens.token_count + (tokens.reasoning_tokens ?? 0);
  } catch (error) {
    req.log.warn(
      error,
      "Error while counting completion tokens; assuming `max_output_tokens`"
    );
    // req.outputTokens will already be set to `max_output_tokens` from the
    // prompt counting middleware, so we don't need to do anything here.
  }
};

const trackKeyRateLimit: ProxyResHandlerWithBody = async (proxyRes, req) => {
  keyPool.updateRateLimits(req.key!, proxyRes.headers);
};

const omittedHeaders = new Set<string>([
  // Omit content-encoding because we will always decode the response body
  "content-encoding",
  // Omit transfer-encoding because we are using response.json which will
  // set a content-length header, which is not valid for chunked responses.
  "transfer-encoding",
  // Don't set cookies from upstream APIs because proxied requests are stateless
  "set-cookie",
  "openai-organization",
  "x-request-id",
  "cf-ray",
]);
const copyHttpHeaders: ProxyResHandlerWithBody = async (
  proxyRes,
  _req,
  res
) => {
  Object.keys(proxyRes.headers).forEach((key) => {
    if (omittedHeaders.has(key)) return;
    res.setHeader(key, proxyRes.headers[key] as string);
  });
};

/**
 * Injects metadata into the response, such as the tokenizer used, logging
 * status, upstream API endpoint used, and whether the input prompt was modified
 * or transformed.
 * Only used for non-streaming requests.
 */
const injectProxyInfo: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  const { service, inboundApi, outboundApi, tokenizerInfo } = req;
  const native = inboundApi === outboundApi;
  const info: any = {
    logged: config.promptLogging,
    tokens: tokenizerInfo,
    service,
    in_api: inboundApi,
    out_api: outboundApi,
    prompt_transformed: !native,
  };

  if (req.query?.debug?.length) {
    info.final_request_body = req.signedRequest?.body || req.body;
  }

  if (typeof body === "object") {
    body.proxy = info;
  }
};

function getAwsErrorType(header: string | string[] | undefined) {
  const val = String(header).match(/^(\w+):?/)?.[1];
  return val || String(header);
}

function assertJsonResponse(body: any): asserts body is Record<string, any> {
  if (typeof body !== "object") {
    throw new Error(`Expected response to be an object, got ${typeof body}`);
  }
}
