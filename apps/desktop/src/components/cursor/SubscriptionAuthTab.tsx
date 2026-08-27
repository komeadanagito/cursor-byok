import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { Select } from "../ui/Select";
import { checkIcon, grokIcon, openAiIcon, trashIcon } from "../ui/icons";
import { GrokAuthModal } from "./GrokAuthModal";
import { CodexAuthModal } from "./CodexAuthModal";
import { useAppStore, appStore } from "../../store/appStore";
import { useMessage } from "../ui/message";
import { api, type Model, type ModelInput, type SubscriptionAccount, type SubscriptionUsage } from "../../api";
import { contextWindowForModel } from "../../utils/modelContext";
import styles from "./SubscriptionAuthTab.module.scss";

const GROK_BASE_URL = "https://api.x.ai/v1";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_DISCOVERY_URL = "https://chatgpt.com/backend-api/codex";
const IMPORT_CHUNK_SIZE = 40;

export function isSubscriptionModel(m: { base_url?: string; tooltip_data?: string }): boolean {
  return Boolean(
    m.base_url?.includes("api.x.ai") ||
    m.tooltip_data?.includes("xAI") ||
    m.tooltip_data?.includes("Grok") ||
    m.tooltip_data?.includes("Codex") ||
    m.tooltip_data?.includes("ChatGPT") ||
    m.tooltip_data?.includes("OAuth")
  );
}

