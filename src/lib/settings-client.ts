// Browser-side engine settings. Stored only in localStorage — the API key is
// sent with run requests over the local connection and never stored server-side.
export type EngineProvider = "local" | "openai";

export type EngineSettings = {
  provider: EngineProvider;
  openaiApiKey: string;
  openaiModel: string;
};

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

export const SETTINGS_KEY = "codex-pilot:settings:v1";
export const DEFAULT_OPENAI_MODEL: AllowedOpenAIModel = "gpt-5-mini";

export function isAllowedOpenAIModel(model: string): model is AllowedOpenAIModel {
  return (ALLOWED_OPENAI_MODELS as readonly string[]).includes(model);
}

export const DEFAULT_SETTINGS: EngineSettings = {
  provider: "openai",
  openaiApiKey: "",
  openaiModel: DEFAULT_OPENAI_MODEL,
};

export function readSettings(): EngineSettings {
  try {
    if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<EngineSettings>;
    const model = typeof parsed.openaiModel === "string" && isAllowedOpenAIModel(parsed.openaiModel.trim())
      ? (parsed.openaiModel.trim() as AllowedOpenAIModel)
      : DEFAULT_OPENAI_MODEL;
    return {
      provider: parsed.provider === "local" ? "local" : "openai",
      openaiApiKey: typeof parsed.openaiApiKey === "string" ? parsed.openaiApiKey : "",
      openaiModel: model,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: EngineSettings): void {
  window.localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ provider: settings.provider, openaiApiKey: settings.openaiApiKey, openaiModel: settings.openaiModel || DEFAULT_OPENAI_MODEL })
  );
}
