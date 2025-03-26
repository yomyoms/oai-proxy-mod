/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and Firebase Realtime
 * Database persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import admin from "firebase-admin";
import schedule from "node-schedule";
import { v4 as uuid } from "uuid";
import { config } from "../../config";
import { logger } from "../../logger";
import { getFirebaseApp } from "../firebase";
import { APIFormat } from "../key-management";
import {
  getAwsBedrockModelFamily,
  getGcpModelFamily,
  getAzureOpenAIModelFamily,
  getClaudeModelFamily,
  getGoogleAIModelFamily,
  getMistralAIModelFamily,
  getOpenAIModelFamily,
  MODEL_FAMILIES,
  ModelFamily,
} from "../models";
import { assertNever } from "../utils";
import { User, UserTokenCounts, UserUpdate } from "./schema";

const log = logger.child({ module: "users" });

const INITIAL_TOKENS: Required<UserTokenCounts> = MODEL_FAMILIES.reduce(
  (acc, family) => ({ ...acc, [family]: 0 }),
  {} as Record<ModelFamily, number>
);

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();
let quotaRefreshJob: schedule.Job | null = null;
let userCleanupJob: schedule.Job | null = null;

export async function init() {
  log.info({ store: config.gatekeeperStore }, "Initializing user store...");
  if (config.gatekeeperStore === "firebase_rtdb") {
    await initFirebase();
  }
  if (config.quotaRefreshPeriod) {
    const crontab = getRefreshCrontab();
    quotaRefreshJob = schedule.scheduleJob(crontab, refreshAllQuotas);
    if (!quotaRefreshJob) {
      throw new Error(
        "Unable to schedule quota refresh. Is QUOTA_REFRESH_PERIOD set correctly?"
      );
    }
    log.debug(
      { nextRefresh: quotaRefreshJob.nextInvocation() },
      "Scheduled token quota refresh."
    );
  }

  userCleanupJob = schedule.scheduleJob("* * * * *", cleanupExpiredTokens);

  log.info("User store initialized.");
}

/**
 * Creates a new user and returns their token. Optionally accepts parameters
 * for setting an expiry date and/or token limits for temporary users.
 **/
export function createUser(createOptions?: {
  type?: User["type"];
  expiresAt?: number;
  tokenLimits?: User["tokenLimits"];
  tokenRefresh?: User["tokenRefresh"];
}) {
  const token = uuid();
  const newUser: User = {
    token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { ...INITIAL_TOKENS },
    tokenLimits: createOptions?.tokenLimits ?? { ...config.tokenQuota },
    tokenRefresh: createOptions?.tokenRefresh ?? { ...INITIAL_TOKENS },
    createdAt: Date.now(),
    meta: {},
  };

  if (createOptions?.type === "temporary") {
    Object.assign(newUser, {
      type: "temporary",
      expiresAt: createOptions.expiresAt,
    });
  } else {
    Object.assign(newUser, { type: createOptions?.type ?? "normal" });
  }

  users.set(token, newUser);
  usersToFlush.add(token);
  return token;
}

/** Returns the user with the given token if they exist. */
export function getUser(token: string) {
  return users.get(token);
}

/** Returns a list of all users. */
export function getUsers() {
  return Array.from(users.values()).map((user) => ({ ...user }));
}

/**
 * Upserts the given user. Intended for use with the /admin API for updating
 * arbitrary fields on a user; use the other functions in this module for
 * specific use cases. `undefined` values are left unchanged. `null` will delete
 * the property from the user.
 *
 * Returns the upserted user.
 */
export function upsertUser(user: UserUpdate) {
  const existing: User = users.get(user.token) ?? {
    token: user.token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { ...INITIAL_TOKENS },
    tokenLimits: { ...config.tokenQuota },
    tokenRefresh: { ...INITIAL_TOKENS },
    createdAt: Date.now(),
    meta: {},
  };

  const updates: Partial<User> = {};

  for (const field of Object.entries(user)) {
    const [key, value] = field as [keyof User, any]; // already validated by zod
    if (value === undefined || key === "token") continue;
    if (value === null) {
      delete existing[key];
    } else {
      updates[key] = value;
    }
  }

  if (updates.tokenCounts) {
    for (const family of MODEL_FAMILIES) {
      updates.tokenCounts[family] ??= 0;
    }
  }
  if (updates.tokenLimits) {
    for (const family of MODEL_FAMILIES) {
      updates.tokenLimits[family] ??= 0;
    }
  }
  // tokenRefresh is a special case where we want to merge the existing and
  // updated values for each model family, ignoring falsy values.
  if (updates.tokenRefresh) {
    const merged = { ...existing.tokenRefresh };
    for (const family of MODEL_FAMILIES) {
      merged[family] =
        updates.tokenRefresh[family] || existing.tokenRefresh[family];
    }
    updates.tokenRefresh = merged;
  }

  users.set(user.token, Object.assign(existing, updates));
  usersToFlush.add(user.token);

  // Immediately schedule a flush to the database if we're using Firebase.
  if (config.gatekeeperStore === "firebase_rtdb") {
    setImmediate(flushUsers);
  }

  return users.get(user.token);
}

