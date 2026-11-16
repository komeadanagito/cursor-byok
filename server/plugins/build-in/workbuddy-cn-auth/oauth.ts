//! WorkBuddy CN 扫码登录（设备码式授权）。
//! 使用 WorkBuddy 桌面/CLI 官方的扫码授权协议，无需注册开放平台应用：
//!   begin: POST /v2/plugin/auth/state?platform=CLI -> {state, authUrl}
//!   poll:  GET  /v2/plugin/auth/token?state=xxx   -> {accessToken, refreshToken, ...}
//! 统一响应信封 {code, msg, data}，code==0 为成功，其余表示仍在等待扫码。
import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { OAuth2AddMethod, OAuth2Begin, OAuth2Poll } from "cursor-byok:resource";
import { CLIENT_HEADERS } from "./config.ts";
import { credentialDraft, queryAccountQuota } from "./resources.ts";

const AUTH_STATE_URL = "https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI";
const AUTH_TOKEN_URL = "https://copilot.tencent.com/v2/plugin/auth/token";
const LOGIN_ACCOUNT_URL = "https://copilot.tencent.com/v2/plugin/login/account";
const GATEWAY_BASE = "https://copilot.tencent.com";
const AUTHORIZATION_LIFETIME_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

type Session = { state: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseSession(value: JsonValue): Session {
  const session = object(value);
  const state = text(session?.state);
  if (!state) throw new Error("WorkBuddy 扫码登录会话无效，请重新开始");
  return { state };
}

/** 解析 {code, msg, data} 信封；code==0 视为成功。 */
function envelope(body: string): { ok: boolean; data: Record<string, unknown>; message: string } {
  const root = object(JSON.parse(body)) ?? {};
  const data = object(root.data) ?? {};
  const code = number(root.code);
  return {
    ok: code === 0,
    data,
    message: text(root.msg) ?? "",
  };
}

async function begin(context: PluginContext): Promise<OAuth2Begin> {
  const response = await context.network.fetch(AUTH_STATE_URL, {
    method: "POST",
    headers: { ...CLIENT_HEADERS, "content-type": "application/json" },
    body: "{}",
  });
  const parsed = envelope(response.body);
  if (response.status < 200 || response.status >= 300 || !parsed.ok) {
    throw new Error(`WorkBuddy 授权请求失败：${parsed.message || `HTTP ${response.status}`}`);
  }
  const state = text(parsed.data.state);
  const authUrl = text(parsed.data.authUrl);
  if (!state || !authUrl) throw new Error("WorkBuddy 授权响应缺少 state 或登录地址");
  return {
    session: { state } as unknown as JsonValue,
    // 用户在浏览器打开此链接，用微信/QQ 扫码登录。
    userCode: "请在浏览器扫码登录",
    verificationUrl: authUrl,
    expiresAtMs: Date.now() + AUTHORIZATION_LIFETIME_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

async function poll(sessionValue: JsonValue, context: PluginContext): Promise<OAuth2Poll> {
  const session = parseSession(sessionValue);
  const response = await context.network.fetch(
    `${AUTH_TOKEN_URL}?${new URLSearchParams({ state: session.state }).toString()}`,
    { method: "GET", headers: { ...CLIENT_HEADERS, accept: "application/json" } },
  );
  const parsed = envelope(response.body);
  if (!parsed.ok) {
    // 尚未扫码：继续轮询。
    return { status: "pending", session: sessionValue };
  }

  const accessToken = text(parsed.data.accessToken);
  if (!accessToken) {
    return { status: "failed", message: "WorkBuddy 授权成功但未返回 accessToken" };
  }
  const refreshToken = text(parsed.data.refreshToken);
  const expiresIn = number(parsed.data.expiresIn) ?? 3600;

  let displayName = "WorkBuddy CN";
  let openId: string | null = null;
  try {
    const account = await context.network.fetch(
      `${LOGIN_ACCOUNT_URL}?${new URLSearchParams({ state: session.state }).toString()}`,
      {
        method: "GET",
        headers: { ...CLIENT_HEADERS, authorization: `Bearer ${accessToken}` },
      },
    );
    const acc = envelope(account.body);
    displayName = text(acc.data.nickname) ?? displayName;
    openId = text(acc.data.uid);
  } catch {
    // 账号信息是可选展示信息。
  }

  let quota = null;
  try {
    quota = await queryAccountQuota(accessToken, GATEWAY_BASE, context.network);
  } catch {
    // 额度可稍后刷新。
  }

  return {
    status: "completed",
    resources: [
      await credentialDraft({
        accessToken,
        refreshToken,
        openId,
        displayName,
        gatewayBase: GATEWAY_BASE,
        expiresAtMs: Date.now() + expiresIn * 1000,
        quota,
      }),
    ],
  };
}

export const workbuddyDeviceOAuth: OAuth2AddMethod = {
  type: "oauth2.0",
  id: "workbuddy-cn-qr",
  displayName: {
    "en-US": "Sign in with WorkBuddy CN (QR code)",
    "zh-CN": "使用 WorkBuddy CN 扫码登录",
  },
  description: {
    "en-US": "Open the link and scan the QR code with WeChat/QQ to authorize WorkBuddy.",
    "zh-CN": "打开链接，用微信/QQ 扫码完成 WorkBuddy 授权（无需注册开放平台应用）。",
  },
  begin,
  poll,
};
