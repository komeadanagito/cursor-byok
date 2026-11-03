import { parseAntigravityModels, STATIC_ANTIGRAVITY_MODELS } from "./models.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("catalog hides legacy tiers but keeps newly released models", () => {
  const models = parseAntigravityModels({
    models: {
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", supportsThinking: true },
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", supportsThinking: true },
      "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)" },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
      "claude-sonnet-5-5-medium": { displayName: "Claude Sonnet 5.5 (Medium)" },
      "claude-sonnet-5-5-low": { displayName: "Claude Sonnet 5.5 (Low)" },
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
      "gemini-5-horizon-medium": { displayName: "Gemini 5 Horizon (Medium)" },
      "chat_20706": {},
    },
  });

  const ids = models.map((model) => model.id);
  assert(
    ids.join(",") ===
      "gemini-4-argon-medium,gemini-3.8-flash-medium,claude-sonnet-5-5-medium,gpt-oss-120b-medium,gemini-5-horizon-medium",
    `unexpected catalog: ${ids.join(",")}`,
  );
});

Deno.test("static fallback matches the curated catalog", () => {
  const ids = STATIC_ANTIGRAVITY_MODELS.map((model) => model.id);
  assert(
    ids.join(",") ===
      "gemini-4-argon-medium,gemini-3.8-flash-medium,claude-opus-5-5-medium,claude-sonnet-5-5-medium,gpt-oss-120b-medium",
    `unexpected static catalog: ${ids.join(",")}`,
  );
});