/** Increments the prompt count for the given user. */
export function incrementPromptCount(token: string) {
  const user = users.get(token);
  if (!user) return;
  user.promptCount++;
  usersToFlush.add(token);
}

/** Increments token consumption for the given user and model. */
export function incrementTokenCount(
  token: string,
  model: string,
  api: APIFormat,
  consumption: number
) {
  const user = users.get(token);
  if (!user) return;
  const modelFamily = getModelFamilyForQuotaUsage(model, api);
  const existing = user.tokenCounts[modelFamily] ?? 0;
  user.tokenCounts[modelFamily] = existing + consumption;
  usersToFlush.add(token);
}

/**
 * Given a user's token and IP address, authenticates the user and adds the IP
 * to the user's list of IPs. Returns the user if they exist and are not
 * disabled, otherwise returns undefined.
 */
export function authenticate(
  token: string,
  ip: string
): { user?: User; result: "success" | "disabled" | "not_found" | "limited" } {
  const user = users.get(token);
  if (!user) return { result: "not_found" };
  if (user.disabledAt) return { result: "disabled" };

  const newIp = !user.ip.includes(ip);

  const userLimit = user.maxIps ?? config.maxIpsPerUser;
  const enforcedLimit =
    user.type === "special" || !userLimit ? Infinity : userLimit;

  if (newIp && user.ip.length >= enforcedLimit) {
    if (config.maxIpsAutoBan) {
      user.ip.push(ip);
      disableUser(token, "IP address limit exceeded.");
      return { result: "disabled" };
    }
    return { result: "limited" };
  } else if (newIp) {
    user.ip.push(ip);
  }

  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return { user, result: "success" };
}

export function hasAvailableQuota({
  userToken,
  model,
  api,
  requested,
}: {
  userToken: string;
  model: string;
  api: APIFormat;
  requested: number;
}) {
  const user = users.get(userToken);
  if (!user) return false;
  if (user.type === "special") return true;

  const modelFamily = getModelFamilyForQuotaUsage(model, api);
  const { tokenCounts, tokenLimits } = user;
  const tokenLimit = tokenLimits[modelFamily];

  if (!tokenLimit) return true;

  const tokensConsumed = (tokenCounts[modelFamily] ?? 0) + requested;
  return tokensConsumed < tokenLimit;
}

/**
 * For the given user, sets token limits for each model family to the sum of the
 * current count and the refresh amount, up to the default limit. If a quota is
 * not specified for a model family, it is not touched.
 */
export function refreshQuota(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenQuota } = config;
  const { tokenCounts, tokenLimits, tokenRefresh } = user;

  // Get default quotas for each model family.
  const defaultQuotas = Object.entries(tokenQuota) as [ModelFamily, number][];
  // If any user-specific refresh quotas are present, override default quotas.
  const userQuotas = defaultQuotas.map(
    ([f, q]) => [f, (tokenRefresh[f] ?? 0) || q] as const /* narrow to tuple */
  );

  userQuotas
    // Ignore families with no global or user-specific refresh quota.
    .filter(([, q]) => q > 0)
    // Increase family token limit by the family's refresh amount.
    .forEach(([f, q]) => (tokenLimits[f] = (tokenCounts[f] ?? 0) + q));
  usersToFlush.add(token);
}

export function resetUsage(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenCounts } = user;
  const counts = Object.entries(tokenCounts) as [ModelFamily, number][];
  counts.forEach(([model]) => (tokenCounts[model] = 0));
  usersToFlush.add(token);
}

