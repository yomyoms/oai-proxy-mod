import { Request } from "express";
import { config } from "../../../../config";
import { BadRequestError } from "../../../../shared/errors";
import { ContentModeratorClient } from "@azure/cognitiveservices-contentmoderator";
import { ApiKeyCredentials } from "@azure/ms-rest-js";

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

// Azure Content Moderator types
type AzureModerationCategory =
  | "Sexual"
  | "Profanity"
  | "PersonalInfo"
  | "Classification";

interface AzureModerationViolation {
  category: AzureModerationCategory;
  score?: number;
}

export const checkModeration = async (req: Request, prompt: string) => {
  // Check if we should use Azure content moderator
  if (config.useAzureContentModerator && config.azureContentModeratorKey && config.azureContentModeratorEndpoint) {
    return checkAzureModeration(req, prompt);
  }

  // Otherwise use OpenAI moderation if enabled
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

// Implementation of Azure Content Moderator
const checkAzureModeration = async (req: Request, prompt: string) => {
  try {
    // If using the direct API endpoint format provided by the user
    if (config.azureContentModeratorEndpoint && config.azureContentModeratorEndpoint.includes('/contentmoderator/moderate/v1.0')) {
      // Use the direct endpoint format
      const apiUrl = config.azureContentModeratorEndpoint.endsWith('/ProcessText/Screen') 
        ? config.azureContentModeratorEndpoint 
        : `${config.azureContentModeratorEndpoint}/ProcessText/Screen`;
      
      // Use direct fetch call to the specified endpoint
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Ocp-Apim-Subscription-Key': config.azureContentModeratorKey || '',
          'Content-Length': Buffer.from(prompt).length.toString(),
          'Language': config.azureContentModeratorLanguage || 'eng'
        },
        body: prompt
      });

      if (!response.ok) {
        req.log.error(
          {
            status: response.status,
            statusText: response.statusText,
            key: config.azureContentModeratorKey?.slice(-4)
          },
          "Error using Azure Content Moderator API"
        );
        return;
      }

      const data = await response.json();
      
      // Process response from the direct API call
      const violations: AzureModerationViolation[] = [];
      
      // Check classification scores
      if (data.Classification && data.Classification.ReviewRecommended === true) {
        violations.push({ 
          category: "Classification",
          score: Math.max(
            data.Classification.Category1?.Score || 0,
            data.Classification.Category2?.Score || 0,
            data.Classification.Category3?.Score || 0
          )
        });
      }
      
      // Check for detected profanity
      if (data.Terms && data.Terms.length > 0) {
        violations.push({ 
          category: "Profanity"
        });
      }
      
      // Check for PII detection
      if (data.PII) {
        const hasPersonalInfo = 
          (data.PII.Email && data.PII.Email.length > 0) ||
          (data.PII.IPA && data.PII.IPA.length > 0) ||
          (data.PII.Phone && data.PII.Phone.length > 0) ||
          (data.PII.Address && data.PII.Address.length > 0) ||
          (data.PII.SSN && data.PII.SSN.length > 0);
          
        if (hasPersonalInfo) {
          violations.push({ 
            category: "PersonalInfo"
          });
        }
      }
      
      if (violations.length > 0) {
        const ip = req.ip;
        req.log.warn(
          {
            ip,
            violations,
            moderationResults: data
          },
          "Content flagged by Azure Content Moderator (direct API)"
        );

        throw new BadRequestError(`Content violates /AICG/ guidelines. Flagged categories: ${violations.map(v => v.category).join(", ")}`);
      }
      
      return;
    }
    
    // Otherwise use the SDK approach
    const credentials = new ApiKeyCredentials({
      inHeader: {
        "Ocp-Apim-Subscription-Key": config.azureContentModeratorKey
      }
    });

    const endpoint = config.azureContentModeratorEndpoint || "";
    const client = new ContentModeratorClient(credentials, endpoint);

    // Check for profanity and explicit content
    const textScreenResults = await client.textModeration.screenText(
      "text/plain",
      Buffer.from(prompt).toString(),
      {
        language: config.azureContentModeratorLanguage || "eng",
        autocorrect: true,
        pII: true,
        classify: true
      }
    );
    
    const violations: AzureModerationViolation[] = [];
    
    // Check classification scores against thresholds
    if (textScreenResults.classification?.reviewRecommended === true) {
      violations.push({ 
        category: "Classification",
        score: Math.max(
          textScreenResults.classification.category1?.score || 0,
          textScreenResults.classification.category2?.score || 0,
          textScreenResults.classification.category3?.score || 0
        )
      });
    }
    
    // Check for detected profanity
    if (textScreenResults.terms && textScreenResults.terms.length > 0) {
      violations.push({ 
        category: "Profanity"
      });
    }
    
    // Check for PII detection
    if (textScreenResults.pII) {
      const hasEmail = textScreenResults.pII.email && textScreenResults.pII.email.length > 0;
      const hasIPA = textScreenResults.pII.iPA && textScreenResults.pII.iPA.length > 0;
      const hasPhone = textScreenResults.pII.phone && textScreenResults.pII.phone.length > 0;
      const hasAddress = textScreenResults.pII.address && textScreenResults.pII.address.length > 0;
      const hasSSN = textScreenResults.pII.sSN && textScreenResults.pII.sSN.length > 0;
      
      if (hasEmail || hasIPA || hasPhone || hasAddress || hasSSN) {
        violations.push({ 
          category: "PersonalInfo"
        });
      }
    }
    
    if (violations.length > 0) {
      const ip = req.ip;
      req.log.warn(
        {
          ip,
          violations,
          moderationResults: textScreenResults
        },
        "Content flagged by Azure Content Moderator"
      );

      throw new BadRequestError(`Content violates /AICG/ guidelines. Flagged categories: ${violations.map(v => v.category).join(", ")}`);
    }
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw error;
    }
    
    req.log.error(
      {
        error,
        key: config.azureContentModeratorKey?.slice(-4)
      },
      "Error using Azure Content Moderator"
    );
  }
};
