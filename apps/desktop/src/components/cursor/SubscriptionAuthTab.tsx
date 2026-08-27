import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";
import { TextInput } from "../ui/FormControls";
import { checkIcon, copyIcon, grokIcon, openAiIcon, refreshIcon, trashIcon } from "../ui/icons";
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

  const [deletingAccount, setDeletingAccount] = useState<{ provider: "grok" | "codex"; account: SubscriptionAccount } | null>(null);
  const [clearingCooldown, setClearingCooldown] = useState<"grok" | "codex" | null>(null);
  const [importing, setImporting] = useState<"grok" | "codex" | null>(null);

  const [grokSearch, setGrokSearch] = useState("");
  const [codexSearch, setCodexSearch] = useState("");

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
            reasoning_effort: null,
            anthropic_max_tokens: null,
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
            reasoning_effort: null,
            anthropic_max_tokens: null,
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
            reasoning_effort: null,
            anthropic_max_tokens: null,
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
            reasoning_effort: null,
            anthropic_max_tokens: null,
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

  const handleActivateAccount = async (provider: "grok" | "codex", accountId: string) => {
    if (provider === "grok") {
      await api.activateGrokAccount(accountId);
      await loadGrokAccounts();
    } else {
      await api.activateCodexAccount(accountId);
      await loadCodexAccounts();
    }
    message(t("已切换活跃账号"));
  };

  const handleDeleteConfirmed = async () => {
    if (!deletingAccount) return;
    const { provider, account } = deletingAccount;
    if (provider === "grok") {
      setGrokAccounts(await api.deleteGrokAccount(account.account_id));
    } else {
      setCodexAccounts(await api.deleteCodexAccount(account.account_id));
    }
    setDeletingAccount(null);
    message(t("账号已删除"));
  };

  const handleClearCooldownConfirmed = async () => {
    if (!clearingCooldown) return;
    const provider = clearingCooldown;
    const accounts = provider === "grok" ? grokAccounts : codexAccounts;
    const cooldownAccounts = accounts.filter(isAccountCooldown);
    for (const acc of cooldownAccounts) {
      if (provider === "grok") await api.deleteGrokAccount(acc.account_id);
      else await api.deleteCodexAccount(acc.account_id);
    }
    if (provider === "grok") await loadGrokAccounts();
    else await loadCodexAccounts();
    setClearingCooldown(null);
    message(t("已清理 {count} 个冷却账号", { count: cooldownAccounts.length }));
  };

  return (
    <div className={styles.root}>
      <div className={styles.boardList}>
        {/* Grok (xAI) 账号看板 */}
        <ProviderKanbanBoard
          provider="grok"
          title="Grok (xAI)"
          subtitle="xAI OAuth 2.0 Device Flow"
          icon={<Icon icon={grokIcon} size="1.35em" />}
          connected={isGrokConnected}
          accounts={grokAccounts}
          usage={grokUsage}
          usageError={grokUsageError}
          loadingUsage={checkingGrok}
          searchKeyword={grokSearch}
          onSearchChange={setGrokSearch}
          onRefreshUsage={() => void loadGrokUsage()}
          onActivate={(id) => void handleActivateAccount("grok", id)}
          onDelete={(acc) => setDeletingAccount({ provider: "grok", account: acc })}
          onClearCooldown={() => setClearingCooldown("grok")}
          onOpenModal={() => setGrokModalOpen(true)}
          onImportClick={() => grokImportInput.current?.click()}
          importing={importing === "grok"}
          importInputRef={grokImportInput}
          onImportFiles={(files) => void importCredentialFiles("grok", files)}
        />

        {/* Codex (ChatGPT / OpenAI) 账号看板 */}
        <ProviderKanbanBoard
          provider="codex"
          title="Codex (ChatGPT / OpenAI)"
          subtitle="OpenAI OAuth 2.0 Device Flow"
          icon={<Icon icon={openAiIcon} size="1.35em" />}
          connected={isCodexConnected}
          accounts={codexAccounts}
          usage={codexUsage}
          usageError={codexUsageError}
          loadingUsage={checkingCodex}
          searchKeyword={codexSearch}
          onSearchChange={setCodexSearch}
          onRefreshUsage={() => void loadCodexUsage()}
          onActivate={(id) => void handleActivateAccount("codex", id)}
          onDelete={(acc) => setDeletingAccount({ provider: "codex", account: acc })}
          onClearCooldown={() => setClearingCooldown("codex")}
          onOpenModal={() => setCodexModalOpen(true)}
          onImportClick={() => codexImportInput.current?.click()}
          importing={importing === "codex"}
          importInputRef={codexImportInput}
          onImportFiles={(files) => void importCredentialFiles("codex", files)}
        />
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
        open={deletingAccount !== null}
        title={t("删除账号")}
        cancelLabel={t("取消")}
        confirmLabel={t("删除")}
        onCancel={() => setDeletingAccount(null)}
        onConfirm={() => void handleDeleteConfirmed()}
      >
        <p>
          {deletingAccount
            ? t("确定删除账号“{name}”吗？此操作不可撤销。", { name: deletingAccount.account.display_name })
            : t("确定删除此账号吗？")}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={clearingCooldown !== null}
        title={t("清理冷却/耗尽账号")}
        cancelLabel={t("取消")}
        confirmLabel={t("清理全部")}
        onCancel={() => setClearingCooldown(null)}
        onConfirm={() => void handleClearCooldownConfirmed()}
      >
        <p>{t("确定从账号池中清理所有额度耗尽（0%）的冷却账号吗？")}</p>
      </ConfirmDialog>
    </div>
  );
}

