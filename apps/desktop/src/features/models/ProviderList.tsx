//! The Cursor page's provider list: each manual supplier, each plugin, and the local Magpie gateway; a row opens its page.
import type { ReactNode } from "react";
import type { MagpieCatalog } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { addIcon, chevronRightIcon } from "../../shared/ui/icons";
import type { CursorModelTestState } from "./CursorModelTestResult";
import { MAGPIE_PROVIDER, testStatus, type CursorProvider, type ProviderStatus } from "./cursorProviders";
import { magpieSummary } from "./MagpieProvider";
import { ProviderIcon } from "./ProviderParts";
import styles from "./Providers.module.scss";

export function protocolLabel(provider: CursorProvider) {
  if (provider.kind === "plugin") return t("插件");
  return provider.types.map(type => type === "anthropic" ? "Anthropic" : "OpenAI").join(" / ");
}

export function ProviderList({ providers, magpie, magpieHashes, testResults, busy, previewingImport, onOpen, onAdd, onImport }: {
  providers: CursorProvider[];
  magpie: MagpieCatalog | null | undefined;
  magpieHashes: string[];
  testResults: Map<string, CursorModelTestState>;
  busy: boolean;
  previewingImport: boolean;
  onOpen: (key: string) => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  const magpieStatus: ProviderStatus = !magpie ? "off" : testStatus(magpieHashes, testResults) === "failed" ? "failed" : "ready";
  const magpieDetail = magpie === undefined
    ? t("正在读取状态…")
    : magpie
      ? magpieSummary(magpie)
      : t("未连接 · 自动发现本机网关，无需 API Key");

  return <Card className={`${styles.list} ${styles.providerList}`}>
    {providers.map(provider => {
      const ids = provider.kind === "manual" ? provider.models.map(model => model.model_hash) : provider.models.map(model => model.id);
      const count = t("{count} 个模型", { count: provider.models.length });
      return <ProviderRow
        key={provider.key}
        icon={<ProviderIcon provider={provider} size="1.6em" />}
        name={provider.name}
        badge={protocolLabel(provider)}
        detail={provider.kind === "manual" && provider.host !== provider.name ? `${provider.host} · ${count}` : count}
        status={testStatus(ids, testResults)}
        onOpen={() => onOpen(provider.key)}
      />;
    })}
    <ProviderRow
      icon={<ProviderIcon provider={MAGPIE_PROVIDER} size="1.6em" />}
      name="Magpie"
      badge={t("本机网关")}
      detail={magpieDetail}
      status={magpieStatus}
      readyLabel={t("已连接本机 Magpie")}
      onOpen={() => onOpen(MAGPIE_PROVIDER)}
    />
    <div className={`${styles.row} ${styles.providerFooter}`}>
      <div className={styles.text}>
        <span className={styles.name}>{providers.some(provider => provider.kind === "manual") ? t("添加自定义供应商") : t("还没有自定义供应商")}</span>
        <span className={styles.detail}>{t("填写 OpenAI 或 Anthropic 兼容接口的地址、API Key 和模型。")}</span>
      </div>
      <div className={styles.actions}>
        <button type="button" className={controls.secondary} disabled={busy} onClick={onImport}>{previewingImport ? t("读取中…") : t("导入旧版配置")}</button>
        <button type="button" className={controls.primary} disabled={busy} onClick={onAdd}><Icon icon={addIcon} size="1em" />{t("添加供应商")}</button>
      </div>
    </div>
  </Card>;
}

function ProviderRow({ icon, name, badge, detail, status, readyLabel = t("测试通过"), onOpen }: {
  icon: ReactNode;
  name: string;
  badge: string;
  detail: string;
  status: ProviderStatus;
  readyLabel?: string;
  onOpen: () => void;
}) {
  return <button type="button" className={`${styles.row} ${styles.clickable}`} onClick={onOpen}>
    {icon}
    <span className={styles.text}>
      <span className={styles.name}>{name}</span>
      <span className={styles.detail} title={detail}>{badge} · {detail}</span>
    </span>
    {(status === "ready" || status === "failed") && <span
      className={styles.dot}
      data-status={status}
      role="img"
      aria-label={status === "failed" ? t("测试失败") : readyLabel}
    />}
    <Icon className={styles.chevron} icon={chevronRightIcon} size="1.1em" />
  </button>;
}
