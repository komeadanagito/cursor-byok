//! WorkBuddy CN 凭证结构、账号身份、额度查询、refresh 与导入解析。
import type { JsonValue, NetworkRequestInit, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceDraft,
  ResourceImportFile,
  ResourceImportResult,
  ResourceImportSupport,
  ResourceMetric,
  ResourcePatch,
  ResourceSnapshot,
  ResourceView,
} from "cursor-byok:resource";
import { authorizedGatewayHeaders } from "./headers.ts";
import { CLIENT_HEADERS, DEFAULT_GATEWAY_BASE } from "./config.ts";

export const RESOURCE_TYPE = "workbuddy-cn-account";

export type CreditSnapshot = {
  used: number | null;
  total: number | null;
  currency: string;
  updatedAtMs: number;
};

export type AccountQuota = {
  planLabel: string | null;
  limitReached: boolean;
  coolingUntilMs: number | null;
  credits: CreditSnapshot | null;
};

/** 一份凭证同时服务四项能力：授权登录、模型调用、模型同步、额度同步。 */
export type AccountData = {
  accessToken: string;
  refreshToken: string | null;
  openId: string | null;
  displayName: string;
  clientId: string;
  clientSecret: string;
  gatewayBase: string;
  expiresAtMs: number | null;
  quota: AccountQuota | null;
};

