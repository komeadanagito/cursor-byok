import { useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { checkIcon } from "../ui/icons";
import { GrokAuthModal } from "./GrokAuthModal";
import { useAppStore, appStore } from "../../store/appStore";
import { useMessage } from "../ui/message";
import { api, type ModelInput } from "../../api";
import styles from "./SubscriptionAuthTab.module.scss";

export function isSubscriptionModel(m: { base_url?: string; tooltip_data?: string }): boolean {
  return Boolean(
    m.base_url?.includes("api.x.ai") ||
    m.base_url?.includes("copilot") ||
    m.tooltip_data?.includes("xAI") ||
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

  const grokModels = models.filter(
    (m) => Boolean(m.base_url?.includes("api.x.ai") || m.model_id?.toLowerCase().includes("grok"))
  );
  const isGrokConnected = grokModels.some((m) => Boolean(m.api_key));

  const handleGrokAuthSuccess = async (accessToken: string) => {
    try {
      let discoveredModels: string[] = [];
      try {
        const res = await api.discoverModels({
          type: "openai",
          base_url: "https://api.x.ai/v1",
          api_key: accessToken,
          custom_headers_enabled: false,
          custom_headers: {},
        });
        discoveredModels = res.models || [];
      } catch {
        // Fallback if discovery is unavailable
      }

      if (discoveredModels.length > 0) {
        const newModelsToCreate: ModelInput[] = [];
        for (let i = 0; i < discoveredModels.length; i++) {
          const modelId = discoveredModels[i];
          const existing = models.find((m) => m.model_id === modelId && m.base_url.includes("api.x.ai"));
          if (existing) {
            await appStore.updateCursorModel(existing.model_hash, {
              ...existing,
              api_key: accessToken,
              type: "openai",
              base_url: "https://api.x.ai/v1",
              openai_endpoint: "/v1/chat/completions",
              context_window_tokens: 500000,
              max_completion_tokens: 16384,
              tooltip_data: "xAI Grok",
            });
          } else {
            newModelsToCreate.push({
              sort_order: models.length + i + 1,
              display_name: modelId,
              type: "openai",
              base_url: "https://api.x.ai/v1",
              use_full_url: false,
              api_key: accessToken,
              tooltip_data: "xAI Grok",
              model_id: modelId,
              reasoning_effort: null,
              openai_endpoint: "/v1/chat/completions",
              openai_extra_params_enabled: false,
              openai_extra_params: {},
              custom_headers_enabled: false,
              custom_headers: {},
              anthropic_extra_params_enabled: false,
              anthropic_extra_params: {},
              context_window_tokens: 500000,
              max_completion_tokens: 16384,
              anthropic_max_tokens: null,
              anthropic_thinking_effort: "xhigh",
              thinking_budget_tokens: null,
            });
          }
        }
        if (newModelsToCreate.length > 0) {
          await appStore.createModels(newModelsToCreate);
        }
        message(t("Grok 账号授权成功，已同步 {count} 个模型！", { count: discoveredModels.length }));
      } else if (grokModels.length > 0) {
        const first = grokModels[0];
        await appStore.updateCursorModel(first.model_hash, {
          ...first,
          api_key: accessToken,
          type: "openai",
          base_url: "https://api.x.ai/v1",
          openai_endpoint: "/v1/chat/completions",
          context_window_tokens: 500000,
          max_completion_tokens: 16384,
          tooltip_data: "xAI Grok",
        });
        message(t("Grok 账号授权成功，已更新模型凭证！"));
      } else {
        const input: ModelInput = {
          sort_order: models.length + 1,
          display_name: "grok-beta",
          type: "openai",
          base_url: "https://api.x.ai/v1",
          use_full_url: false,
          api_key: accessToken,
          tooltip_data: "xAI Grok",
          model_id: "grok-beta",
          reasoning_effort: null,
          openai_endpoint: "/v1/chat/completions",
          openai_extra_params_enabled: false,
          openai_extra_params: {},
          custom_headers_enabled: false,
          custom_headers: {},
          anthropic_extra_params_enabled: false,
          anthropic_extra_params: {},
          context_window_tokens: 500000,
          max_completion_tokens: 16384,
          anthropic_max_tokens: null,
          anthropic_thinking_effort: "xhigh",
          thinking_budget_tokens: null,
        };
        await appStore.createModels([input]);
        message(t("Grok 账号已连接，已添加 grok-beta 模型！"));
      }

      onSwitchToModels?.();
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <strong>{t("官方账号订阅与授权管理")}</strong>
        <span>
          {t("通过官方 OAuth 授权连接你的订阅账号，获取官方模型额度并在 Cursor 中直接使用。")}
        </span>
      </div>

      <div className={styles.grid}>
        {/* Grok (xAI) Provider Card */}
        <div className={styles.card}>
          <div className={styles.cardTop}>
            <div className={styles.providerInfo}>
              <div className={styles.iconWrap}>⚡</div>
              <div className={styles.names}>
                <strong>Grok (xAI)</strong>
                <span>xAI OAuth 2.0 Device Flow</span>
              </div>
            </div>
            <span
              className={`${styles.badge} ${
                isGrokConnected ? styles.badgeConnected : styles.badgeAvailable
              }`}
            >
              {isGrokConnected ? (
                <>
                  <Icon icon={checkIcon} size="0.9em" /> {t("已连接")}
                </>
              ) : (
                t("支持登录")
              )}
            </span>
          </div>

          <div className={styles.cardBody}>
            <p>
              {t("支持使用 X Premium+ 或 SuperGrok 订阅账号，直接使用 grok-2、grok-beta 等官方模型。")}
            </p>
            <div className={styles.metaList}>
              <div className={styles.metaItem}>
                <span>{t("协议类型")}</span>
                <span>OpenAI Compatible</span>
              </div>
              <div className={styles.metaItem}>
                <span>{t("服务地址")}</span>
                <span>https://api.x.ai/v1</span>
              </div>
              <div className={styles.metaItem}>
                <span>{t("默认上下文")}</span>
                <span>500K Tokens</span>
              </div>
              <div className={styles.metaItem}>
                <span>{t("授权方式")}</span>
                <span>Device Code Grant (RFC 8628)</span>
              </div>
            </div>
          </div>

          <div className={styles.cardFooter}>
            <Button
              variant={isGrokConnected ? "secondary" : "primary"}
              onClick={() => setGrokModalOpen(true)}
            >
              {isGrokConnected ? t("重新授权 / 切换账号") : t("⚡ 立即登录授权")}
            </Button>
          </div>
        </div>

        {/* Codex (GitHub Copilot) Provider Card */}
        <div className={`${styles.card} ${styles.cardDisabled}`}>
          <div className={styles.cardTop}>
            <div className={styles.providerInfo}>
              <div className={styles.iconWrap}>🐙</div>
              <div className={styles.names}>
                <strong>Codex (GitHub Copilot)</strong>
                <span>GitHub OAuth Device Flow</span>
              </div>
            </div>
            <span className={`${styles.badge} ${styles.badgeComingSoon}`}>
              {t("即将支持")}
            </span>
          </div>

          <div className={styles.cardBody}>
            <p>{t("支持通过 GitHub 账号授权，使用 GitHub Copilot / Codex 订阅额度。")}</p>
            <div className={styles.metaList}>
              <div className={styles.metaItem}>
                <span>{t("协议类型")}</span>
                <span>Copilot Chat / Codex</span>
              </div>
              <div className={styles.metaItem}>
                <span>{t("服务地址")}</span>
                <span>api.github.com/copilot_internal</span>
              </div>
              <div className={styles.metaItem}>
                <span>{t("授权方式")}</span>
                <span>Device Code Grant (RFC 8628)</span>
              </div>
            </div>
          </div>

          <div className={styles.cardFooter}>
            <Button disabled>{t("即将推出")}</Button>
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
    </div>
  );
}
