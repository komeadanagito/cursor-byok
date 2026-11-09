import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceDraft,
  ResourceImportFile,
  ResourceImportResult,
  ResourceImportSupport,
  ResourceMetric,
  ResourcePatch,
  ResourceSnapshot,
  ResourceState,
  ResourceView,
} from "cursor-byok:resource";

export const RESOURCE_TYPE = "zed-account";
export const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev";
export const ZED_VERSION = "0.225.0";
export const ZED_SYSTEM_ID_HEADER = "x-zed-system-id";
export const ZED_VERSION_HEADER = "x-zed-version";

export type ZedQuota = {
  plan: string;
  planLabel: string;
  subscriptionStartedAtMs: number | null;
  subscriptionEndedAtMs: number | null;
  editPredictionsUsed: number | null;
  editPredictionsLimit: number | "unlimited" | null;
  hasOverdueInvoices: boolean;
  limitReached: boolean;
  coolingUntilMs: number | null;
  updatedAtMs: number;
};

export type AccountData = {
  userId: string;
  accessToken: string;
  systemId: string;
  organizationId: string | null;
  displayName: string;
  llmToken: string | null;
  llmTokenExpiresAtMs: number | null;
  quota: ZedQuota | null;
};

export type CredentialCandidate = {
  userId: string;
  accessToken: string;
  systemId?: string | null;
  organizationId?: string | null;
  displayName?: string | null;
  llmToken?: string | null;
  llmTokenExpiresAtMs?: number | null;
  quota?: ZedQuota | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
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

export function jwtExpiresAtMs(token: string): number | null {
  const payload = decodeJwtPayload(token);
  const exp = typeof payload?.exp === "number" ? payload.exp : null;
  return exp !== null && exp > 0 ? exp * 1000 : null;
}

export function isLlmTokenExpired(data: AccountData, bufferSeconds = 180): boolean {
  if (!data.llmToken) return true;
  const expiresAtMs = data.llmTokenExpiresAtMs ?? jwtExpiresAtMs(data.llmToken);
  if (expiresAtMs === null) return false;
  return Date.now() >= expiresAtMs - bufferSeconds * 1000;
}

export function formatPlanLabel(plan: string): string {
  switch (plan.toLowerCase()) {
    case "zed_student":
      return "Zed Student ($10/mo)";
    case "zed_pro":
      return "Zed Pro";
    case "zed_pro_trial":
      return "Zed Pro Trial";
    case "zed_business":
      return "Zed Business";
    case "zed_vip":
      return "Zed VIP";
    case "zed_free":
      return "Zed Free";
    default:
      return plan || "Zed";
  }
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function parseAuthenticatedUserResponse(body: unknown): {
  displayName: string | null;
  organizationId: string | null;
  quota: ZedQuota;
} {
  const root = object(body) ?? {};
  const user = object(root.user) ?? {};
  const displayName = text(user.github_login) ?? text(user.username) ?? text(user.name);

  let organizationId = text(root.default_organization_id);
  if (!organizationId && Array.isArray(root.organizations)) {
    for (const rawOrg of root.organizations) {
      const org = object(rawOrg);
      const id = text(org?.id);
      if (id) {
        organizationId = id;
        break;
      }
    }
  }

  const planObj = object(root.plan) ?? {};
  const rawPlan = text(planObj.plan_v3) ?? text(planObj.plan) ?? "zed_free";
  const period = object(planObj.subscription_period);
  const subscriptionStartedAtMs = parseTimestampMs(period?.started_at);
  const subscriptionEndedAtMs = parseTimestampMs(period?.ended_at);

  const usage = object(planObj.usage);
  const editPredictions = object(usage?.edit_predictions);
  const editPredictionsUsed = typeof editPredictions?.used === "number"
    ? editPredictions.used
    : null;
  const rawLimit = editPredictions?.limit;
  let editPredictionsLimit: number | "unlimited" | null = null;
  if (rawLimit === "unlimited") {
    editPredictionsLimit = "unlimited";
  } else if (typeof rawLimit === "number") {
    editPredictionsLimit = rawLimit;
  } else if (object(rawLimit) && typeof object(rawLimit)?.limited === "number") {
    editPredictionsLimit = object(rawLimit)?.limited as number;
  }

  return {
    displayName,
    organizationId,
    quota: {
      plan: rawPlan,
      planLabel: formatPlanLabel(rawPlan),
      subscriptionStartedAtMs,
      subscriptionEndedAtMs,
      editPredictionsUsed,
      editPredictionsLimit,
      hasOverdueInvoices: planObj.has_overdue_invoices === true,
      limitReached: false,
      coolingUntilMs: null,
      updatedAtMs: Date.now(),
    },
  };
}

export function extractLlmToken(body: unknown): string | null {
  const root = object(body);
  if (!root) return null;
  if (typeof root.token === "string" && root.token.trim()) {
    return root.token.trim();
  }
  const tokenObj = object(root.token);
  return text(tokenObj?.token ?? tokenObj?.["0"]);
}

export function zedCredentialHeaders(userId: string, accessToken: string, systemId: string): Record<string, string> {
  return {
    authorization: `${userId} ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json",
    [ZED_SYSTEM_ID_HEADER]: systemId,
    [ZED_VERSION_HEADER]: ZED_VERSION,
  };
}

export async function mintLlmToken(
  userId: string,
  accessToken: string,
  systemId: string,
  organizationId: string | null,
  network: PluginContext["network"],
): Promise<{ llmToken: string; llmTokenExpiresAtMs: number | null }> {
  const body = organizationId ? { organization_id: organizationId } : {};
  const response = await network.fetch(`${ZED_CLOUD_BASE_URL}/client/llm_tokens`, {
    method: "POST",
    headers: zedCredentialHeaders(userId, accessToken, systemId),
    body: JSON.stringify(body),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Zed LLM token request failed (HTTP ${response.status}): ${response.body}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("Zed LLM token endpoint returned invalid JSON");
  }
  const llmToken = extractLlmToken(parsed);
  if (!llmToken) {
    throw new Error("Zed LLM token response did not include a token");
  }
  return {
    llmToken,
    llmTokenExpiresAtMs: jwtExpiresAtMs(llmToken) ?? (Date.now() + 50 * 60 * 1000),
  };
}

export async function syncAccountProfile(
  candidate: CredentialCandidate,
  network: PluginContext["network"],
): Promise<CredentialCandidate> {
  const systemId = candidate.systemId ?? crypto.randomUUID();
  let displayName = candidate.displayName ?? null;
  let organizationId = candidate.organizationId ?? null;
  let quota = candidate.quota ?? null;
  let llmToken = candidate.llmToken ?? null;
  let llmTokenExpiresAtMs = candidate.llmTokenExpiresAtMs ?? null;

  if (candidate.userId !== "jwt") {
    const meResponse = await network.fetch(`${ZED_CLOUD_BASE_URL}/client/users/me`, {
      method: "GET",
      headers: zedCredentialHeaders(candidate.userId, candidate.accessToken, systemId),
    });
    if (meResponse.status >= 200 && meResponse.status < 300) {
      try {
        const parsed = parseAuthenticatedUserResponse(JSON.parse(meResponse.body));
        displayName = parsed.displayName ?? displayName;
        organizationId = parsed.organizationId ?? organizationId;
        quota = parsed.quota;
      } catch {
        // Keep fallback metadata
      }
    } else if (meResponse.status === 401) {
      throw new Error("Zed credentials rejected by cloud.zed.dev (HTTP 401)");
    }

    try {
      const minted = await mintLlmToken(
        candidate.userId,
        candidate.accessToken,
        systemId,
        organizationId,
        network,
      );
      llmToken = minted.llmToken;
      llmTokenExpiresAtMs = minted.llmTokenExpiresAtMs;
    } catch {
      // Token can be minted lazily on model discovery or invocation.
    }
  }

  return {
    userId: candidate.userId,
    accessToken: candidate.accessToken,
    systemId,
    organizationId,
    displayName,
    llmToken,
    llmTokenExpiresAtMs,
    quota,
  };
}

export async function ensureLlmToken(
  data: AccountData,
  network: PluginContext["network"],
  forceRefresh = false,
): Promise<{ llmToken: string; updatedData: AccountData | null }> {
  if (!forceRefresh && data.llmToken && !isLlmTokenExpired(data)) {
    return { llmToken: data.llmToken, updatedData: null };
  }
  if (data.userId === "jwt") {
    return { llmToken: data.accessToken, updatedData: null };
  }

  let organizationId = data.organizationId;
  let displayName = data.displayName;
  let quota = data.quota;

  if (!organizationId) {
    const meResponse = await network.fetch(`${ZED_CLOUD_BASE_URL}/client/users/me`, {
      method: "GET",
      headers: zedCredentialHeaders(data.userId, data.accessToken, data.systemId),
    });
    if (meResponse.status === 401) {
      throw new Error("HTTP 401: Zed account credentials are invalid or expired");
    }
    if (meResponse.status >= 200 && meResponse.status < 300) {
      const parsed = parseAuthenticatedUserResponse(JSON.parse(meResponse.body));
      organizationId = parsed.organizationId ?? organizationId;
      displayName = parsed.displayName ?? displayName;
      quota = parsed.quota;
    }
  }

  const minted = await mintLlmToken(
    data.userId,
    data.accessToken,
    data.systemId,
    organizationId,
    network,
  );
  const updatedData: AccountData = {
    ...data,
    organizationId,
    displayName,
    llmToken: minted.llmToken,
    llmTokenExpiresAtMs: minted.llmTokenExpiresAtMs,
    quota,
  };
  return { llmToken: minted.llmToken, updatedData };
}

async function tokenFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest).slice(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function credentialDraft(candidate: CredentialCandidate): Promise<ResourceDraft> {
  const fingerprint = await tokenFingerprint(`${candidate.userId}:${candidate.accessToken}`);
  const identity = candidate.userId !== "jwt" ? candidate.userId : fingerprint;
  const displayName = candidate.displayName ??
    (candidate.userId !== "jwt" ? `Zed #${candidate.userId}` : `Zed Token (${fingerprint.slice(0, 6)})`);
  const data: AccountData = {
    userId: candidate.userId,
    accessToken: candidate.accessToken,
    systemId: candidate.systemId ?? crypto.randomUUID(),
    organizationId: candidate.organizationId ?? null,
    displayName,
    llmToken: candidate.llmToken ?? (candidate.userId === "jwt" ? candidate.accessToken : null),
    llmTokenExpiresAtMs: candidate.llmTokenExpiresAtMs ??
      (candidate.userId === "jwt" ? jwtExpiresAtMs(candidate.accessToken) : null),
    quota: candidate.quota ?? null,
  };
  return {
    key: `zed:${identity}`,
    privateData: data as unknown as JsonValue,
  };
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = object(resource.privateData);
  const userId = text(data?.userId);
  const accessToken = text(data?.accessToken);
  if (!userId || !accessToken) {
    throw new Error("Zed account resource is missing userId or accessToken");
  }
  return {
    userId,
    accessToken,
    systemId: text(data?.systemId) ?? crypto.randomUUID(),
    organizationId: text(data?.organizationId),
    displayName: text(data?.displayName) ?? `Zed #${userId}`,
    llmToken: text(data?.llmToken),
    llmTokenExpiresAtMs: typeof data?.llmTokenExpiresAtMs === "number"
      ? data.llmTokenExpiresAtMs
      : null,
    quota: (data?.quota ?? null) as ZedQuota | null,
  };
}

export function quotaState(quota: ZedQuota | null, nowMs = Date.now()): ResourceState {
  if (!quota || !quota.limitReached) return { status: "ready" };
  const coolingUntil = quota.coolingUntilMs;
  if (coolingUntil !== null && coolingUntil > nowMs) {
    return {
      status: "cooling",
      retryAtMs: coolingUntil,
      message: "Zed rate limit or monthly spending limit reached",
    };
  }
  return { status: "ready" };
}

export function quotaExhaustedPatch(
  data: AccountData,
  error?: string,
  nowMs = Date.now(),
): ResourcePatch {
  let retryAfterMs = 60 * 1000;
  if (error) {
    const match = error.match(/retry(?:_after|\s+after)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        retryAfterMs = Math.ceil(parsed * 1000);
      }
    }
  }
  const coolingUntilMs = nowMs + Math.max(5_000, retryAfterMs);
  const quota: ZedQuota = {
    plan: data.quota?.plan ?? "zed_student",
    planLabel: data.quota?.planLabel ?? "Zed",
    subscriptionStartedAtMs: data.quota?.subscriptionStartedAtMs ?? null,
    subscriptionEndedAtMs: data.quota?.subscriptionEndedAtMs ?? null,
    editPredictionsUsed: data.quota?.editPredictionsUsed ?? null,
    editPredictionsLimit: data.quota?.editPredictionsLimit ?? null,
    hasOverdueInvoices: data.quota?.hasOverdueInvoices ?? false,
    limitReached: true,
    coolingUntilMs,
    updatedAtMs: nowMs,
  };
  return {
    privateData: { ...data, quota } as unknown as JsonValue,
    state: quotaState(quota, nowMs),
  };
}

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const metrics: ResourceMetric[] = [];
  if (
    data.quota &&
    typeof data.quota.editPredictionsUsed === "number" &&
    typeof data.quota.editPredictionsLimit === "number" &&
    data.quota.editPredictionsLimit > 0
  ) {
    const remainingPct = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          ((data.quota.editPredictionsLimit - data.quota.editPredictionsUsed) /
            data.quota.editPredictionsLimit) * 100,
        ),
      ),
    );
    metrics.push({
      id: "edit-predictions",
      label: { "en-US": "Edit Predictions", "zh-CN": "预测额度" },
      unit: "percent",
      value: remainingPct,
      ...(data.quota.subscriptionEndedAtMs ? { resetAtMs: data.quota.subscriptionEndedAtMs } : {}),
    });
  }
  return {
    displayName: data.displayName,
    ...(data.quota?.planLabel ? { description: data.quota.planLabel } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

export async function refreshAccount(
  resource: ResourceSnapshot,
  context: PluginContext,
): Promise<ResourcePatch> {
  const data = accountData(resource);
  if (data.userId === "jwt") {
    if (isLlmTokenExpired(data, 0)) {
      return {
        state: {
          status: "invalid",
          message: "Zed JWT token has expired; please sign in or import a new credential",
        },
      };
    }
    return { state: { status: "ready" } };
  }

  const meResponse = await context.network.fetch(`${ZED_CLOUD_BASE_URL}/client/users/me`, {
    method: "GET",
    headers: zedCredentialHeaders(data.userId, data.accessToken, data.systemId),
  });
  if (meResponse.status === 401) {
    return {
      state: {
        status: "invalid",
        message: "Zed authorization expired or revoked; please sign in again",
      },
    };
  }
  if (meResponse.status < 200 || meResponse.status >= 300) {
    return { state: { status: "ready" } };
  }

  const parsed = parseAuthenticatedUserResponse(JSON.parse(meResponse.body));
  const organizationId = parsed.organizationId ?? data.organizationId;
  let llmToken = data.llmToken;
  let llmTokenExpiresAtMs = data.llmTokenExpiresAtMs;

  try {
    const minted = await mintLlmToken(
      data.userId,
      data.accessToken,
      data.systemId,
      organizationId,
      context.network,
    );
    llmToken = minted.llmToken;
    llmTokenExpiresAtMs = minted.llmTokenExpiresAtMs;
  } catch {
    // Keep existing llmToken if minting fails transiently
  }

  const updatedData: AccountData = {
    ...data,
    displayName: parsed.displayName ?? data.displayName,
    organizationId,
    llmToken,
    llmTokenExpiresAtMs,
    quota: parsed.quota,
  };
  return {
    privateData: updatedData as unknown as JsonValue,
    state: { status: "ready" },
  };
}

function collectJsonCandidates(value: unknown, output: CredentialCandidate[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonCandidates(item, output);
    return;
  }
  const obj = object(value);
  if (!obj) return;
  for (const key of ["accounts", "credentials", "items"]) {
    if (Array.isArray(obj[key])) {
      collectJsonCandidates(obj[key], output);
      return;
    }
  }
  const userId = text(obj.user_id ?? obj.userId ?? obj.id);
  const accessToken = text(obj.access_token ?? obj.accessToken ?? obj.token);
  const organizationId = text(obj.organization_id ?? obj.organizationId);
  const displayName = text(obj.github_login ?? obj.username ?? obj.displayName ?? obj.name);
  const systemId = text(obj.system_id ?? obj.systemId);
  if (userId && accessToken) {
    output.push({ userId, accessToken, organizationId, displayName, systemId });
  } else if (accessToken && accessToken.split(".").length === 3) {
    output.push({
      userId: "jwt",
      accessToken,
      llmToken: accessToken,
      llmTokenExpiresAtMs: jwtExpiresAtMs(accessToken),
      displayName,
    });
  }
}

export function parseCredentialFiles(files: ResourceImportFile[]): {
  credentials: CredentialCandidate[];
  warnings: string[];
} {
  const credentials: CredentialCandidate[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const raw = file.content.trim();
    if (!raw) continue;

    // 1. Space-separated "<user_id> <access_token>" (Zed Authorization header / keychain format)
    const spaceMatch = raw.match(/^(\d+)\s+([A-Za-z0-9_-]{16,})$/);
    if (spaceMatch?.[1] && spaceMatch?.[2]) {
      credentials.push({
        userId: spaceMatch[1],
        accessToken: spaceMatch[2],
      });
      continue;
    }

    // 2. Raw JWT LLM token
    if (raw.split(".").length === 3 && !raw.includes(" ") && !raw.includes("\n")) {
      credentials.push({
        userId: "jwt",
        accessToken: raw,
        llmToken: raw,
        llmTokenExpiresAtMs: jwtExpiresAtMs(raw),
      });
      continue;
    }

    // 3. JSON object or array
    try {
      const parsed = JSON.parse(raw);
      const found: CredentialCandidate[] = [];
      collectJsonCandidates(parsed, found);
      if (found.length > 0) {
        credentials.push(...found);
        continue;
      }
      warnings.push(`${file.name}: JSON does not contain Zed user_id and access_token`);
      continue;
    } catch {
      // Fall through to .env parsing
    }

    // 4. Environment variables (ZED_USER_ID / ZED_ACCESS_TOKEN)
    const userIdMatch = raw.match(/(?:ZED_USER_ID|USER_ID)\s*=\s*["']?([^"'\r\n]+)/i);
    const tokenMatch = raw.match(/(?:ZED_ACCESS_TOKEN|ACCESS_TOKEN)\s*=\s*["']?([^"'\r\n]+)/i);
    if (userIdMatch?.[1] && tokenMatch?.[1]) {
      credentials.push({
        userId: userIdMatch[1].trim(),
        accessToken: tokenMatch[1].trim(),
      });
      continue;
    }

    warnings.push(`${file.name}: unrecognized Zed credential format`);
  }

  return { credentials, warnings };
}

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import Zed Credentials",
    "zh-CN": "导入 Zed 凭证",
  },
  description: {
    "en-US":
      "Import a JSON, TXT, or .env file containing Zed user_id and access_token (or `<user_id> <access_token>`).",
    "zh-CN":
      "导入包含 Zed user_id 与 access_token（或 `<user_id> <access_token>` 格式）的 JSON、TXT 或 .env 文件。",
  },
  accept: [".json", ".txt", ".env", ".key"],
  multiple: true,
  parse: async (
    files: ResourceImportFile[],
    context: PluginContext,
  ): Promise<ResourceImportResult> => {
    const { credentials, warnings } = parseCredentialFiles(files);
    if (credentials.length === 0) {
      throw new Error(
        warnings.join("; ") || "credential file does not contain valid Zed credentials",
      );
    }
    const drafts = await Promise.all(
      credentials.map(async (candidate) => {
        try {
          const synced = await syncAccountProfile(candidate, context.network);
          return credentialDraft(synced);
        } catch {
          return credentialDraft(candidate);
        }
      }),
    );
    return {
      resources: drafts,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
