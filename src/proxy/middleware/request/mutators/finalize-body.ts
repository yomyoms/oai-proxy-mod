import type { ProxyReqMutator } from "../index";

/** Finalize the rewritten request body. Must be the last mutator. */
export const finalizeBody: ProxyReqMutator = (manager) => {
  const req = manager.request;

  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    // For image generation requests, remove stream flag.
    if (req.outboundApi === "openai-image") {
      delete req.body.stream;
    }
    // For anthropic text to chat requests, remove undefined prompt.
    if (req.outboundApi === "anthropic-chat") {
      delete req.body.prompt;
      
      // Make sure thinking parameter is preserved if present
      const thinkingParam = req.body.thinking;
      if (thinkingParam) {
        // Ensure it's properly structured according to the API
        if (typeof thinkingParam === 'object' && 
            thinkingParam.type === 'enabled' && 
            typeof thinkingParam.budget_tokens === 'number') {
          // It's already correctly structured, keep it
          
          // Per Anthropic docs: max_tokens must be greater than thinking.budget_tokens
          // If max_tokens is less than or equal to budget_tokens, adjust it
          if (req.body.max_tokens <= thinkingParam.budget_tokens) {
            // Make max_tokens 1000 tokens more than budget_tokens to ensure it works
            req.body.max_tokens = thinkingParam.budget_tokens + 1000;
          }
        } else if (typeof thinkingParam === 'object') {
          // Fix structure if possible
          const budgetTokens = thinkingParam.budget_tokens || 16000;
          req.body.thinking = {
            type: 'enabled',
            budget_tokens: budgetTokens
          };
          
          // Ensure max_tokens is greater than budget_tokens
          if (req.body.max_tokens <= budgetTokens) {
            req.body.max_tokens = budgetTokens + 1000;
          }
        }
      }
    }

    const serialized =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    manager.setHeader("Content-Length", String(Buffer.byteLength(serialized)));
    manager.setBody(serialized);
  }
};
