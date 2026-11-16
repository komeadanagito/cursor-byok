//! WorkBuddy CN 扫码授权与模型网关端点、客户端身份常量。

// 模型网关（国内版，OpenAI 兼容）。扫码登录拿到的 accessToken 直接用于此网关。
export const DEFAULT_GATEWAY_BASE = "https://copilot.tencent.com";

// WorkBuddy 桌面/CLI 的通用身份头。网关与扫码授权端点会校验这些头。
export const CLIENT_VERSION = "2.63.2";
export const USER_AGENT = `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`;
export const CLIENT_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "x-requested-with": "XMLHttpRequest",
  "user-agent": USER_AGENT,
  origin: "https://www.codebuddy.cn",
  referer: "https://www.codebuddy.cn/",
};
