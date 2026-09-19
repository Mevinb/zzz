"use client";

import { useState } from "react";
import Link from "next/link";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type EngineSettings } from "@/lib/settings-client";

export default function SettingsPage() {
  const [settings, setSettings] = useState<EngineSettings>(() => {
    try {
      return readSettings();
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  });
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  function update(patch: Partial<EngineSettings>) {
    setSettings((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }

  function save() {
    try {
      writeSettings({ ...settings, openaiModel: settings.openaiModel.trim() || "gpt-5" });
      setSaved(true);
      setStorageError(null);
    } catch {
      setStorageError("Could not save settings in this browser (storage unavailable).");
    }
  }

  function clearKey() {
    update({ openaiApiKey: "" });
  }

  return (
    <main className="min-h-screen bg-[#0d1117] text-[#c9d1d9]">
      <header className="border-b border-[#30363d] bg-[#161b22]">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="font-semibold text-white hover:underline">
              ← Codex Pilot
            </Link>
            <span className="hidden border-l border-[#30363d] pl-3 text-xs font-normal text-[#8b949e] sm:block">
              Engine settings
            </span>
          </div>
          <Link href="/logs" className="rounded-md border border-[#30363d] px-2.5 py-1.5 text-xs text-[#c9d1d9] hover:bg-[#21262d]">
            Logs
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="text-xl font-semibold text-white">Engine settings</h1>
        <p className="mt-1 text-sm text-[#8b949e]">
          Choose what powers investigations. Settings live only in this browser — the API key is sent with each run
          request and never stored on the server.
        </p>

        <div className="mt-5 space-y-4">
          <div className="rounded-md border border-[#30363d] bg-[#161b22] p-4">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[.14em] text-[#58a6ff]">Engine</p>
            <div className="mt-3 space-y-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-[#30363d] bg-[#0d1117] p-3">
                <input
                  type="radio"
                  name="provider"
                  checked={settings.provider === "local"}
                  onChange={() => update({ provider: "local" })}
                  className="mt-1 h-4 w-4 accent-[#1f6feb]"
                />
                <span>
                  <span className="block text-sm font-medium text-white">Local Codex CLI</span>
                  <span className="mt-0.5 block text-xs text-[#8b949e]">
                    Uses your subscription via the Codex CLI on this machine. Requires `codex login`. Free with your plan.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-[#30363d] bg-[#0d1117] p-3">
                <input
                  type="radio"
                  name="provider"
                  checked={settings.provider === "openai"}
                  onChange={() => update({ provider: "openai" })}
                  className="mt-1 h-4 w-4 accent-[#1f6feb]"
                />
                <span>
                  <span className="block text-sm font-medium text-white">OpenAI API</span>
                  <span className="mt-0.5 block text-xs text-[#8b949e]">
                    Calls the OpenAI Responses API directly with your key. Billed by OpenAI — handy when your Codex
                    limit runs out.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className={`rounded-md border border-[#30363d] bg-[#161b22] p-4 ${settings.provider !== "openai" ? "opacity-60" : ""}`}>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[.14em] text-[#58a6ff]">OpenAI API</p>
            <label htmlFor="openai-key" className="mt-3 block text-xs font-medium text-[#c9d1d9]">
              API key
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="openai-key"
                type={showKey ? "text" : "password"}
                value={settings.openaiApiKey}
                onChange={(event) => update({ openaiApiKey: event.target.value })}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
                disabled={settings.provider !== "openai"}
                className="h-10 min-w-0 flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-3 font-mono text-sm outline-none placeholder:text-[#484f58] focus:border-[#58a6ff] disabled:cursor-not-allowed"
              />
              <button
                onClick={() => setShowKey((value) => !value)}
                className="shrink-0 rounded-md border border-[#30363d] px-3 text-xs text-[#c9d1d9] hover:bg-[#21262d]"
              >
                {showKey ? "Hide" : "Show"}
              </button>
              <button
                onClick={clearKey}
                className="shrink-0 rounded-md border border-[#f85149]/40 px-3 text-xs text-[#ff7b72] hover:bg-[#f85149]/10"
              >
                Clear
              </button>
            </div>
            <label htmlFor="openai-model" className="mt-3 block text-xs font-medium text-[#c9d1d9]">
              Model
            </label>
            <input
              id="openai-model"
              type="text"
              value={settings.openaiModel}
              onChange={(event) => update({ openaiModel: event.target.value })}
              placeholder="gpt-5"
              autoComplete="off"
              spellCheck={false}
              disabled={settings.provider !== "openai"}
              className="mt-1 h-10 w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 font-mono text-sm outline-none placeholder:text-[#484f58] focus:border-[#58a6ff] disabled:cursor-not-allowed"
            />
            <p className="mt-2 text-xs leading-5 text-[#8b949e]">
              A server-side <span className="font-mono">OPENAI_API_KEY</span> fills in when this field is empty. Never
              share your key in chat or commit it anywhere.
            </p>
          </div>

          {storageError && (
            <div role="alert" className="rounded-md border border-[#f85149]/40 bg-[#f85149]/[.08] p-3 text-xs text-[#ff7b72]">
              {storageError}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              className="rounded-md bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]"
            >
              Save settings
            </button>
            {saved && <span className="text-xs text-[#3fb950]">Saved — new investigations use this engine.</span>}
          </div>
        </div>
      </section>
    </main>
  );
}
