import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceImportFile,
  ResourceImportResult,
  ResourceImportSupport,
  ResourceSnapshot,
  ResourceView,
} from "cursor-byok:resource";

export const RESOURCE_TYPE = "zcode-credential";
export const DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const CHINA_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

const ALLOWED_HOSTS = new Set(["api.z.ai", "open.bigmodel.cn"]);

export type ZCodeSourceTitle = "electron" | "cli";

/** Stored only in the resource's private data; never exposed through the UI. */
export type ZCodeCredential = {
  apiKey: string;
  baseUrl: string;
  displayName: string;
  appVersion: string;
  sourceTitle: ZCodeSourceTitle;
  aiSdkVersion: string | null;
  nodeMajor: string | null;
  osVersion: string | null;
  sessionId: string;
  releaseChannel: "production" | "test";
};

export type CredentialCandidate = {
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
  appVersion?: string;
  sourceTitle?: ZCodeSourceTitle;
  aiSdkVersion?: string;
  nodeMajor?: string;
  osVersion?: string;
  sessionId?: string;
  releaseChannel?: "production" | "test";
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeApiKey(value: string): string {
  let key = stripQuotes(value.trim());
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, "").trim();
  if (key.length < 8 || /\s/.test(key)) {
    throw new Error("ZCode API key is empty or malformed");
  }
  return key;
}