export type CredentialCandidate = {
  accessToken: string;
  refreshToken?: string | null;
  openId?: string | null;
  displayName?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  gatewayBase?: string | null;
  expiresAtMs?: number | null;
  quota?: AccountQuota | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

export function isJwtExpired(token: string, bufferSeconds = 300): boolean {
  const payload = decodeJwtPayload(token);
  const exp = payload && typeof payload.exp === "number" ? payload.exp : null;
  if (!exp) return false;
  return exp <= Math.floor(Date.now() / 1000) + bufferSeconds;
}

export function isTokenExpired(data: AccountData, bufferSeconds = 300): boolean {
  if (!data.refreshToken) return false;
  if (typeof data.expiresAtMs === "number" && data.expiresAtMs > 0) {
    return Date.now() >= data.expiresAtMs - bufferSeconds * 1000;
  }
  return isJwtExpired(data.accessToken, bufferSeconds);
}

async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(
    new Uint8Array(digest).slice(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function normalizeBase(value: string | null | undefined): string {
  return (value && value.trim()) || DEFAULT_GATEWAY_BASE;
}

export async function credentialDraft(
  credential: CredentialCandidate,
): Promise<ResourceDraft> {
  const fingerprint = await tokenFingerprint(credential.accessToken);
  const payload = decodeJwtPayload(credential.accessToken);
  const openId = credential.openId ?? text(payload?.sub) ?? text(payload?.open_id) ??
    text(payload?.openId);
  const identity = openId ?? fingerprint;
  const data: AccountData = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken ?? null,
    openId: openId ?? null,
    displayName: credential.displayName ??
      text(payload?.nickname) ?? text(payload?.name) ?? `WorkBuddy (${fingerprint.slice(0, 6)})`,
    clientId: credential.clientId ?? "",
    clientSecret: credential.clientSecret ?? "",
    gatewayBase: normalizeBase(credential.gatewayBase),
    expiresAtMs: credential.expiresAtMs ?? null,
    quota: credential.quota ?? null,
  };
  return { key: `workbuddy-cn:${identity}`, privateData: data as unknown as JsonValue };
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = object(resource.privateData);
  const accessToken = text(data?.accessToken);
  if (!accessToken) {
    throw new Error("WorkBuddy CN resource is missing its access token");
  }
  return {
    accessToken,
    refreshToken: text(data?.refreshToken),
    openId: text(data?.openId),
    displayName: text(data?.displayName) ?? "WorkBuddy CN account",
    clientId: text(data?.clientId) ?? "",
    clientSecret: text(data?.clientSecret) ?? "",
    gatewayBase: normalizeBase(text(data?.gatewayBase)),
    expiresAtMs: number(data?.expiresAtMs),
    quota: (data?.quota ?? null) as AccountQuota | null,
  };
}

async function fetchText(
  network: PluginContext["network"] | undefined,
  url: string,
  init: NetworkRequestInit,
): Promise<{ status: number; body: string }> {
  if (network) {
    const response = await network.fetch(url, init);
    return { status: response.status, body: response.body };
  }
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

/** 查询额度快照：GET {gateway}/v1/usage（当前密钥的用量与配额）。 */
export async function queryAccountQuota(
  accessToken: string,
  gatewayBase: string,
  network: PluginContext["network"],
): Promise<AccountQuota | null> {
  try {
    const response = await network.fetch(`${gatewayBase.replace(/\/+$/, "")}/v1/usage`, {
      method: "GET",
      headers: authorizedGatewayHeaders(accessToken, gatewayBase),
    });
    if (response.status < 200 || response.status >= 300) return null;
    const root = object(JSON.parse(response.body));
    const data = object(root?.data) ?? root;
    const rawCredits = object(data?.credits) ?? data;
    const used = number(rawCredits?.used) ?? number(data?.used) ?? number(data?.tokensUsed);
    const total = number(rawCredits?.total) ?? number(data?.total) ?? number(data?.creditLimit);
    return {
      planLabel: text(data?.plan) ?? text(data?.planLabel) ?? text(root?.planLabel),
      limitReached: used !== null && total !== null && total > 0 && used >= total,
      coolingUntilMs: null,
      credits: {
        used,
        total,
        currency: text(rawCredits?.currency) ?? "credits",
        updatedAtMs: Date.now(),
      },
    };
  } catch {
    return null;
  }
}

/**
 * 用 refresh_token 换取新的 access_token（WorkBuddy CLI 网关）。
 * 官方未公开 refresh 端点，这里尝试标准的 /v2/plugin/auth/refresh；
 * 失败时返回 null，由调用方判定是否需要重新扫码。
 */
export async function refreshAccessToken(
  data: AccountData,
  network: PluginContext["network"] | undefined,
): Promise<
  {
    accessToken: string;
    refreshToken: string | null;
    expiresAtMs: number | null;
  } | null
> {
  if (!data.refreshToken) return null;
  try {
    const response = await fetchText(
      network,
      `${data.gatewayBase.replace(/\/+$/, "")}/v2/plugin/auth/refresh`,
      {
        method: "POST",
        headers: { ...CLIENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: data.refreshToken }),
      },
    );
    const root = object(JSON.parse(response.body)) ?? {};
    const body = object(root.data) ?? root;
    if (
      response.status < 200 || response.status >= 300 || root.code !== 0 && root.code !== undefined
    ) {
      return null;
    }
    const accessToken = text(body?.accessToken) ?? text(body?.access_token);
    if (!accessToken) return null;
    const expiresIn = number(body?.expiresIn) ?? number(body?.expires_in) ?? 3600;
    return {
      accessToken,
      refreshToken: text(body?.refreshToken) ?? text(body?.refresh_token) ?? data.refreshToken,
      expiresAtMs: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const metrics: ResourceMetric[] = [];
  const credits = data.quota?.credits;
  if (credits && (credits.used !== null || credits.total !== null)) {
    const remaining = credits.total !== null && credits.used !== null
      ? Math.max(0, credits.total - credits.used)
      : null;
    metrics.push({
      id: "credits",
      label: { "en-US": "Credits remaining", "zh-CN": "剩余积分" },
      unit: "count",
      value: remaining ?? credits.used ?? 0,
      ...(credits.updatedAtMs ? { resetAtMs: credits.updatedAtMs } : {}),
    });
  }
  return {
    displayName: data.displayName,
    ...(data.quota?.planLabel
      ? { description: { "en-US": data.quota.planLabel, "zh-CN": data.quota.planLabel } }
      : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

export async function refreshAccount(
  resource: ResourceSnapshot,
  context: PluginContext,
): Promise<ResourcePatch> {
  const data = accountData(resource);
  let accessToken = data.accessToken;
  let refreshToken = data.refreshToken;
  let expiresAtMs = data.expiresAtMs;

  // token 接近过期时尝试用 refresh_token 续期；失败则以现有 token 探测额度。
  if (refreshToken && isTokenExpired(data)) {
    const refreshed = await refreshAccessToken(data, context.network);
    if (refreshed) {
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
      expiresAtMs = refreshed.expiresAtMs;
    }
  }

  const quota = await queryAccountQuota(accessToken, data.gatewayBase, context.network);
  if (!quota && isTokenExpired(data)) {
    return {
      state: {
        status: "invalid",
        message: "WorkBuddy 登录已过期，请重新扫码授权",
      },
    };
  }
  const updated: AccountData = {
    ...data,
    accessToken,
    refreshToken,
    expiresAtMs,
    quota: quota ?? data.quota,
  };
  return {
    privateData: updated as unknown as JsonValue,
    state: { status: "ready" },
  };
}

function firstText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

/** 递归收集导入文件里的凭证（支持 workbuddy-desktop.info 的结构与纯 token）。 */
function collectCredentials(value: unknown, output: CredentialCandidate[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCredentials(item, output);
    return;
  }
  const item = object(value);
  if (!item || item.disabled === true) return;
  for (const key of ["accounts", "credentials", "items", "keys"]) {
    if (Array.isArray(item[key])) {
      collectCredentials(item[key], output);
      return;
    }
  }
  const auth = object(item.auth) ?? item;
  const tokens = object(item.tokens) ?? auth;
  const accessToken = firstText(tokens, [
    "accessToken",
    "access_token",
    "access",
    "token",
    "bearer",
  ]) ?? firstText(item, ["accessToken", "access_token", "access", "token"]);
  const refreshToken = firstText(tokens, ["refreshToken", "refresh_token", "refresh"]) ??
    firstText(item, ["refreshToken", "refresh_token", "refresh"]);
  const account = object(item.account) ?? item;
  const openId = firstText(account, ["uid", "openId", "open_id", "user_id"]) ??
    firstText(item, ["openId", "open_id"]);
  const displayName = firstText(item, ["displayName", "display_name", "name", "nickname"]);
  const clientId = firstText(item, ["clientId", "client_id", "appId"]);
  const clientSecret = firstText(item, ["clientSecret", "client_secret"]);
  const gatewayBase = firstText(item, ["baseUrl", "base_url", "gatewayBase", "domain"]);
  if (!accessToken && !refreshToken) return;
  output.push({
    accessToken: accessToken ?? refreshToken!,
    refreshToken,
    openId,
    displayName,
    clientId,
    clientSecret,
    gatewayBase,
  });
}

// deno-lint-ignore require-await -- 保持异步导入 API，便于未来加入网络校验。
export async function parseCredentialFiles(
  files: ResourceImportFile[],
): Promise<{ credentials: CredentialCandidate[]; warnings: string[] }> {
  const credentials: CredentialCandidate[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const raw = file.content.trim();
    if (!raw) continue;
    // 先尝试 JSON —— workbuddy-desktop.info 是 JSON，即使某字段值恰好是 JWT 形状。
    // 只有 JSON 解析失败时才把整段内容当作裸 token。
    let content: unknown;
    try {
      content = JSON.parse(raw);
    } catch {
      if (raw.startsWith("eyJ") || (raw.split(".").length === 3 && !raw.includes(" "))) {
        credentials.push({ accessToken: raw, displayName: file.name });
        continue;
      }
      const envMatch = raw.match(
        /(?:ACCESS_TOKEN|TOKEN|WORKBUDDY_TOKEN)\s*=\s*["']?([^"'\r\n]+)/i,
      );
      if (envMatch?.[1]) {
        credentials.push({ accessToken: envMatch[1].trim(), displayName: file.name });
        continue;
      }
      warnings.push(`${file.name}: 不是有效的 JSON 或 token`);
      continue;
    }
    if (typeof content === "string") {
      credentials.push({ accessToken: content.trim(), displayName: file.name });
      continue;
    }
    const found: CredentialCandidate[] = [];
    collectCredentials(content, found);
    if (found.length === 0) {
      warnings.push(`${file.name}: 未找到 WorkBuddy access token`);
      continue;
    }
    credentials.push(...found);
  }
  return { credentials, warnings };
}

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import WorkBuddy CN credentials",
    "zh-CN": "导入 WorkBuddy CN 凭证",
  },
  description: {
    "en-US":
      "Import a workbuddy-desktop.info JSON or a raw Bearer/access token for the model gateway.",
    "zh-CN": "导入 workbuddy-desktop.info JSON 或模型网关的 Bearer/access token。",
  },
  accept: [".json", ".txt", ".info", ".env"],
  multiple: true,
  parse: async (
    files: ResourceImportFile[],
    context: PluginContext,
  ): Promise<ResourceImportResult> => {
    const { credentials, warnings } = await parseCredentialFiles(files);
    if (credentials.length === 0) {
      throw new Error(
        warnings.join("; ") || "凭证文件中未找到有效的 access token",
      );
    }
    const drafts = await Promise.all(
      credentials.map(async (candidate) => {
        let quota: AccountQuota | null = null;
        try {
          quota = await queryAccountQuota(
            candidate.accessToken,
            normalizeBase(candidate.gatewayBase),
            context.network,
          );
        } catch {
          // 额度可在账号持久化后再刷新。
        }
        const draft = await credentialDraft(candidate);
        if (quota) {
          const data = draft.privateData as unknown as AccountData;
          data.quota = quota;
          draft.privateData = data as unknown as JsonValue;
        }
        return draft;
      }),
    );
    return {
      resources: drafts,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
