import { useState } from "react";
import { PageContent } from "../components/layout/PageContent";
import { Button } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { openAiIcon, claudeIcon, checkIcon } from "../components/ui/icons";
import { GrokAuthModal } from "../components/cursor/GrokAuthModal";
import { useAppStore, appStore } from "../store/appStore";
import { useMessage } from "../components/ui/message";
import { api, type ModelInput } from "../api";
import styles from "./OAuthPage.module.scss";

export function OAuthPage() {
  const { models } = useAppStore();
  const message = useMessage();
  const [grokModalOpen, setGrokModalOpen] = useState(false);

  // Check if Grok OAuth model already exists
  const grokModel = models.find(
    (m) => m.base_url.includes("api.x.ai") || m.model_id.toLowerCase().includes("grok")
  );
  const isGrokConnected = Boolean(grokModel?.api_key);

  const handleGrokAuthSuccess = async (accessToken: string) => {
    try {
      // Discover available models from xAI API
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
        // Add or update all discovered Grok models
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
              tooltip_data: "xAI Grok (OAuth)",
            });
          } else {
            newModelsToCreate.push({
              sort_order: models.length + i + 1,
              display_name: modelId,
              type: "openai",
              base_url: "https://api.x.ai/v1",
              use_full_url: false,
              api_key: accessToken,
              tooltip_data: "xAI Grok (OAuth)",
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
        message(t("Grok 账号授权成功，已同步 {count} 个模型到 Cursor 配置！", { count: discoveredModels.length }));
      } else if (grokModel) {
        // Update existing single model
        await appStore.updateCursorModel(grokModel.model_hash, {
          ...grokModel,
          api_key: accessToken,
          type: "openai",
          base_url: "https://api.x.ai/v1",
          openai_endpoint: "/v1/chat/completions",
          context_window_tokens: 500000,
          max_completion_tokens: 16384,
          tooltip_data: "xAI Grok (OAuth)",
        });
        message(t("Grok 账号授权成功，已更新模型凭证！"));
      } else {
        // Fallback: create default grok model
        const input: ModelInput = {
          sort_order: models.length + 1,
          display_name: "grok (OAuth)",
          type: "openai",
          base_url: "https://api.x.ai/v1",
          use_full_url: false,
          api_key: accessToken,
          tooltip_data: "xAI Grok (OAuth)",
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
        message(t("Grok 账号已连接，已自动添加到 Cursor 模型列表！"));
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const sections = [
    {
      key: "oauth-providers",
      estimatedHeight: 400,
      content: (
        <div className={styles.page}>
          <div className={styles.intro}>
            <strong>{t("官方账号 OAuth 授权中心")}</strong>
            <span>
              {t("通过官方 OAuth 授权连接你的订阅账号（如 X Premium+ / SuperGrok 等），直接使用官方模型额度，无需额外购买开发者 API Key。")}
            </span>
          </div>

          <div className={styles.grid}>
            {/* Grok (xAI) Provider Card */}
            <div className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.providerInfo}>
                  <div className={styles.iconWrap}>𝕏</div>
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

            {/* GitHub Copilot / Codex Provider Card */}
            <div className={`${styles.card} ${styles.cardDisabled}`}>
              <div className={styles.cardTop}>
                <div className={styles.providerInfo}>
                  <div className={styles.iconWrap}>🐙</div>
                  <div className={styles.names}>
                    <strong>GitHub Copilot</strong>
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
                </div>
              </div>

              <div className={styles.cardFooter}>
                <Button disabled>{t("即将推出")}</Button>
              </div>
            </div>

            {/* OpenAI / ChatGPT Plus Provider Card */}
            <div className={`${styles.card} ${styles.cardDisabled}`}>
              <div className={styles.cardTop}>
                <div className={styles.providerInfo}>
                  <div className={styles.iconWrap}>
                    <Icon icon={openAiIcon} size="1.2em" />
                  </div>
                  <div className={styles.names}>
                    <strong>OpenAI / ChatGPT</strong>
                    <span>OpenAI OAuth Flow</span>
                  </div>
                </div>
                <span className={`${styles.badge} ${styles.badgeComingSoon}`}>
                  {t("即将支持")}
                </span>
              </div>

              <div className={styles.cardBody}>
                <p>{t("支持连接 OpenAI 账号与 ChatGPT Plus 订阅额度。")}</p>
                <div className={styles.metaList}>
                  <div className={styles.metaItem}>
                    <span>{t("协议类型")}</span>
                    <span>OpenAI API</span>
                  </div>
                </div>
              </div>

              <div className={styles.cardFooter}>
                <Button disabled>{t("即将推出")}</Button>
              </div>
            </div>

            {/* Anthropic Claude Provider Card */}
            <div className={`${styles.card} ${styles.cardDisabled}`}>
              <div className={styles.cardTop}>
                <div className={styles.providerInfo}>
                  <div className={styles.iconWrap}>
                    <Icon icon={claudeIcon} size="1.2em" />
                  </div>
                  <div className={styles.names}>
                    <strong>Anthropic Claude</strong>
                    <span>Claude Console Auth</span>
                  </div>
                </div>
                <span className={`${styles.badge} ${styles.badgeComingSoon}`}>
                  {t("即将支持")}
                </span>
              </div>

              <div className={styles.cardBody}>
                <p>{t("支持连接 Claude 官方账号与 Pro 订阅额度。")}</p>
                <div className={styles.metaList}>
                  <div className={styles.metaItem}>
                    <span>{t("协议类型")}</span>
                    <span>Anthropic Messages API</span>
                  </div>
                </div>
              </div>

              <div className={styles.cardFooter}>
                <Button disabled>{t("即将推出")}</Button>
              </div>
            </div>
          </div>

          <GrokAuthModal
            open={grokModalOpen}
            onClose={() => setGrokModalOpen(false)}
            onSuccess={handleGrokAuthSuccess}
          />
        </div>
      ),
    },
  ];

  return <PageContent title={t("OAuth 登录")} sections={sections} />;
}