/** Normalize a coding-plan or Claude Code endpoint to an OpenAI-compatible base URL. */
export function normalizeBaseUrl(value?: string | null): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid ZCode endpoint: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("ZCode endpoint must use HTTPS");
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`unsupported ZCode endpoint host: ${url.hostname}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ZCode endpoint must not contain credentials, query, or fragment");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!path) path = "/api/coding/paas/v4";
  for (const suffix of ["/chat/completions", "/models"]) {
    if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  }
  if (path.endsWith("/anthropic")) {
    // Claude Code's ANTHROPIC_BASE_URL is commonly imported verbatim. The
    // same coding plan is exposed through these OpenAI-compatible endpoints.
    path = "/api/coding/paas/v4";
  }
  return `${url.origin}${path}`;
}


function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    values[match[1]] = stripQuotes(match[2].replace(/\s+#.*$/, ""));
  }
  return values;
}

function candidateFromRecord(value: unknown): CredentialCandidate | null {
  const source = record(value);
  if (!source) return null;
  const env = record(source.env) ?? {};
  const merged = { ...env, ...source };
  const apiKey = firstText(merged, [
    "apiKey",
    "api_key",
    "ZCODE_API_KEY",
    "ZAI_API_KEY",
    "ZHIPU_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "key",
    "token",
  ]);
  if (!apiKey) return null;
  const sourceTitle = firstText(merged, ["sourceTitle", "source_title", "ZCODE_SOURCE_TITLE"]);
  const releaseChannel = firstText(merged, ["releaseChannel", "release_channel", "ZCODE_ENV"]);
  return {
    apiKey,
    baseUrl: firstText(merged, [
      "baseUrl",
      "base_url",
      "baseURL",
      "endpoint",
      "url",
      "ZCODE_BASE_URL",
      "ZAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
    ]) ?? undefined,
    displayName: firstText(merged, ["displayName", "display_name", "name", "email"]) ?? undefined,
    appVersion: firstText(merged, ["appVersion", "app_version", "ZCODE_APP_VERSION"]) ?? undefined,
    sourceTitle: sourceTitle === "cli" || sourceTitle === "electron" ? sourceTitle : undefined,
    aiSdkVersion: firstText(merged, [
      "aiSdkVersion",
      "ai_sdk_version",
      "ZCODE_AI_SDK_VERSION",
    ]) ?? undefined,
    nodeMajor: firstText(merged, [
      "nodeMajor",
      "node_major",
      "ZCODE_NODE_MAJOR",
    ]) ?? undefined,
    osVersion: firstText(merged, [
      "osVersion",
      "os_version",
      "ZCODE_OS_VERSION",
    ]) ?? undefined,
    sessionId: firstText(merged, ["sessionId", "session_id", "ZCODE_SESSION_ID"]) ?? undefined,
    releaseChannel: releaseChannel?.toLowerCase() === "test"
      ? "test"
      : releaseChannel
      ? "production"
      : undefined,
  };
}


function collectCandidates(value: unknown, output: CredentialCandidate[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, output);
    return;
  }
  const source = record(value);
  if (!source) return;
  const direct = candidateFromRecord(source);
  if (direct) output.push(direct);
  for (const key of ["accounts", "credentials", "items", "data", "zcode"]) {
    if (key in source) collectCandidates(source[key], output);
  }
}

function candidatesFromFile(file: ResourceImportFile): CredentialCandidate[] {
  const raw = file.content.trim();
  if (!raw) return [];
  if (raw.startsWith("{") || raw.startsWith("[")) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const candidates: CredentialCandidate[] = [];
    collectCandidates(value, candidates);
    return candidates;
  }
  const env = parseEnv(raw);
  const envCandidate = candidateFromRecord(env);
  if (envCandidate) return [envCandidate];
  if (!raw.includes("\n") && !raw.includes("=") && !raw.includes(" ")) {
    return [{ apiKey: raw, displayName: file.name }];
  }
  return [];
}

async function credentialFingerprint(apiKey: string, baseUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${baseUrl}\n${apiKey}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function credentialDraft(
  candidate: CredentialCandidate,
): Promise<{ key: string; privateData: JsonValue }> {
  const apiKey = normalizeApiKey(candidate.apiKey);
  const baseUrl = normalizeBaseUrl(candidate.baseUrl);
  const displayName = candidate.displayName?.trim() ||
    `ZCode \u00b7 ${apiKey.slice(-4)}`;
  const data: ZCodeCredential = {
    apiKey,
    baseUrl,
    displayName,
    appVersion: candidate.appVersion?.trim() || "3.10.2",
    sourceTitle: candidate.sourceTitle ?? "electron",
    aiSdkVersion: candidate.aiSdkVersion?.trim() || null,
    nodeMajor: candidate.nodeMajor?.trim() || null,
    osVersion: candidate.osVersion?.trim() || null,
    sessionId: candidate.sessionId?.trim() || crypto.randomUUID(),
    releaseChannel: candidate.releaseChannel ?? "production",
  };
  return {
    key: `zcode:${await credentialFingerprint(apiKey, baseUrl)}`,
    privateData: data as unknown as JsonValue,
  };
}

export async function parseCredentialFiles(files: ResourceImportFile[]): Promise<{
  credentials: CredentialCandidate[];
  warnings: string[];
}> {
  const credentials: CredentialCandidate[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    try {
      const found = candidatesFromFile(file);
      if (found.length === 0) {
        warnings.push(`${file.name}: no ZCode API key found`);
      } else {
        credentials.push(...found);
      }
    } catch (error) {
      warnings.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { credentials, warnings };
}


export function credentialData(resource: ResourceSnapshot): ZCodeCredential {
  const data = record(resource.privateData);
  const apiKey = text(data?.apiKey);
  if (!apiKey) throw new Error("ZCode resource is missing its API key");
  const baseUrl = normalizeBaseUrl(text(data?.baseUrl));
  const displayName = text(data?.displayName) ?? `ZCode \u00b7 ${apiKey.slice(-4)}`;
  const appVersion = text(data?.appVersion) ?? "3.10.2";
  const sourceTitle = text(data?.sourceTitle);
  const releaseChannel = text(data?.releaseChannel);
  return {
    apiKey,
    baseUrl,
    displayName,
    appVersion,
    sourceTitle: sourceTitle === "cli" ? "cli" : "electron",
    aiSdkVersion: text(data?.aiSdkVersion),
    nodeMajor: text(data?.nodeMajor),
    osVersion: text(data?.osVersion),
    sessionId: text(data?.sessionId) ?? crypto.randomUUID(),
    releaseChannel: releaseChannel === "test" ? "test" : "production",
  };
}

export function presentCredential(resource: ResourceSnapshot): ResourceView {
  const data = credentialData(resource);
  const endpoint = new URL(data.baseUrl);
  return {
    displayName: data.displayName,
    description: {
      "en-US": `ZCode identity active \u00b7 ${endpoint.host}${endpoint.pathname}`,
      "zh-CN": `ZCode \u8eab\u4efd\u4f2a\u88c5\u5df2\u542f\u7528 \u00b7 ${endpoint.host}${endpoint.pathname}`,
    },
  };
}

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import ZCode credentials",
    "zh-CN": "\u5bfc\u5165 ZCode \u51ed\u8bc1",
  },
  description: {
    "en-US":
      "Import a JSON, .env, or text file containing a Z.AI Coding Plan API key. Optional fields: baseUrl, displayName, appVersion, sourceTitle.",
    "zh-CN":
      "\u5bfc\u5165\u5305\u542b\u667a\u8c31 Coding Plan API Key \u7684 JSON\u3001.env \u6216\u6587\u672c\u6587\u4ef6\u3002\u53ef\u9009\u5b57\u6bb5\uff1abaseUrl\u3001displayName\u3001appVersion\u3001sourceTitle\u3002",
  },
  accept: [".json", ".env", ".txt", ".key"],
  multiple: true,
  parse: async (
    files: ResourceImportFile[],
    _context: PluginContext,
  ): Promise<ResourceImportResult> => {
    const { credentials, warnings } = await parseCredentialFiles(files);
    if (credentials.length === 0) {
      throw new Error(
        warnings.join("; ") || "credential file does not contain a valid ZCode API key",
      );
    }
    const resources = [];
    for (const candidate of credentials) {
      try {
        resources.push(await credentialDraft(candidate));
      } catch (error) {
        warnings.push(
          `${candidate.displayName ?? "credential"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (resources.length === 0) throw new Error(warnings.join("; "));
    return {
      resources,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