/** Disables the given user, optionally providing a reason. */
export function disableUser(token: string, reason?: string) {
  const user = users.get(token);
  if (!user) return;
  user.disabledAt = Date.now();
  user.disabledReason = reason;
  if (!user.meta) {
    user.meta = {};
  }
  // manually banned tokens cannot be refreshed
  user.meta.refreshable = false;
  usersToFlush.add(token);
}

export function getNextQuotaRefresh() {
  if (!quotaRefreshJob) return "never (manual refresh only)";
  return quotaRefreshJob.nextInvocation().getTime();
}

/**
 * Cleans up expired temporary tokens by disabling tokens past their access
 * expiry date and permanently deleting tokens three days after their access
 * expiry date.
 */
function cleanupExpiredTokens() {
  const now = Date.now();
  let disabled = 0;
  let deleted = 0;
  for (const user of users.values()) {
    if (user.type !== "temporary") continue;
    if (user.expiresAt && user.expiresAt < now && !user.disabledAt) {
      disableUser(user.token, "Temporary token expired.");
      if (!user.meta) {
        user.meta = {};
      }
      user.meta.refreshable = config.captchaMode !== "none";
      disabled++;
    }
    const purgeTimeout = config.powTokenPurgeHours * 60 * 60 * 1000;
    if (user.disabledAt && user.disabledAt + purgeTimeout < now) {
      users.delete(user.token);
      usersToFlush.add(user.token);
      deleted++;
    }
  }
  log.trace({ disabled, deleted }, "Expired tokens cleaned up.");
}

function refreshAllQuotas() {
  let count = 0;
  for (const user of users.values()) {
    if (user.type === "temporary") continue;
    refreshQuota(user.token);
    count++;
  }
  log.info(
    { refreshed: count, nextRefresh: quotaRefreshJob!.nextInvocation() },
    "Token quotas refreshed."
  );
}

// TODO: Firebase persistence is pretend right now and just polls the in-memory
// store to sync it with Firebase when it changes. Will refactor to abstract
// persistence layer later so we can support multiple stores.
let firebaseTimeout: NodeJS.Timeout | undefined;
const USERS_REF = process.env.FIREBASE_USERS_REF_NAME ?? "users";

async function initFirebase() {
  log.info("Connecting to Firebase...");
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref(USERS_REF);
  const snapshot = await usersRef.once("value");
  const users: Record<string, User> | null = snapshot.val();
  firebaseTimeout = setInterval(flushUsers, 20 * 1000);
  if (!users) {
    log.info("No users found in Firebase.");
    return;
  }
  for (const token in users) {
    upsertUser(users[token]);
  }
  usersToFlush.clear();
  const numUsers = Object.keys(users).length;
  log.info({ users: numUsers }, "Loaded users from Firebase");
}

async function flushUsers() {
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref(USERS_REF);
  const updates: Record<string, User> = {};
  const deletions = [];

  for (const token of usersToFlush) {
    const user = users.get(token);
    if (!user) {
      deletions.push(token);
      continue;
    }
    updates[token] = user;
  }

  usersToFlush.clear();

  const numUpdates = Object.keys(updates).length + deletions.length;
  if (numUpdates === 0) {
    return;
  }

  await usersRef.update(updates);
  await Promise.all(deletions.map((token) => usersRef.child(token).remove()));
  log.info(
    { users: Object.keys(updates).length, deletions: deletions.length },
    "Flushed changes to Firebase"
  );
}

function getModelFamilyForQuotaUsage(
  model: string,
  api: APIFormat
): ModelFamily {
  // "azure" here is added to model names by the Azure key provider to
  // differentiate between Azure and OpenAI variants of the same model.
  if (model.includes("azure")) return getAzureOpenAIModelFamily(model);
  if (model.includes("anthropic.")) return getAwsBedrockModelFamily(model);
  if (model.startsWith("claude-") && model.includes("@"))
    return getGcpModelFamily(model);

  switch (api) {
    case "openai":
    case "openai-text":
    case "openai-image":
      return getOpenAIModelFamily(model);
    case "anthropic-chat":
    case "anthropic-text":
      return getClaudeModelFamily(model);
    case "google-ai":
      return getGoogleAIModelFamily(model);
    case "mistral-ai":
    case "mistral-text":
      return getMistralAIModelFamily(model);
    default:
      assertNever(api);
  }
}

function getRefreshCrontab() {
  switch (config.quotaRefreshPeriod!) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return "0 0 * * *";
    default:
      return config.quotaRefreshPeriod ?? "0 0 * * *";
  }
}
