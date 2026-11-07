import type { ZCodeCredential } from "./resources.ts";

const OPENAI_AI_SDK_VERSION = "4.0.39";
const FALLBACK_NODE_MAJOR = "22";
const STAINLESS_PREFIX = "x-stainless-";

type RuntimeInfo = {
  category: "macos" | "windows" | "linux";
  arch: string;
  osVersion: string;
};

function denoBuild(): { os?: string; arch?: string } | null {
  return (globalThis as { Deno?: { build?: { os?: string; arch?: string } } }).Deno?.build ??
    null;
}

/**
 * The plugin worker runs under Deno, whose `navigator.userAgent` is just
 * `Deno/<version>` and carries no OS version. `Deno.osRelease()` is the same
 * string Node's `os.release()` returns — the one a ZCode client would report.
 */
function osRelease(): string | null {
  const release = (globalThis as { Deno?: { osRelease?: () => string } }).Deno?.osRelease;
  if (typeof release !== "function") return null;
  try {
    return release.call(undefined) || null;
  } catch {
    return null;
  }
}

function runtimeInfo(): RuntimeInfo {
  const build = denoBuild();
  const os = build?.os ?? "linux";
  const rawArch = build?.arch ?? "x86_64";
  const category = os === "darwin" ? "macos" : os === "windows" ? "windows" : "linux";
  const arch = rawArch === "x86_64"
    ? "x64"
    : rawArch === "aarch64" || rawArch === "arm64"
    ? "arm64"
    : rawArch;
  return {
    category,
    arch,
    osVersion: osRelease() ?? "unknown",
  };
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
 * Identity headers captured from the official ZCode desktop/CLI runtime.
 *
 * `session` is the conversation identity (the host's cache key) so a session id
 * rotates per conversation the way the real client's does. Catalog calls pass
 * nothing and fall back to the credential's captured session id.
 */
export function zcodeIdentityHeaders(
  data: ZCodeCredential,
  session?: string,
): Record<string, string> {
  const platform = runtimeInfo();
  const locale = clientLocale();
  const timezone = clientTimezone();
  return {
    "User-Agent":
      `ZCode/${data.appVersion} ai-sdk/provider-utils/${data.aiSdkVersion ?? OPENAI_AI_SDK_VERSION} runtime/node.js/${data.nodeMajor ?? FALLBACK_NODE_MAJOR}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": `Z Code@${data.sourceTitle}`,
    "X-ZCode-App-Version": data.appVersion,
    "X-ZCode-Agent": "glm",
    "X-ZCode-Session-Type": "main",
    "X-Platform": `${platform.category === "macos" ? "darwin" : platform.category}-${platform.arch}`,
    "X-Os-Category": platform.category,
    "X-Os-Version": data.osVersion ?? platform.osVersion,
    "X-Client-Language": locale,
    "X-Client-Timezone": timezone,
    "X-Release-Channel": data.releaseChannel,
    "X-Session-Id": session ?? data.sessionId,
    "X-Query-Id": crypto.randomUUID(),
    "X-Request-Id": crypto.randomUUID(),
    "X-ZCode-Trace-Id": crypto.randomUUID(),
  };
}

/** openai-node adds x-stainless-* fingerprints the official ZCode client never sends. */
export function stripSdkFingerprintHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !key.toLowerCase().startsWith(STAINLESS_PREFIX)),
  );
}

export function zcodeRequestHeaders(
  base: Record<string, string>,
  data: ZCodeCredential,
  session?: string,
): Record<string, string> {
  return {
    ...stripSdkFingerprintHeaders(base),
    ...zcodeIdentityHeaders(data, session),
  };
}
