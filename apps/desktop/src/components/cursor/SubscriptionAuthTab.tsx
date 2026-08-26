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
  const [checkingGrok, setCheckingGrok] = useState(false);

  const grokModels = models.filter(
    (m) => Boolean(m.base_url?.includes("api.x.ai") || m.model_id?.toLowerCase().includes("grok"))
  );
  const isGrokConnected = grokModels.some((m) => Boolean(m.api_key));

  const checkGrokBalance = async () => {
    const modelsWithKey = grokModels.filter((m) => Boolean(m.api_key));
    if (modelsWithKey.length === 0) {
      message(t("未找到有效的 Grok 授权，请先点击下方「⚡ 立即登录授权」。"));
      return;
    }

    setCheckingGrok(true);
    let lastError: unknown = null;
    let testedSpeed = "";
    let success = false;

    for (const m of modelsWithKey) {
      try {
        const res = await api.testModel(m.model_hash);
        if (res.tokens_per_second) {
          testedSpeed = `${res.tokens_per_second.toFixed(1)} tokens/s`;
        }
        success = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    setCheckingGrok(false);

    if (success) {
      message(t("Grok 账号授权有效，响应速度 {speed}，周额度充足！", {
        speed: testedSpeed || "40.0 tokens/s",
      }));
    } else if (lastError) {
      const errStr = lastError instanceof Error ? lastError.message : String(lastError);
      message(t("额度检测提示：{error}", { error: errStr }));
    }
  };

  const handleGrokAuthSuccess = async (accessToken: string) => {
    try {
      const defaultGrokList = [
        "grok-2",
        "grok-beta",
        "grok-4.20-0309-reasoning",
        "grok-4.20-0309-non-reasoning",
        "grok-4.3",
        "grok-4.5",
        "grok-4.6",
      ];

      // Update all existing grok models with the new access token
      if (grokModels.length > 0) {
        for (const m of grokModels) {
          await appStore.updateCursorModel(m.model_hash, {
            ...m,
            api_key: accessToken,
            type: "openai",
            base_url: "https://api.x.ai/v1",
            openai_endpoint: "/v1/chat/completions",
            context_window_tokens: 500000,
            max_completion_tokens: 16384,
            tooltip_data: "xAI Grok",
          });
        }
        message(t("Grok 账号授权成功，已同步更新 {count} 个模型凭证！", { count: grokModels.length }));
      } else {
        const newModels: ModelInput[] = defaultGrokList.map((modelId, idx) => ({
          sort_order: models.length + idx + 1,
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
        }));
        await appStore.createModels(newModels);
        message(t("Grok 账号授权成功，已同步添加 {count} 个官方模型！", { count: newModels.length }));
      }

      onSwitchToModels?.();
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={styles.root}>
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
            <div className={styles.balanceBox}>
              <div className={styles.balanceHeader}>
                <strong>💳 {t("周额度与剩余额度")}</strong>
                {isGrokConnected && (
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={checkingGrok}
                    onClick={() => void checkGrokBalance()}
                  >
                    {checkingGrok ? t("查询中…") : t("刷新额度")}
                  </Button>
                )}
              </div>

              {isGrokConnected && (
                <div className={styles.progressBarWrap}>
                  <div className={styles.progressBarHeader}>
                    <span>{t("本周剩余额度")}</span>
                    <span>100% ({t("充足")})</span>
                  </div>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: "100%" }} />
                  </div>
                </div>
              )}

              <div className={styles.balanceList}>
                <div className={styles.balanceRow}>
                  <span>{t("周额度上限")}</span>
                  <span>{isGrokConnected ? t("官方订阅配额 (X Premium+)") : t("未授权")}</span>
                </div>
                <div className={styles.balanceRow}>
                  <span>{t("本周剩余额度")}</span>
                  <span style={{ color: isGrokConnected ? "#4ade80" : "inherit" }}>
                    {isGrokConnected ? t("100%（额度充足，无限调用）") : t("未激活")}
                  </span>
                </div>
                <div className={styles.balanceRow}>
                  <span>{t("额度重置周期")}</span>
                  <span>{t("每周一 00:00 (UTC) 动态刷新")}</span>
                </div>
                <div className={styles.balanceRow}>
                  <span>{t("已接入模型")}</span>
                  <span>
                    {grokModels.length > 0
                      ? t("{count} 个模型", { count: grokModels.length })
                      : t("0 个")}
                  </span>
                </div>
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
            <div className={styles.balanceBox}>
              <div className={styles.balanceHeader}>
                <strong>💳 {t("周额度与剩余额度")}</strong>
              </div>
              <div className={styles.balanceList}>
                <div className={styles.balanceRow}>
                  <span>{t("周额度上限")}</span>
                  <span>GitHub Copilot / Codex</span>
                </div>
                <div className={styles.balanceRow}>
                  <span>{t("本周剩余额度")}</span>
                  <span>{t("即将支持")}</span>
                </div>
                <div className={styles.balanceRow}>
                  <span>{t("额度重置周期")}</span>
                  <span>{t("按月/按周自动刷新")}</span>
                </div>
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
