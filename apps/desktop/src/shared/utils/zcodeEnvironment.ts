/**
 * ZCode (Z.AI Coding Plan) client environment.
 *
 * Z.AI gives its own coding-plan client a better model environment, so a
 * plain API call is not equivalent to what the official app sends. The
 * identity below is captured from the official ZCode desktop/CLI runtime and
 * is shared with the `zcode-auth` plugin so a manually configured model can
 * spoof the same environment.
 *
 * Headers that must change between requests (and between conversations) use
 * the placeholders the server renders per invocation: `{{Uuid}}`, `{{SessionId}}`,
 * `{{OsCategory}}`, `{{OsPlatform}}`. The remaining fields are filled in from
 * this machine at the moment the environment is applied.
 */

export const ZCODE_PLUGIN_ID = "dev.cursorbyok.plugins.zcode";

/** Captured from the official client; bump alongside the plugin when it changes. */
const APP_VERSION = "3.10.2";
const AI_SDK_VERSION = "4.0.39";
const NODE_MAJOR = "22";

export type ZcodeEnvironment = {
  customHeaders: Record<string, string>;
  openaiExtraParams: Record<string, unknown>;
};

function osVersion(): string {
  // The webview runs on the user's machine, so the user agent carries the real
  // OS release. It only needs to be right once, when the environment is applied.
  const ua = navigator.userAgent;
  const mac = /Mac OS X (\d+(?:[._]\d+)+)/.exec(ua)?.[1]?.replaceAll("_", ".");
  if (mac) return mac;
  const windows = /Windows NT (\d+(?:\.\d+)+)/.exec(ua)?.[1];
  if (windows) return windows;
  return "unknown";
}

function clientLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function clientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The official ZCode identity. Request-scoped ids stay as placeholders so every
 * call carries a fresh fingerprint instead of one value frozen at config time.
 */
export function zcodeEnvironment(): ZcodeEnvironment {
  return {
    customHeaders: {
      "User-Agent": `ZCode/${APP_VERSION} ai-sdk/provider-utils/${AI_SDK_VERSION} runtime/node.js/${NODE_MAJOR}`,
      "HTTP-Referer": "https://zcode.z.ai",
      "X-Title": "Z Code@electron",
      "X-ZCode-App-Version": APP_VERSION,
      "X-ZCode-Agent": "glm",
      "X-ZCode-Session-Type": "main",
      "X-Platform": "{{OsPlatform}}",
      "X-Os-Category": "{{OsCategory}}",
      "X-Os-Version": osVersion(),
      "X-Client-Language": clientLocale(),
      "X-Client-Timezone": clientTimezone(),
      "X-Release-Channel": "production",
      "X-Session-Id": "{{SessionId}}",
      "X-Query-Id": "{{Uuid}}",
      "X-Request-Id": "{{Uuid}}",
      "X-ZCode-Trace-Id": "{{Uuid}}",
    },
    // The coding plan expects max_tokens and a preserved thinking block; the
    // plain OpenAI defaults would be rejected or lose the thinking state.
    openaiExtraParams: {
      thinking: { type: "enabled", clear_thinking: false },
      tool_stream: true,
    },
  };
}

/** A model is spoofing the ZCode environment when it carries the identity headers. */
export function usesZcodeEnvironment(customHeaders: Record<string, unknown>): boolean {
  return Object.keys(customHeaders).some((name) => name.toLowerCase() === "x-zcode-agent");
}

/**
 * The environment can only be applied while the `zcode-auth` plugin is present
 * and switched on, so a model cannot be left half-configured against a provider
 * the plugin is supposed to drive.
 */
export function isZcodePluginReady(
  plugins: { id: string; providers: { configured: boolean; models: { enabled: boolean }[] }[] }[],
): boolean {
  const plugin = plugins.find((candidate) => candidate.id === ZCODE_PLUGIN_ID);
  if (!plugin) return false;
  return plugin.providers.some(
    (provider) => provider.configured && provider.models.some((model) => model.enabled),
  );
}
