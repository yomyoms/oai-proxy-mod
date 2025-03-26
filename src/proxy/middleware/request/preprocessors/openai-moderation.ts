import { Request } from "express";
import { config } from "../../../../config";
import { BadRequestError } from "../../../../shared/errors";

// Update to include all categories from the latest moderation API
type ModerationCategory = 
  | "sexual"
  | "sexual/minors"
  | "harassment"
  | "harassment/threatening"
  | "hate"
  | "hate/threatening"
  | "illicit"
  | "illicit/violent"
  | "self-harm"
  | "self-harm/intent"
  | "self-harm/instructions"
  | "violence"
  | "violence/graphic";

interface ModerationResponse {
  id: string;
  model: string;
  results: [{
    flagged: boolean;
    categories: {
      [K in ModerationCategory]: boolean;
    };
    category_scores: {
      [K in ModerationCategory]: number;
    };
    category_applied_input_types?: {
      [K in ModerationCategory]: string[];
    };
  }];
}

export const checkModeration = async (req: Request, prompt: string) => {
  // Only proceed if moderation is enabled and key exists
  if (!config.allowOpenAIModeration || !config.openaiModerationKey) return;

  const response = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiModerationKey}`
    },
    body: JSON.stringify({
      // Use the latest moderation model
      model: config.openaiModerationModel || "omni-moderation-latest",
      input: prompt
    })
  });

  if (!response.ok) {
    req.log.error(
      {
        status: response.status,
        statusText: response.statusText,
        key: config.openaiModerationKey?.slice(-4)
      },
      "Invalid or revoked OpenAI moderation key"
    );
    return;
  }

  if (response.ok) {
    const data = await response.json() as ModerationResponse;
    const result = data.results[0];

    // Check if the content is flagged by the API
    if (result.flagged) {
      // Find which specific categories violated the thresholds
      const violations = Object.entries(result.category_scores)
        .filter((entry): entry is [ModerationCategory, number] => {
          const category = entry[0] as ModerationCategory;
          const score = entry[1];
          // Only check categories that are in our config thresholds
          return category in config.moderationThresholds &&
                score > config.moderationThresholds[category];
        })
        .map(([category]) => category);

      if (violations.length > 0) {
        const ip = req.ip;
        req.log.warn(
          {
            ip,
            violations,
            categoryScores: result.category_scores,
            // Log the input types that were flagged if available
            categoryAppliedInputTypes: result.category_applied_input_types
          },
          "Content flagged by OpenAI moderation"
        );

        throw new BadRequestError(`Content violates /AICG/ guidelines. Flagged categories: ${violations.join(", ")}`);
      }
    }
  }
};
