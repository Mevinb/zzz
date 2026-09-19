// Browser-side engine settings. Stored only in localStorage — the API key is
// sent with run requests over the local connection and never stored server-side.
export type EngineProvider = "local" | "openai";

export type EngineSettings = {
  provider: EngineProvider;
  openaiApiKey: string;
  openaiModel: string;
};

export const SETTINGS_KEY = "codex-pilot:settings:v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5";

export const DEFAULT_SETTINGS: EngineSettings = {
  provider: "local",
  openaiApiKey: "",
  openaiModel: DEFAULT_OPENAI_MODEL,
};

export function readSettings(): EngineSettings {
  try {
    if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<EngineSettings>;
    return {
      provider: parsed.provider === "openai" ? "openai" : "local",
      openaiApiKey: typeof parsed.openaiApiKey === "string" ? parsed.openaiApiKey : "",
      openaiModel: typeof parsed.openaiModel === "string" && parsed.openaiModel.trim() ? parsed.openaiModel.trim() : DEFAULT_OPENAI_MODEL,
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
