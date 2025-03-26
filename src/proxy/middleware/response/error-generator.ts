import express from "express";
import { APIFormat } from "../../../shared/key-management";
import { assertNever } from "../../../shared/utils";
import { initializeSseStream } from "../../../shared/streaming";
import http from "http";

/**
 * Returns an error message in OpenAI style format:
 * {"error": {"message": "<description of the error>", "type": "<error_type>"}}
 * 
 * Example:
 * ```
 * {
 *   "error": {
 *     "message": "The requested Claude model might not exist, or the key might not be provisioned for it.",
 *     "type": "invalid_request_error"
 *   }
 * }
 * ```
 */
function getMessageContent(params: {
  title: string;
  message: string;
  obj?: Record<string, any>;
}) {
  const { title, message, obj } = params;
  const note = obj?.proxy_note || obj?.error?.message || "";
  const description = note ? `${message}. ${note}` : message;
  
  // Extract error type from title or use a default
  let errorType = "server_error";
  if (title) {
    errorType = title.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z_]/g, "");
    // If we have HTTP code in the title, try to create a more descriptive type
    const match = title.match(/HTTP (\d+)/);
    if (match) {
      const code = parseInt(match[1], 10);
      if (code === 404) errorType = "not_found_error";
      else if (code === 401) errorType = "authentication_error";
      else if (code === 403) errorType = "permission_error";
      else if (code === 429) errorType = "rate_limit_error";
      else if (code >= 400 && code < 500) errorType = "invalid_request_error";
      else errorType = "server_error";
    }
  }
  
  return JSON.stringify({
    error: {
      message: description,
      type: errorType
    }
  });
}

type ErrorGeneratorOptions = {
  format: APIFormat | "unknown";
  title: string;
  message: string;
  obj?: Record<string, any>;
  reqId: string | number | object;
  model?: string;
  statusCode?: number;
};

/**
 * Very crude inference of the request format based on the request body. Don't
 * rely on this to be very accurate.
 */
function tryInferFormat(body: any): APIFormat | "unknown" {
  if (typeof body !== "object" || !body.model) {
    return "unknown";
  }

  if (body.model.includes("gpt")) {
    return "openai";
  }

  if (body.model.includes("mistral")) {
    return "mistral-ai";
  }

  if (body.model.includes("claude")) {
    return body.messages?.length ? "anthropic-chat" : "anthropic-text";
  }

  if (body.model.includes("gemini")) {
    return "google-ai";
  }

  return "unknown";
}

/**
 * Redacts the hostname from the error message if it contains a DNS resolution
 * error. This is to avoid leaking upstream hostnames on DNS resolution errors,
 * as those may contain sensitive information about the proxy's configuration.
 */
function redactHostname(options: ErrorGeneratorOptions): ErrorGeneratorOptions {
  if (!options.message.includes("getaddrinfo")) return options;

  const redacted = { ...options };
  redacted.message = "Could not resolve hostname";

  if (typeof redacted.obj?.error === "object") {
    redacted.obj = {
      ...redacted.obj,
      error: { message: "Could not resolve hostname" },
    };
  }

  return redacted;
}

/**
 * Generates an appropriately-formatted error response and sends it to the
 * client over their requested transport (blocking or SSE stream).
 */
export function sendErrorToClient(params: {
  options: ErrorGeneratorOptions;
  req: express.Request;
  res: express.Response;
}) {
  const { req, res } = params;
  const options = redactHostname(params.options);
  const { statusCode, message, title, obj } = options;
  const description = obj?.proxy_note || obj?.error?.message || message;

  let code = statusCode;
  if (!code && title) {
    const match = title.match(/HTTP (\d+)/);
    if (match) {
      code = parseInt(match[1], 10);
    }
  }
  code = code || 500; // Default to 500 if no status code found

  // Cannot modify headers if client opted into streaming and made it into the
  // proxy request queue, because that immediately starts an SSE stream.
  if (!res.headersSent) {
    res.setHeader("x-oai-proxy-error", title);
    res.setHeader("x-oai-proxy-error-status", code);
  }

  // Extract error type based on status code
  let errorType = "server_error";
  if (code === 404) errorType = "not_found_error";
  else if (code === 401) errorType = "authentication_error";
  else if (code === 403) errorType = "permission_error";
  else if (code === 429) errorType = "rate_limit_error";
  else if (code >= 400 && code < 500) errorType = "invalid_request_error";

  // Create the OpenAI-style error response
  const errorResponse = {
    error: {
      message: description,
      type: errorType
    }
  };

  // Format the error response according to the API format while maintaining proper status code
  const isStreaming = req.isStreaming || String(req.body.stream) === "true";
  if (isStreaming) {
    // For streaming responses, we need to send the error in SSE format
    // but still set the appropriate status code if headers haven't been sent
    if (!res.headersSent) {
      res.status(code);
      initializeSseStream(res);
    }
    // Send error in SSE format
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    // For non-streaming responses, send the error as JSON
    res.status(code).json(errorResponse);
  }
}

/**
 * Returns a non-streaming completion object that looks like it came from the
 * service that the request is being proxied to. Used to send error messages to
 * the client and have them look like normal responses, for clients with poor
 * error handling.
 */
export function buildSpoofedCompletion({
  message,
  obj,
  statusCode = 500,
}: Partial<ErrorGeneratorOptions>) {
  const description = obj?.proxy_note || obj?.error?.message || message;
  
  // Extract error type based on status code
  let errorType = "server_error";
  if (statusCode === 404) errorType = "not_found_error";
  else if (statusCode === 401) errorType = "authentication_error";
  else if (statusCode === 403) errorType = "permission_error";
  else if (statusCode === 429) errorType = "rate_limit_error";
  else if (statusCode >= 400 && statusCode < 500) errorType = "invalid_request_error";
  
  // Return OpenAI-style error format
  return {
    error: {
      message: description,
      type: errorType
    }
  };
}

/**
 * Returns an SSE message that looks like a completion event for the service
 * that the request is being proxied to. Used to send error messages to the
 * client in the middle of a streaming request.
 */
export function buildSpoofedSSE({
  message,
  obj,
  statusCode = 500,
}: Partial<ErrorGeneratorOptions>) {
  const description = obj?.proxy_note || obj?.error?.message || message;
  
  // Extract error type based on status code
  let errorType = "server_error";
  if (statusCode === 404) errorType = "not_found_error";
  else if (statusCode === 401) errorType = "authentication_error";
  else if (statusCode === 403) errorType = "permission_error";
  else if (statusCode === 429) errorType = "rate_limit_error";
  else if (statusCode >= 400 && statusCode < 500) errorType = "invalid_request_error";
  
  // OpenAI-style error format
  const event = {
    error: {
      message: description,
      type: errorType
    }
  };

  return `data: ${JSON.stringify(event)}\n\n`;
}
