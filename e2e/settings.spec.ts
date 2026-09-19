import { expect, test } from "@playwright/test";

test("settings page saves the engine choice and key to local memory", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Engine settings" })).toBeVisible();
  await page.getByRole("radio", { name: /OpenAI API/ }).check();
  await page.getByLabel("API key").fill("sk-test-e2e-key");
  await page.getByLabel("Model").fill("gpt-5-test");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved — new investigations use this engine.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("API key")).toHaveValue("sk-test-e2e-key");
  await expect(page.getByLabel("Model")).toHaveValue("gpt-5-test");
});

test("main page shows the saved engine and links to settings", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "codex-pilot:settings:v1",
      JSON.stringify({ provider: "openai", openaiApiKey: "sk-test-e2e-key", openaiModel: "gpt-5-test" })
    );
  });
  await page.goto("/");
  await expect(page.getByText("OpenAI API (gpt-5-test)")).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
});
