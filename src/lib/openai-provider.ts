import "server-only";

import { redactSecrets } from "./logger";
import type { CodexRunner } from "./pilot";

export const OPENAI_HIGH_VOLUME_MODELS = [
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o3-mini",
  "o4-mini",
] as const;

export const OPENAI_STANDARD_MODELS = [
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
  "o1",
  "o3",
] as const;

export const ALLOWED_OPENAI_MODELS = [
  ...OPENAI_HIGH_VOLUME_MODELS,
  ...OPENAI_STANDARD_MODELS,
] as const;

export type AllowedOpenAIModel = (typeof ALLOWED_OPENAI_MODELS)[number];

export const OPENAI_DEFAULT_MODEL: AllowedOpenAIModel = "gpt-5-mini";

export function isAllowedOpenAIModel(model: string): model is AllowedOpenAIModel {
  return (ALLOWED_OPENAI_MODELS as readonly string[]).includes(model);
}

export function resolveAllowedModel(candidate?: unknown): AllowedOpenAIModel {
  if (typeof candidate === "string" && isAllowedOpenAIModel(candidate.trim())) {
    return candidate.trim() as AllowedOpenAIModel;
  }
  return OPENAI_DEFAULT_MODEL;
}

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 300_000;
const OPENAI_MAX_OUTPUT_TOKENS = 16_000;
const MAX_API_RETRIES = 2;

// Strict structured output only accepts a subset of JSON Schema keywords.
// Length/range bounds (minLength, maxLength, minItems, maxItems, minimum,
// maximum, …) are rejected with a 400, so they are stripped before sending.
// Local validation (conforms) still enforces them on the way back.
const STRIPPED_KEYS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minProperties",
  "maxProperties",
  "pattern",
  "format",
  "multipleOf",
]);

type JsonSchema = {
  type?: string;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  description?: string;
  [key: string]: unknown;
};

export function sanitizeSchemaForStrict(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRIPPED_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, JsonSchema>)) {
        props[propKey] = sanitizeSchemaForStrict(propValue);
      }
      out[key] = props;
    } else if (key === "items" && value && typeof value === "object") {
      out[key] = sanitizeSchemaForStrict(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out as JsonSchema;
}

function openaiError(code: string, title: string, message: string, retryable = false) {
  return { code, title, message, retryable };
}

export type OpenAIRunnerOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

function extractOutputText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text;
  if (Array.isArray(record.choices) && record.choices.length > 0) {
    const first = record.choices[0] as Record<string, unknown> | undefined;
    const msg = first?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === "string" && msg.content.trim()) return msg.content;
  }
  const output = record.output;
  if (!Array.isArray(output)) return null;
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    const content = message.content;
    if (typeof content === "string" && content.trim()) {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const chunk = part as Record<string, unknown>;
      if (
        (chunk.type === "output_text" || chunk.type === "text") &&
        typeof chunk.text === "string" &&
        chunk.text.trim()
      ) {
        texts.push(chunk.text);
      }
      if (chunk.type === "refusal" && typeof chunk.refusal === "string" && chunk.refusal.trim()) {
        throw openaiError("OPENAI_REFUSED", "Model refused the request", chunk.refusal.slice(0, 1000), false);
      }
    }
  }
  const joined = texts.join("");
  return joined.trim() ? joined : null;
}

/** CodexRunner backed by the OpenAI Responses API with strict structured output. */
export function createOpenAIRunner(options: OpenAIRunnerOptions): CodexRunner {
  const apiKey = options.apiKey?.trim() ?? "";
  const model = resolveAllowedModel(options.model);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!apiKey) {
    throw openaiError(
      "OPENAI_AUTH_MISSING",
      "OpenAI API key is missing",
      "Add your OpenAI API key on the Settings page (or set OPENAI_API_KEY on the server) to run with the OpenAI API.",
      false
    );
  }
  return async (prompt: string, schema?: object) => {
    let response!: Response;
    for (let retry = 0; retry <= MAX_API_RETRIES; retry++) {
      try {
        response = await fetchImpl(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: prompt,
            ...(schema
              ? {
                  text: {
                    format: {
                      type: "json_schema",
                      name: "codex_output",
                      schema: sanitizeSchemaForStrict(schema as JsonSchema),
                      strict: true,
                    },
                  },
                }
              : {}),
            max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
          }),
          signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        });
      } catch (error) {
        if (retry < MAX_API_RETRIES && !(error instanceof Error && error.name === "TimeoutError")) {
          await new Promise((r) => setTimeout(r, (retry + 1) * 1500));
          continue;
        }
        if (error instanceof Error && error.name === "TimeoutError") {
          throw openaiError("OPENAI_TIMEOUT", `OpenAI step timed out (${model})`, "One OpenAI step exceeded the time limit. Retry — this restarts the run from scratch.", true);
        }
        throw openaiError("OPENAI_NETWORK_ERROR", "Could not reach the OpenAI API", "Check your connection and retry.", true);
      }

      if (response.status === 429 || response.status >= 500) {
        if (retry < MAX_API_RETRIES) {
          const retryAfter = Number(response.headers?.get?.("retry-after")) || (retry + 1) * 2;
          await new Promise((r) => setTimeout(r, Math.min(retryAfter * 1000, 8000)));
          continue;
        }
      }
      break;
    }

    if (response.status === 401) {
      throw openaiError("OPENAI_AUTH", "OpenAI rejected the API key", "The API key is invalid or revoked. Update it on the Settings page.", false);
    }
    if (response.status === 429) {
      throw openaiError("OPENAI_RATE_LIMITED", "OpenAI rate limit reached", "OpenAI temporarily limited requests. Wait a minute and retry.", true);
    }
    if (!response.ok) {
      let detail = `status ${response.status}`;
      try {
        const data = (await response.json()) as { error?: { message?: string; code?: string } };
        // Redact defensively: error payloads must never carry credentials.
        if (data?.error?.message) detail = redactSecrets(data.error.message).slice(0, 500);
      } catch {
        // Keep the status-only detail.
      }
      throw openaiError("OPENAI_REQUEST_FAILED", "OpenAI request failed", `${detail} Retry to run it again.`, response.status >= 500);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw openaiError("OPENAI_REQUEST_FAILED", "OpenAI returned an unreadable response", "Retry to run it again.", true);
    }
    const text = extractOutputText(data);
    if (!text) {
      throw openaiError(
        "OPENAI_EMPTY_RESPONSE",
        "OpenAI returned no text",
        "The model response contained no output (it may have hit the output limit). Retry to run it again.",
        true
      );
    }
    return text;
  };
}