export function SubscriptionAuthTab({
  children,
  onSwitchToModels,
}: {
  children?: ReactNode;
  onSwitchToModels?: () => void;
}) {
  const { models } = useAppStore();
  const message = useMessage();
  const [grokModalOpen, setGrokModalOpen] = useState(false);
  const [checkingGrok, setCheckingGrok] = useState(false);
  const [grokAccounts, setGrokAccounts] = useState<SubscriptionAccount[]>([]);
  const [grokUsage, setGrokUsage] = useState<SubscriptionUsage | null>(null);
  const [grokUsageError, setGrokUsageError] = useState<string | null>(null);
  const [codexModalOpen, setCodexModalOpen] = useState(false);
  const [checkingCodex, setCheckingCodex] = useState(false);
  const [codexAccounts, setCodexAccounts] = useState<SubscriptionAccount[]>([]);
  const [codexUsage, setCodexUsage] = useState<SubscriptionUsage | null>(null);
  const [codexUsageError, setCodexUsageError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<"grok" | "codex" | null>(null);
  const [importing, setImporting] = useState<"grok" | "codex" | null>(null);
  const grokImportInput = useRef<HTMLInputElement>(null);
  const codexImportInput = useRef<HTMLInputElement>(null);

  const grokModels = models.filter(
    (m) => Boolean(m.base_url?.includes("api.x.ai") || m.model_id?.toLowerCase().includes("grok"))
  );
  const isGrokConnected = grokAccounts.length > 0;
  const activeGrok = grokAccounts.find((account) => account.active) ?? grokAccounts[0];

  const codexModels = models.filter(
    (m) => Boolean(
      m.tooltip_data?.includes("Codex") ||
      m.tooltip_data?.includes("ChatGPT")
    )
  );
  const isCodexConnected = codexAccounts.length > 0;
  const activeCodex = codexAccounts.find((account) => account.active) ?? codexAccounts[0];

  const loadGrokAccounts = async () => {
    setGrokAccounts(await api.grokAccounts());
  };

  const loadCodexAccounts = async () => {
    setCodexAccounts(await api.codexAccounts());
  };

  const loadGrokUsage = async () => {
    setCheckingGrok(true);
    setGrokUsageError(null);
    try {
      setGrokUsage(await api.grokUsage());
      await loadGrokAccounts();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      setGrokUsage(null);
      setGrokUsageError(error);
      message(t("额度查询失败：{error}", { error }));
    } finally {
      setCheckingGrok(false);
    }
  };

  const loadCodexUsage = async () => {
    setCheckingCodex(true);
    setCodexUsageError(null);
    try {
      setCodexUsage(await api.codexUsage());
      await loadCodexAccounts();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      setCodexUsage(null);
      setCodexUsageError(error);
      message(t("额度查询失败：{error}", { error }));
    } finally {
      setCheckingCodex(false);
    }
  };

  useEffect(() => {
    void loadGrokAccounts();
    void loadCodexAccounts();
  }, []);

  useEffect(() => {
    if (isGrokConnected) void loadGrokUsage();
    else {
      setGrokUsage(null);
      setGrokUsageError(null);
    }
  }, [isGrokConnected, activeGrok?.account_id]);

  useEffect(() => {
    if (isCodexConnected) void loadCodexUsage();
    else {
      setCodexUsage(null);
      setCodexUsageError(null);
    }
  }, [isCodexConnected, activeCodex?.account_id]);

  const handleGrokAuthSuccess = async (accessToken: string, refreshToken?: string | null) => {
    try {
      await api.saveGrokAccount(accessToken, refreshToken);
      if (grokModels.length === 0) {
        const synced = await syncDiscoveredModels({
          accessToken,
          discoveryUrl: GROK_BASE_URL,
          existing: grokModels,
          allModels: models,
          defaults: {
            base_url: GROK_BASE_URL,
            use_full_url: false,
            tooltip_data: "xAI Grok",
            openai_endpoint: "/v1/chat/completions",
            context_window_tokens: null,
            max_completion_tokens: 16384,
          },
        });
        message(t("Grok 账号授权成功，已同步添加 {count} 个官方模型！", { count: synced.created }));
        onSwitchToModels?.();
      } else {
        message(t("Grok 账号已保存，余额为 0 时将自动切换。"));
      }
      await loadGrokAccounts();
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleCodexAuthSuccess = async (accessToken: string, refreshToken?: string | null) => {
    try {
      await api.saveCodexAccount(accessToken, refreshToken);
      if (codexModels.length === 0) {
        const synced = await syncDiscoveredModels({
          accessToken,
          discoveryUrl: CODEX_DISCOVERY_URL,
          existing: codexModels,
          allModels: models,
          defaults: {
            base_url: CODEX_BASE_URL,
            use_full_url: true,
            tooltip_data: "ChatGPT / OpenAI Codex",
            openai_endpoint: "/v1/responses",
            context_window_tokens: 272000,
            max_completion_tokens: 128000,
          },
        });
        message(t("ChatGPT / Codex 账号授权成功，已同步添加 {count} 个官方模型！", { count: synced.created }));
        onSwitchToModels?.();
      } else {
        message(t("ChatGPT / Codex 账号已保存，余额为 0 时将自动切换。"));
      }
      await loadCodexAccounts();
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importCredentialFiles = async (provider: "grok" | "codex", fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setImporting(provider);
    try {
      const files: Array<{ name: string; content: unknown }> = [];
      const parseErrors: string[] = [];
      const seen = new Set<string>();
      let bootstrapToken: string | undefined;
      for (const file of Array.from(fileList)) {
        const seenKey = `${file.name}:${file.size}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        try {
          const text = (await file.text()).replace(/^\uFEFF/, "");
          const content = JSON.parse(text) as unknown;
          files.push({ name: file.name, content });
          bootstrapToken ??= firstAccessToken(content);
        } catch (cause) {
          parseErrors.push(`${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      const result = { imported: 0, skipped: 0, imported_names: [] as string[], errors: [] as Array<{ name: string; message: string }> };
      for (let index = 0; index < files.length; index += IMPORT_CHUNK_SIZE) {
        const chunk = await api.importAccounts(provider, files.slice(index, index + IMPORT_CHUNK_SIZE));
        result.imported += chunk.imported;
        result.skipped += chunk.skipped;
        result.imported_names.push(...(chunk.imported_names ?? []));
        result.errors.push(...chunk.errors);
      }
      if (provider === "grok") await loadGrokAccounts();
      else await loadCodexAccounts();
      if (provider === "grok" && grokModels.length === 0 && bootstrapToken) {
        await syncDiscoveredModels({
          accessToken: bootstrapToken,
          discoveryUrl: GROK_BASE_URL,
          existing: grokModels,
          allModels: models,
          defaults: {
            base_url: GROK_BASE_URL,
            use_full_url: false,
            tooltip_data: "xAI Grok",
            openai_endpoint: "/v1/chat/completions",
            context_window_tokens: null,
            max_completion_tokens: 16384,
          },
        });
      }
      if (provider === "codex" && codexModels.length === 0 && bootstrapToken) {
        await syncDiscoveredModels({
          accessToken: bootstrapToken,
          discoveryUrl: CODEX_DISCOVERY_URL,
          existing: codexModels,
          allModels: models,
          defaults: {
            base_url: CODEX_BASE_URL,
            use_full_url: true,
            tooltip_data: "ChatGPT / OpenAI Codex",
            openai_endpoint: "/v1/responses",
            context_window_tokens: 272000,
            max_completion_tokens: 128000,
          },
        });
      }
      const failed = result.errors.length + parseErrors.length;
      const importedNames = (result.imported_names ?? []).filter(Boolean);
      const names = importedNames.length <= 5
        ? importedNames.join("、")
        : t("{names} 等 {count} 个", { names: importedNames.slice(0, 3).join("、"), count: importedNames.length });
      const detail = [...result.errors.map(importErrorText), ...parseErrors].slice(0, 8).join("；");
      const duration = failed > 0 ? 8000 : 4000;
      if (result.imported > 0 && failed === 0) {
        message(
          names
            ? t("已导入 {count} 个账号：{names}。", { count: result.imported, names })
            : t("已导入 {count} 个账号。", { count: result.imported }),
          { duration },
        );
      } else if (result.imported > 0) {
        message(
          t("已导入 {imported} 个账号，失败 {failed} 个。{detail}", {
            imported: result.imported,
            failed,
            detail,
          }),
          { duration },
        );
      } else {
        message(t("导入失败：{error}", { error: detail || t("未找到可导入的凭证。") }), { duration });
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(null);
      if (provider === "grok" && grokImportInput.current) grokImportInput.current.value = "";
      if (provider === "codex" && codexImportInput.current) codexImportInput.current.value = "";
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.grid}>
        <div className={styles.card}>
          <div className={styles.cardTop}>
            <div className={styles.providerInfo}>
              <div className={styles.iconWrap}><Icon icon={grokIcon} size="1.35em" /></div>
              <div className={styles.names}>
                <strong>Grok (xAI)</strong>
                <span>xAI OAuth 2.0 Device Flow</span>
              </div>
            </div>
            <ConnectionBadge connected={isGrokConnected} />
          </div>
          <AccountBar
            accounts={grokAccounts}
            hint={
              grokAccounts.length > 1
                ? t("{count} 个账号，余额为 0 时自动切换", { count: grokAccounts.length })
                : t("余额为 0 时自动切换")
            }
            onSelect={async (accountId) => {
              await api.activateGrokAccount(accountId);
              await loadGrokAccounts();
            }}
            onDelete={() => setDeleting("grok")}
          />
          <UsageBox
            connected={isGrokConnected}
            loading={checkingGrok}
            usage={grokUsage}
            error={grokUsageError}
            modelCount={grokModels.length}
            onRefresh={() => void loadGrokUsage()}
          />
          <div className={styles.cardFooter}>
            <input
              ref={grokImportInput}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(event) => void importCredentialFiles("grok", event.target.files)}
            />
            <Button
              variant="secondary"
              disabled={importing !== null}
              onClick={() => grokImportInput.current?.click()}
            >
              {importing === "grok" ? t("导入中…") : t("批量导入")}
            </Button>
            <Button
              variant={isGrokConnected ? "secondary" : "primary"}
              onClick={() => setGrokModalOpen(true)}
            >
              {isGrokConnected ? t("添加账号") : t("立即登录授权")}
            </Button>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardTop}>
            <div className={styles.providerInfo}>
              <div className={styles.iconWrap}><Icon icon={openAiIcon} size="1.35em" /></div>
              <div className={styles.names}>
                <strong>Codex (ChatGPT / OpenAI)</strong>
                <span>OpenAI OAuth 2.0 Device Flow</span>
              </div>
            </div>
            <ConnectionBadge connected={isCodexConnected} />
          </div>
          <AccountBar
            accounts={codexAccounts}
            hint={
              codexAccounts.length > 1
                ? t("{count} 个账号，5 小时或周额度用尽时自动切换", { count: codexAccounts.length })
                : t("5 小时或周额度用尽时自动切换")
            }
            onSelect={async (accountId) => {
              await api.activateCodexAccount(accountId);
              await loadCodexAccounts();
            }}
            onDelete={() => setDeleting("codex")}
          />
          <UsageBox
            connected={isCodexConnected}
            loading={checkingCodex}
            usage={codexUsage}
            error={codexUsageError}
            modelCount={codexModels.length}
            onRefresh={() => void loadCodexUsage()}
          />
          <div className={styles.cardFooter}>
            <input
              ref={codexImportInput}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(event) => void importCredentialFiles("codex", event.target.files)}
            />
            <Button
              variant="secondary"
              disabled={importing !== null}
              onClick={() => codexImportInput.current?.click()}
            >
              {importing === "codex" ? t("导入中…") : t("批量导入")}
            </Button>
            <Button
              variant={isCodexConnected ? "secondary" : "primary"}
              onClick={() => setCodexModalOpen(true)}
            >
              {isCodexConnected ? t("添加账号") : t("立即登录授权")}
            </Button>
          </div>
        </div>
      </div>

      {children && (
        <div className={styles.modelsSection}>
          {children}
        </div>
      )}

      <GrokAuthModal
        open={grokModalOpen}
        onClose={() => setGrokModalOpen(false)}
        onSuccess={handleGrokAuthSuccess}
      />

      <CodexAuthModal
        open={codexModalOpen}
        onClose={() => setCodexModalOpen(false)}
        onSuccess={handleCodexAuthSuccess}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={t("删除账号")}
        cancelLabel={t("取消")}
        confirmLabel={t("删除")}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void (async () => {
          if (deleting === "grok" && activeGrok) {
            setGrokAccounts(await api.deleteGrokAccount(activeGrok.account_id));
          }
          if (deleting === "codex" && activeCodex) {
            setCodexAccounts(await api.deleteCodexAccount(activeCodex.account_id));
          }
          setDeleting(null);
        })()}
      >
        <p>{t("确定删除当前授权账号吗？")}</p>
      </ConfirmDialog>
    </div>
  );
}

function AccountBar({
  accounts,
  hint,
  onSelect,
  onDelete,
}: {
  accounts: SubscriptionAccount[];
  hint: string;
  onSelect: (accountId: string) => void | Promise<void>;
  onDelete: () => void;
}) {
  if (accounts.length === 0) return null;
  const active = accounts.find((account) => account.active) ?? accounts[0];
  return (
    <div className={styles.accountBar}>
      <div className={styles.accountSelect}>
        <Select
          ariaLabel={t("当前账号")}
          searchable
          value={active.account_id}
          options={accounts.map((account) => ({
            value: account.account_id,
            label: accountLabel(account),
          }))}
          onChange={(accountId) => void onSelect(accountId)}
        />
      </div>
      <Button size="small" variant="secondary" onClick={onDelete}>
        <Icon icon={trashIcon} size="1em" />
      </Button>
      <span className={styles.accountHint}>{hint}</span>
    </div>
  );
}

function importErrorText(error: { name: string; message: string }): string {
  const message = error.message.replace(/^(configuration error|config error):\s*/i, "");
  return message.includes(error.name) ? message : `${error.name}: ${message}`;
}

function firstAccessToken(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = firstAccessToken(item);
      if (token) return token;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.access_token === "string" && record.access_token.trim()) {
    return record.access_token.trim();
  }
  if (typeof record.key === "string" && record.key.trim()) {
    return record.key.trim();
  }
  if (record.tokens && typeof record.tokens === "object") {
    const tokens = record.tokens as Record<string, unknown>;
    if (typeof tokens.access_token === "string" && tokens.access_token.trim()) {
      return tokens.access_token.trim();
    }
  }
  return undefined;
}

function accountLabel(account: SubscriptionAccount): string {
  const weekly = account.remaining_percent;
  const session = account.session_remaining_percent;
  if (account.provider === "codex" && session != null) {
    const weeklyLabel = weekly == null ? t("未知") : `${Math.round(weekly)}%`;
    return `${account.display_name} · 5h ${Math.round(session)}% · ${weeklyLabel}`;
  }
  if (weekly == null) return account.display_name;
  return `${account.display_name} · ${Math.round(weekly)}%`;
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`${styles.badge} ${connected ? styles.badgeConnected : styles.badgeAvailable}`}>
      {connected ? (
        <>
          <Icon icon={checkIcon} size="0.9em" /> {t("已连接")}
        </>
      ) : (
        t("支持登录")
      )}
    </span>
  );
}

function UsageBox({
  connected,
  loading,
  usage,
  error,
  modelCount,
  onRefresh,
}: {
  connected: boolean;
  loading: boolean;
  usage: SubscriptionUsage | null;
  error: string | null;
  modelCount: number;
  onRefresh: () => void;
}) {
  const remaining = usage?.remaining_percent ?? null;
  const tone = remainingTone(remaining);
  const planText = !connected
    ? t("未授权")
    : error && !usage
      ? t("查询失败")
      : !usage
        ? t("查询中…")
        : usage.plan_label || t("未知");
  const remainingText = !connected
    ? t("未激活")
    : error && remaining === null
      ? t("查询失败")
      : remaining === null
        ? t("查询中…")
        : formatPercent(remaining);
  return (
    <div className={styles.cardBody}>
      <div className={styles.balanceBox}>
        <div className={styles.balanceHeader}>
          <strong>{t("周额度与剩余额度")}</strong>
          {connected && (
            <Button size="small" variant="secondary" disabled={loading} onClick={onRefresh}>
              {loading ? t("查询中…") : t("刷新额度")}
            </Button>
          )}
        </div>

        {connected && remaining !== null && (
          <div className={styles.progressBarWrap}>
            <div className={styles.progressBarHeader}>
              <span>{t("本周剩余额度")}</span>
              <span className={styles[tone]}>{formatPercent(remaining)}</span>
            </div>
            <div className={styles.progressTrack}>
              <div className={`${styles.progressFill} ${styles[`${tone}Fill`]}`} style={{ width: `${remaining}%` }} />
            </div>
          </div>
        )}

        <div className={styles.balanceList}>
          <div className={styles.balanceRow}>
            <span>{t("周额度上限")}</span>
            <span>{planText}</span>
          </div>
          <div className={styles.balanceRow}>
            <span>{t("本周剩余额度")}</span>
            <span className={connected && remaining !== null ? styles[tone] : undefined}>{remainingText}</span>
          </div>
          {connected && usage?.session_remaining_percent !== null && usage?.session_remaining_percent !== undefined && (
            <div className={styles.balanceRow}>
              <span>{t("5 小时窗口剩余")}</span>
              <span>{formatPercent(usage.session_remaining_percent)}</span>
            </div>
          )}
          <div className={styles.balanceRow}>
            <span>{t("额度重置时间")}</span>
            <span>{connected ? formatReset(usage?.reset_at_ms ?? null) : t("未知")}</span>
          </div>
          <div className={styles.balanceRow}>
            <span>{t("已接入模型")}</span>
            <span>{modelCount > 0 ? t("{count} 个模型", { count: modelCount }) : t("0 个")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function remainingTone(remaining: number | null): "usageOk" | "usageWarn" | "usageBad" {
  if (remaining === null) return "usageOk";
  if (remaining <= 10) return "usageBad";
  if (remaining <= 30) return "usageWarn";
  return "usageOk";
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatReset(ms: number | null): string {
  if (!ms) return t("未知");
  return new Date(ms).toLocaleString();
}

function modelInputFrom(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return input;
}

async function syncDiscoveredModels({
  accessToken,
  discoveryUrl,
  existing,
  allModels,
  defaults,
}: {
  accessToken: string;
  discoveryUrl: string;
  existing: Model[];
  allModels: Model[];
  defaults: Pick<ModelInput, "base_url" | "use_full_url" | "tooltip_data" | "openai_endpoint" | "context_window_tokens" | "max_completion_tokens">;
}): Promise<{ created: number; updated: number }> {
  const result = await api.discoverModels({
    type: "openai",
    base_url: discoveryUrl,
    api_key: accessToken,
    custom_headers_enabled: false,
    custom_headers: {},
  });
  const discovered = result.models
    .map((model) => ({ id: model.id.trim(), context_window_tokens: model.context_window_tokens }))
    .filter((model) => model.id);
  const modelIds = [...new Set(discovered.map((model) => model.id))];
  const contextById = new Map(discovered.map((model) => [model.id, model.context_window_tokens]));
  if (modelIds.length === 0) {
    throw new Error(t("未从官方接口获取到可用模型。"));
  }

  for (const model of existing) {
    await appStore.updateCursorModel(model.model_hash, {
      ...modelInputFrom(model),
      api_key: accessToken,
      type: "openai",
      base_url: defaults.base_url,
      use_full_url: defaults.use_full_url,
      openai_endpoint: defaults.openai_endpoint,
      tooltip_data: defaults.tooltip_data,
      context_window_tokens: contextWindowForModel(
        model.model_id,
        contextById.get(model.model_id),
        model.context_window_tokens ?? defaults.context_window_tokens,
      ),
    });
  }

  const existingIds = new Set(existing.map((model) => model.model_id));
  const toCreate = modelIds.filter((modelId) => !existingIds.has(modelId));
  if (toCreate.length > 0) {
    const created = await appStore.createModels(
      toCreate.map((modelId, idx) => ({
        sort_order: allModels.length + idx + 1,
        display_name: modelId,
        type: "openai",
        base_url: defaults.base_url,
        use_full_url: defaults.use_full_url,
        api_key: accessToken,
        tooltip_data: defaults.tooltip_data,
        model_id: modelId,
        reasoning_effort: null,
        openai_endpoint: defaults.openai_endpoint,
        openai_extra_params_enabled: false,
        openai_extra_params: {},
        custom_headers_enabled: false,
        custom_headers: {},
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: {},
        context_window_tokens: contextWindowForModel(
          modelId,
          contextById.get(modelId),
          defaults.context_window_tokens,
        ),
        max_completion_tokens: defaults.max_completion_tokens,
        anthropic_max_tokens: null,
        anthropic_thinking_effort: "xhigh",
        thinking_budget_tokens: null,
      })),
    );
    if (!created) {
      throw new Error(t("保存模型失败"));
    }
  }

  return { created: toCreate.length, updated: existing.length };
}
