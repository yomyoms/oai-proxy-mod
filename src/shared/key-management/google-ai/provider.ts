import crypto from "crypto";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { PaymentRequiredError } from "../../errors";
import { getGoogleAIModelFamily, type GoogleAIModelFamily } from "../../models";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { prioritizeKeys } from "../prioritize-keys";
import { GoogleAIKeyChecker } from "./checker";

// Note that Google AI is not the same as Vertex AI, both are provided by
// Google but Vertex is the GCP product for enterprise, while Google API is a
// development/hobbyist product. They use completely different APIs and keys.
// https://ai.google.dev/docs/migrate_to_cloud

export type GoogleAIKeyUpdate = Omit<
  Partial<GoogleAIKey>,
  | "key"
  | "hash"
  | "lastUsed"
  | "promptCount"
  | "rateLimitedAt"
  | "rateLimitedUntil"
>;

type GoogleAIKeyUsage = {
  [K in GoogleAIModelFamily as `${K}Tokens`]: number;
};

export interface GoogleAIKey extends Key, GoogleAIKeyUsage {
  readonly service: "google-ai";
  readonly modelFamilies: GoogleAIModelFamily[];
  /** All detected model IDs on this key. */
  modelIds: string[];
}

/**
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 2000;
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 500;

export class GoogleAIKeyProvider implements KeyProvider<GoogleAIKey> {
  readonly service = "google-ai";

  private keys: GoogleAIKey[] = [];
  private checker?: GoogleAIKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.googleAIKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "GOOGLE_AI_KEY is not set. Google AI API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: GoogleAIKey = {
        key,
        service: this.service,
        modelFamilies: ["gemini-pro"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `plm-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        "gemini-flashTokens": 0,
        "gemini-proTokens": 0,
        "gemini-ultraTokens": 0,
        modelIds: [],
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Google AI keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new GoogleAIKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(model: string) {
    const neededFamily = getGoogleAIModelFamily(model);
    const availableKeys = this.keys.filter(
      (k) => !k.isDisabled && k.modelFamilies.includes(neededFamily)
    );
    if (availableKeys.length === 0) {
      throw new PaymentRequiredError("No Google AI keys available");
    }

    const keysByPriority = prioritizeKeys(availableKeys);

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = Date.now();
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public disable(key: GoogleAIKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<GoogleAIKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(hash: string, model: string, tokens: number) {
    const key = this.keys.find((k) => k.hash === hash);
    if (!key) return;
    key.promptCount++;
    key[`${getGoogleAIModelFamily(model)}Tokens`] += tokens;
  }

  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);

  /**
   * This is called when we receive a 429, which means there are already five
   * concurrent requests running on this key. We don't have any information on
   * when these requests will resolve, so all we can do is wait a bit and try
   * again. We will lock the key for 2 seconds after getting a 429 before
   * retrying in order to give the other requests a chance to finish.
   */
  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + RATE_LIMIT_LOCKOUT;
  }

  public recheck() {}

  /**
   * Applies a short artificial delay to the key upon dequeueing, in order to
   * prevent it from being immediately assigned to another request before the
   * current one can be dispatched.
   **/
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }
}