function isAccountCooldown(account: SubscriptionAccount): boolean {
  if (account.limit_reached) return true;
  if (account.remaining_percent !== null && account.remaining_percent <= 0) return true;
  if (account.session_remaining_percent !== null && account.session_remaining_percent <= 0) return true;
  return false;
}

function ProviderKanbanBoard({
  provider,
  title,
  subtitle,
  icon,
  connected,
  accounts,
  usage,
  usageError,
  loadingUsage,
  searchKeyword,
  onSearchChange,
  onRefreshUsage,
  onActivate,
  onDelete,
  onClearCooldown,
  onOpenModal,
  onImportClick,
  importing,
  importInputRef,
  onImportFiles,
}: {
  provider: "grok" | "codex";
  title: string;
  subtitle: string;
  icon: ReactNode;
  connected: boolean;
  accounts: SubscriptionAccount[];
  usage: SubscriptionUsage | null;
  usageError: string | null;
  loadingUsage: boolean;
  searchKeyword: string;
  onSearchChange: (keyword: string) => void;
  onRefreshUsage: () => void;
  onActivate: (accountId: string) => void;
  onDelete: (account: SubscriptionAccount) => void;
  onClearCooldown: () => void;
  onOpenModal: () => void;
  onImportClick: () => void;
  importing: boolean;
  importInputRef: React.RefObject<HTMLInputElement | null>;
  onImportFiles: (files: FileList | null) => void;
}) {
  const message = useMessage();
  const keyword = searchKeyword.trim().toLowerCase();
  const filteredAccounts = accounts.filter(
    (acc) =>
      !keyword ||
      acc.display_name.toLowerCase().includes(keyword) ||
      acc.account_id.toLowerCase().includes(keyword)
  );

  // 状态三分类：可用池、冷却池（0%）、异常池
  const readyAccounts: SubscriptionAccount[] = [];
  const cooldownAccounts: SubscriptionAccount[] = [];
  const errorAccounts: SubscriptionAccount[] = [];

  for (const acc of filteredAccounts) {
    if (acc.active && usageError && !usage) {
      errorAccounts.push(acc);
    } else if (isAccountCooldown(acc)) {
      cooldownAccounts.push(acc);
    } else {
      readyAccounts.push(acc);
    }
  }

  // 排序：可用池活跃账号置顶，其余按剩余额度从高到低；冷却池按重置时间
  readyAccounts.sort((a, b) => {
    if (a.active) return -1;
    if (b.active) return 1;
    return (b.remaining_percent ?? 0) - (a.remaining_percent ?? 0);
  });

  cooldownAccounts.sort((a, b) => (a.reset_at_ms ?? 0) - (b.reset_at_ms ?? 0));

  const copyId = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message(t("账号 ID 已复制到剪贴板"));
    } catch {
      message(t("复制失败"));
    }
  };

  return (
    <div className={styles.boardCard}>
      {/* 顶部标题与控制栏 */}
      <div className={styles.boardHeader}>
        <div className={styles.providerInfo}>
          <div className={styles.iconWrap}>{icon}</div>
          <div className={styles.names}>
            <div className={styles.titleRow}>
              <strong>{title}</strong>
              <ConnectionBadge connected={connected} />
            </div>
            <span>{subtitle}</span>
          </div>
        </div>

        <div className={styles.headerActions}>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={(event) => onImportFiles(event.target.files)}
          />
          <Button variant="secondary" size="small" disabled={importing} onClick={onImportClick}>
            {importing ? t("导入中…") : t("批量导入")}
          </Button>
          <Button variant={connected ? "secondary" : "primary"} size="small" onClick={onOpenModal}>
            {connected ? t("添加账号") : t("立即登录授权")}
          </Button>
          {connected && (
            <Button variant="secondary" size="small" disabled={loadingUsage} onClick={onRefreshUsage}>
              <Icon icon={refreshIcon} size="1em" /> {loadingUsage ? t("查询中…") : t("刷新活跃额度")}
            </Button>
          )}
        </div>
      </div>

      {/* 账号池全局统计与搜索工具条 */}
      {accounts.length > 0 && (
        <div className={styles.poolToolbar}>
          <div className={styles.poolStats}>
            <span className={styles.statPill}>
              {t("总账号: {count}", { count: accounts.length })}
            </span>
            <span className={`${styles.statPill} ${styles.statPillReady}`}>
              {t("🟢 可用: {count}", { count: accounts.filter((a) => !isAccountCooldown(a)).length })}
            </span>
            <span className={`${styles.statPill} ${styles.statPillCooldown}`}>
              {t("⏳ 冷却/耗尽: {count}", { count: accounts.filter(isAccountCooldown).length })}
            </span>
            <span className={styles.statHint}>
              {provider === "codex"
                ? t("额度为 0 时自动平滑轮换到下一个可用账号")
                : t("周额度用尽时自动轮换")}
            </span>
          </div>

          <div className={styles.searchWrap}>
            <TextInput
              placeholder={t("搜索账号名称 / ID…")}
              value={searchKeyword}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* 看板三列内容 */}
      {accounts.length === 0 ? (
        <div className={styles.emptyBoard}>
          <p>{t("暂无授权账号，点击上方“立即登录授权”或“批量导入”接入账号池。")}</p>
        </div>
      ) : (
        <div className={styles.kanbanColumns}>
          {/* 列 1：🟢 可用池 */}
          <div className={`${styles.column} ${styles.columnReady}`}>
            <div className={styles.columnHeader}>
              <div className={styles.colTitle}>
                <span className={styles.readyDot} />
                <strong>{t("可用池 (Ready)")}</strong>
              </div>
              <span className={styles.colCount}>{readyAccounts.length}</span>
            </div>
            <div className={styles.columnBody}>
              {readyAccounts.length === 0 ? (
                <div className={styles.emptyCol}>
                  {keyword ? t("无匹配可用账号") : t("暂无可用的健康账号")}
                </div>
              ) : (
                readyAccounts.map((acc) => (
                  <AccountCard
                    key={acc.account_id}
                    account={acc}
                    provider={provider}
                    isActive={acc.active}
                    onActivate={() => onActivate(acc.account_id)}
                    onDelete={() => onDelete(acc)}
                    onCopy={() => void copyId(acc.account_id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* 列 2：⏳ 冷却中 */}
          <div className={`${styles.column} ${styles.columnCooldown}`}>
            <div className={styles.columnHeader}>
              <div className={styles.colTitle}>
                <span className={styles.cooldownDot} />
                <strong>{t("冷却中 (0% 待重置)")}</strong>
              </div>
              <div className={styles.colHeaderRight}>
                <span className={styles.colCount}>{cooldownAccounts.length}</span>
                {cooldownAccounts.length > 0 && (
                  <button
                    type="button"
                    className={styles.clearBtn}
                    title={t("一键清理所有 0% 冷却账号")}
                    onClick={onClearCooldown}
                  >
                    {t("清空")}
                  </button>
                )}
              </div>
            </div>
            <div className={styles.columnBody}>
              {cooldownAccounts.length === 0 ? (
                <div className={styles.emptyCol}>
                  {keyword ? t("无匹配冷却账号") : t("当前无冷却账号")}
                </div>
              ) : (
                cooldownAccounts.map((acc) => (
                  <AccountCard
                    key={acc.account_id}
                    account={acc}
                    provider={provider}
                    isActive={acc.active}
                    isCooldown
                    onActivate={() => onActivate(acc.account_id)}
                    onDelete={() => onDelete(acc)}
                    onCopy={() => void copyId(acc.account_id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* 列 3：⚠️ 异常/待排查 */}
          <div className={`${styles.column} ${styles.columnError}`}>
            <div className={styles.columnHeader}>
              <div className={styles.colTitle}>
                <span className={styles.errorDot} />
                <strong>{t("异常 / 待排查")}</strong>
              </div>
              <span className={styles.colCount}>{errorAccounts.length}</span>
            </div>
            <div className={styles.columnBody}>
              {errorAccounts.length === 0 ? (
                <div className={styles.emptyCol}>
                  {t("无异常账号")}
                </div>
              ) : (
                errorAccounts.map((acc) => (
                  <AccountCard
                    key={acc.account_id}
                    account={acc}
                    provider={provider}
                    isActive={acc.active}
                    isError
                    errorText={usageError || t("授权失效或网络异常")}
                    onActivate={() => onActivate(acc.account_id)}
                    onDelete={() => onDelete(acc)}
                    onCopy={() => void copyId(acc.account_id)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountCard({
  account,
  provider,
  isActive,
  isCooldown,
  isError,
  errorText,
  onActivate,
  onDelete,
  onCopy,
}: {
  account: SubscriptionAccount;
  provider: "grok" | "codex";
  isActive: boolean;
  isCooldown?: boolean;
  isError?: boolean;
  errorText?: string;
  onActivate: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const weekly = account.remaining_percent;
  const session = account.session_remaining_percent;
  const tone = remainingTone(weekly);

  const resetTimeStr = account.reset_at_ms
    ? new Date(account.reset_at_ms).toLocaleString()
    : null;

  return (
    <div className={`${styles.accountCard} ${isActive ? styles.activeCard : ""} ${isCooldown ? styles.cooldownCard : ""} ${isError ? styles.errorCard : ""}`}>
      <div className={styles.accountCardTop}>
        <div className={styles.accountMainInfo}>
          <strong className={styles.accountName} title={account.display_name}>
            {account.display_name}
          </strong>
          {isActive && <span className={styles.activeBadge}>{t("当前使用中")}</span>}
        </div>
        <div className={styles.cardItemActions}>
          <button type="button" className={styles.miniIconBtn} title={t("复制账号 ID")} onClick={onCopy}>
            <Icon icon={copyIcon} size="0.9em" />
          </button>
          <button type="button" className={styles.miniIconBtn} title={t("删除账号")} onClick={onDelete}>
            <Icon icon={trashIcon} size="0.9em" />
          </button>
        </div>
      </div>

      {/* 额度条 */}
      {!isError ? (
        <div className={styles.accountProgress}>
          {provider === "codex" && session !== null && session !== undefined && (
            <div className={styles.miniMeter}>
              <div className={styles.meterLabel}>
                <span>{t("5小时窗口")}</span>
                <span>{formatPercent(session)}</span>
              </div>
              <div className={styles.miniTrack}>
                <div
                  className={`${styles.miniFill} ${styles[`${remainingTone(session)}Fill`]}`}
                  style={{ width: `${Math.max(0, Math.min(100, session))}%` }}
                />
              </div>
            </div>
          )}

          <div className={styles.miniMeter}>
            <div className={styles.meterLabel}>
              <span>{t("周额度")}</span>
              <span className={styles[tone]}>{weekly !== null ? formatPercent(weekly) : t("未查询")}</span>
            </div>
            <div className={styles.miniTrack}>
              <div
                className={`${styles.miniFill} ${styles[`${tone}Fill`]}`}
                style={{ width: `${Math.max(0, Math.min(100, weekly ?? 0))}%` }}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.errorBanner}>{errorText}</div>
      )}

      <div className={styles.accountCardBottom}>
        <span className={styles.resetLabel}>
          {resetTimeStr ? t("重置: {time}", { time: resetTimeStr }) : (account.plan_label || t("标准配额"))}
        </span>
        {!isActive && (
          <button type="button" className={styles.switchBtn} onClick={onActivate}>
            {t("设为主用")}
          </button>
        )}
      </div>
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

function remainingTone(remaining: number | null): "toneSuccess" | "toneWarn" | "toneDanger" | "toneNeutral" {
  if (remaining === null) return "toneNeutral";
  if (remaining > 35) return "toneSuccess";
  if (remaining > 10) return "toneWarn";
  return "toneDanger";
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
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
  defaults: Omit<ModelInput, "display_name" | "model_id" | "api_key" | "sort_order" | "type" | "openai_extra_params_enabled" | "openai_extra_params" | "custom_headers_enabled" | "custom_headers" | "anthropic_extra_params_enabled" | "anthropic_extra_params" | "anthropic_thinking_effort" | "thinking_budget_tokens">;
}): Promise<{ created: number }> {
  const discovered = await api.discoverModels({
    type: "openai",
    base_url: discoveryUrl,
    api_key: accessToken,
    custom_headers_enabled: false,
    custom_headers: {},
  });
  const existingIds = new Set(existing.map((m) => m.model_id));
  const newDiscovered = discovered.models.filter((m) => !existingIds.has(m.id));
  if (newDiscovered.length === 0) return { created: 0 };
  const nextOrderStart = allModels.length + 1;
  const inputs: ModelInput[] = newDiscovered.map((m, index) => {
    const isCodex = defaults.tooltip_data?.includes("Codex") || defaults.tooltip_data?.includes("ChatGPT");
    const inferredContext = isCodex ? 272000 : contextWindowForModel(m.id, m.context_window_tokens, null);
    return {
      sort_order: nextOrderStart + index,
      display_name: m.id,
      type: "openai",
      base_url: defaults.base_url,
      use_full_url: defaults.use_full_url,
      api_key: "oauth",
      tooltip_data: defaults.tooltip_data ?? "Subscription Model",
      model_id: m.id,
      reasoning_effort: null,
      openai_endpoint: defaults.openai_endpoint,
      openai_extra_params_enabled: false,
      openai_extra_params: {},
      custom_headers_enabled: false,
      custom_headers: {},
      anthropic_extra_params_enabled: false,
      anthropic_extra_params: {},
      context_window_tokens: inferredContext,
      max_completion_tokens: defaults.max_completion_tokens,
      anthropic_max_tokens: null,
      anthropic_thinking_effort: null,
      thinking_budget_tokens: null,
    };
  });
  await api.createModels(inputs);
  await appStore.refresh();
  return { created: inputs.length };
}
