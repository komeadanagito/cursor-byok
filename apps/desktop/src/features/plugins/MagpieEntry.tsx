//! Built-in Magpie entry in the plugin list: the local gateway needs no install, it is discovered and synced by the app.
import { useEffect, useState } from "react";
import { useKeepAliveContext } from "keepalive-for-react";
import { useNavigate } from "react-router-dom";
import { api, type MagpieCatalog } from "../../shared/api";
import magpieLogo from "../../shared/assets/provider-icons/magpie.png";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import styles from "./PluginManagementPage.module.scss";

export function MagpieEntry() {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<MagpieCatalog | null | undefined>(undefined);
  // The page is kept alive, so a connection made on the Cursor page only shows
  // up here when this entry reloads as the page becomes active again.
  const { active } = useKeepAliveContext();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void api.magpie().then(value => {
      if (!cancelled) setCatalog(value);
    }, () => {
      if (!cancelled) setCatalog(null);
    });
    return () => { cancelled = true; };
  }, [active]);

  const enabled = catalog?.models.filter(model => !catalog.disabled.includes(model.id)).length ?? 0;
  const stateBadge = catalog === undefined
    ? <span className={styles.stateBadge}>{t("读取中…")}</span>
    : catalog === null
      ? <span className={styles.stateBadge}>{t("未连接")}</span>
      : <span className={`${styles.stateBadge} ${styles.stateReady}`}>{t("已连接")}</span>;
  const note = catalog === undefined
    ? ""
    : catalog === null
      ? t("未检测到本机 Magpie 网关，启动后自动连接")
      : t("已启用 {enabled} / {total} 个模型", { enabled, total: catalog.models.length });

  return (
    <Card className={styles.pluginCard}>
      <div className={styles.pluginCardTop}>
        <span className={styles.pluginIcon} aria-hidden>
          <Icon src={magpieLogo} size="2.6em" />
        </span>
        <div className={styles.pluginIdentity}>
          <span className={styles.pluginTitle}>
            <span className={styles.pluginName}>Magpie</span>
            <span className={styles.builtinTag}>{t("内置")}</span>
          </span>
          <span className={styles.pluginDescription}>{t("本机网关，无需 API Key；自动发现并每 10 分钟同步模型目录")}</span>
        </div>
        <div className={styles.pluginState}>{stateBadge}</div>
      </div>
      <div className={styles.cardFooter}>
        <span className={styles.footerNote}>{note}</span>
        <div className={styles.footerActions}>
          <Button onClick={() => navigate("/harness/cursor?open=magpie")}>{t("管理模型")}</Button>
        </div>
      </div>
    </Card>
  );
}
