import type { ProxyReqMutator } from "../index";

/** Finalize the rewritten request body. Must be the last mutator. */
export const finalizeBody: ProxyReqMutator = (manager) => {
  const req = manager.request;

  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    // Pure passthrough mode - don't modify the request body
    // Just set the proper Content-Length header
    const serialized =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    manager.setHeader("Content-Length", String(Buffer.byteLength(serialized)));
    manager.setBody(serialized);
  }
};
