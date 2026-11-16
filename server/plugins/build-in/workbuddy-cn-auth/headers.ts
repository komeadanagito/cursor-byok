//! 构造 WorkBuddy 模型网关要求的"官方客户端"身份头。
//! 网关不仅看 Authorization，还校验一整套 X-IDE-* 与 X-Conversation-* 头，
//! 缺少这些头会返回 401/403（很容易被误判成 token 过期）。
import { CLIENT_VERSION, USER_AGENT } from "./config.ts";

const WEB_ORIGIN = "https://www.workbuddy.cn";

function originOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return WEB_ORIGIN;
  }
}

/**
 * 每次调用都生成全新的 X-Conversation-* UUID —— 复用同一个会被网关拒绝。
 * 不在此处设置 accept / content-type：调用方按 fetch 或 SSE 各自补充。
 */
export function workbuddyGatewayHeaders(baseUrl: string): Record<string, string> {
  const origin = originOf(baseUrl);
  return {
    "user-agent": USER_AGENT,
    origin,
    referer: `${origin}/`,
    "x-requested-with": "XMLHttpRequest",
    "x-ide-type": "WorkBuddy",
    "x-ide-name": "WorkBuddy",
    "x-ide-version": CLIENT_VERSION,
    "x-product": "SaaS",
    "x-conversation-id": crypto.randomUUID(),
    "x-conversation-request-id": crypto.randomUUID(),
    "x-conversation-message-id": crypto.randomUUID(),
    "x-no-user-id": "1",
    "x-no-enterprise-id": "1",
    "x-no-department-info": "1",
  };
}

/** 与身份头合并出带 Bearer 鉴权的完整请求头。 */
export function authorizedGatewayHeaders(
  accessToken: string,
  baseUrl: string,
  accept = "application/json",
): Record<string, string> {
  return {
    ...workbuddyGatewayHeaders(baseUrl),
    accept,
    authorization: `Bearer ${accessToken}`,
  };
}
