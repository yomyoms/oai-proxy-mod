import { AxiosError } from "axios";
import { GoogleAIModelFamily, getGoogleAIModelFamily } from "../../models";
import { getAxiosInstance } from "../../network";
import { KeyCheckerBase } from "../key-checker-base";
import type { GoogleAIKey, GoogleAIKeyProvider } from "./provider";

const axios = getAxiosInstance();

const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 3 * 60 * 60 * 1000; // 3 hours
const LIST_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

type ListModelsResponse = {
  models: {
    name: string;
    baseModelId: string;
    version: string;
    displayName: string;
    description: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
    supportedGenerationMethods: string[];
    temperature: number;
    maxTemperature: number;
    topP: number;
    topK: number;
  }[];
  nextPageToken: string;
};

type UpdateFn = typeof GoogleAIKeyProvider.prototype.update;

export class GoogleAIKeyChecker extends KeyCheckerBase<GoogleAIKey> {
  constructor(keys: GoogleAIKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "google-ai",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      recurringChecksEnabled: false,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: GoogleAIKey) {
    const provisionedModels = await this.getProvisionedModels(key);
    const updates = {
      modelFamilies: provisionedModels,
    };
    this.updateKey(key.hash, updates);
    this.log.info(
      { key: key.hash, models: key.modelFamilies, ids: key.modelIds.length },
      "Checked key."
    );
  }

  private async getProvisionedModels(
    key: GoogleAIKey
  ): Promise<GoogleAIModelFamily[]> {
    const { data } = await axios.get<ListModelsResponse>(
      `${LIST_MODELS_URL}?pageSize=1000&key=${key.key}`
    );
    const models = data.models;

    const ids = new Set<string>();
    const families = new Set<GoogleAIModelFamily>();
    models.forEach(({ name }) => {
      families.add(getGoogleAIModelFamily(name));
      ids.add(name);
    });

    const familiesArray = Array.from(families);
    this.updateKey(key.hash, {
      modelFamilies: familiesArray,
      modelIds: Array.from(ids),
    });

    return familiesArray;
  }

  protected handleAxiosError(key: GoogleAIKey, error: AxiosError): void {
    if (error.response && GoogleAIKeyChecker.errorIsGoogleAIError(error)) {
      const httpStatus = error.response.status;
      const { code, message, status, details } = error.response.data.error;

      switch (httpStatus) {
        case 400:
          const reason = details?.[0]?.reason;
          if (status === "INVALID_ARGUMENT" && reason === "API_KEY_INVALID") {
            this.log.warn(
              { key: key.hash, reason, details },
              "Key check returned API_KEY_INVALID error. Disabling key."
            );
            this.updateKey(key.hash, { isDisabled: true, isRevoked: true });
            return;
          } else if (
            status === "FAILED_PRECONDITION" &&
            message.match(/please enable billing/i)
          ) {
            this.log.warn(
              { key: key.hash, message, details },
              "Key check returned billing disabled error. Disabling key."
            );
            this.updateKey(key.hash, { isDisabled: true, isRevoked: true });
            return;
          }
          break;
        case 401:
        case 403:
          this.log.warn(
            { key: key.hash, status, code, message, details },
            "Key check returned Forbidden/Unauthorized error. Disabling key."
          );
          this.updateKey(key.hash, { isDisabled: true, isRevoked: true });
          return;
        case 429:
          this.log.warn(
            { key: key.hash, status, code, message, details },
            "Key is rate limited. Rechecking key in 1 minute."
          );
          const next = Date.now() - (KEY_CHECK_PERIOD - 10 * 1000);
          this.updateKey(key.hash, { lastChecked: next });
          return;
      }

      this.log.error(
        { key: key.hash, status, code, message, details },
        "Encountered unexpected error status while checking key. This may indicate a change in the API; please report this."
      );
      return this.updateKey(key.hash, { lastChecked: Date.now() });
    }

    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 10 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    return this.updateKey(key.hash, { lastChecked: next });
  }

  static errorIsGoogleAIError(
    error: AxiosError
  ): error is AxiosError<GoogleAIError> {
    const data = error.response?.data as any;
    return data?.error?.code || data?.error?.status;
  }
}

type GoogleAIError = {
  error: {
    code: string;
    message: string;
    status: string;
    details: any[];
  };
};
