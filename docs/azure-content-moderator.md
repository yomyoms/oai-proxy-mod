# Using Azure Content Moderator

This proxy supports Azure Content Moderator API for content filtering in addition to OpenAI's moderation API. This document explains how to set it up and use it.

## What is Azure Content Moderator?

Azure Content Moderator is a cloud-based service by Microsoft Azure that provides text and image moderation using machine learning. It can:

- Scan text for potentially offensive, inappropriate, or unwanted content
- Detect personally identifiable information (PII) such as email addresses, phone numbers, and more
- Identify profanity or adult content

## Setting Up Azure Content Moderator

1. Sign up for an Azure account if you don't already have one
2. Create a Content Moderator resource in the Azure portal
3. Once created, get your API key and endpoint from the resource's "Keys and Endpoint" section

## Configuration

Add the following environment variables to your `.env` file:

```
# Set to true to use Azure Content Moderator instead of OpenAI's moderation
USE_AZURE_CONTENT_MODERATOR=true

# Your Azure Content Moderator API key
AZURE_CONTENT_MODERATOR_KEY=your-api-key-here

# Your Azure Content Moderator endpoint (using either format below)
AZURE_CONTENT_MODERATOR_ENDPOINT=https://your-resource-name.cognitiveservices.azure.com
# OR use the direct endpoint format:
AZURE_CONTENT_MODERATOR_ENDPOINT=https://northeurope.api.cognitive.microsoft.com/contentmoderator/moderate/v1.0/ProcessText/Screen

# Language for moderation (default: eng)
AZURE_CONTENT_MODERATOR_LANGUAGE=eng
```

### Endpoint Configuration Options

You can configure the endpoint in two ways:

1. **Base URL Format**: Just provide the base URL (e.g., `https://your-resource-name.cognitiveservices.azure.com`). The SDK will automatically construct the full API path.

2. **Direct Endpoint Format**: If you prefer to use the direct REST API endpoint, you can provide the full path including `/contentmoderator/moderate/v1.0/ProcessText/Screen`. The system will detect this format and use a direct fetch call instead of the SDK.

Example of direct endpoint format:
```
AZURE_CONTENT_MODERATOR_ENDPOINT=https://northeurope.api.cognitive.microsoft.com/contentmoderator/moderate/v1.0/ProcessText/Screen
```

## How It Works

When a user sends a prompt, the proxy will:

1. Check if Azure Content Moderator is enabled
2. If enabled, send the text to Azure for screening
3. If violations are detected, reject the request and log the violation
4. If no violations are detected, continue processing the request

The Azure Content Moderator will screen text for:

- Classification issues (reviewRecommended)
- Profanity
- Personal identifiable information (PII)

## Comparison with OpenAI Moderation

Azure Content Moderator provides somewhat different capabilities compared to OpenAI's moderation API:

- More detailed PII detection (emails, phone numbers, addresses, etc.)
- Profanity detection
- Different classification categories

To continue using OpenAI moderation instead, ensure `USE_AZURE_CONTENT_MODERATOR` is set to `false` and configure OpenAI moderation as documented.

## Pricing

Azure Content Moderator is a paid service with pricing based on the number of API calls. Check the [Azure pricing page](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/content-moderator/) for current rates. There is a free tier available for development and testing purposes. 