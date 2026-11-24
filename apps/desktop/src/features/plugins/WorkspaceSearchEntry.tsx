//! Built-in workspace-search entry in the plugin list; installs the Cursor workspace-search extension.
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { searchIcon } from "../../shared/ui/icons";
import { Icon } from "../../shared/ui/Icon";
import { useMessage } from "../../shared/ui/message";
import { workspaceExtensionEntry } from "../models/workspaceExtension";
import styles from "./PluginManagementPage.module.scss";

function versionOrQuestion(version: string | null | undefined) {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "?";
}

export function WorkspaceSearchEntry() {
  const { workspaceExtension, workspaceExtensionBusy, workspaceExtensionError } = useAppStore();
  const message = useMessage();
  const entry = workspaceExtensionEntry(workspaceExtension);

  const install = async () => {
    if (await appStore.installWorkspaceExtension()) {
      message(t("安装完成，重载 Cursor 窗口后生效"), { duration: 4000 });
    }
  };

  const saveVsix = async () => {
    const savedTo = await appStore.saveWorkspaceExtensionVsix();
    if (savedTo) message(t("已导出到 {path}", { path: savedTo }), { duration: 4000 });
  };

  const missingCli = workspaceExtension?.cursor_cli === false;
  const installable = entry.kind === "missing" || entry.kind === "outdated";

  const stateBadge =
    entry.kind === "current" ? (
      <span className={`${styles.stateBadge} ${styles.stateReady}`}>
        {t("已安装 v{version}", { version: versionOrQuestion(entry.version) })}
      </span>
    ) : entry.kind === "outdated" ? (
      <span className={`${styles.stateBadge} ${styles.stateAttention}`}>
        {t("可更新 v{installed} → v{expected}", {
          installed: versionOrQuestion(entry.installed),
          expected: entry.expected,
        })}
      </span>
    ) : entry.kind === "missing" ? (
      <span className={`${styles.stateBadge} ${styles.stateAttention}`}>{t("未安装")}</span>
    ) : null;

  const note = missingCli
    ? t("未检测到 Cursor 命令行，无法自动安装；可另存 VSIX 后在 Cursor 里手动安装。")
    : entry.kind === "current"
      ? t("重载 Cursor 窗口后生效")
      : t("Cursor 扩展，安装后重载窗口生效");

  return (
    <Card className={styles.pluginCard}>
      <div className={styles.pluginCardTop}>
        <span className={`${styles.pluginIcon} ${styles.pluginGlyph}`} aria-hidden>
          <Icon icon={searchIcon} size="1.3em" />
        </span>
        <div className={styles.pluginIdentity}>
          <span className={styles.pluginTitle}>
            <span className={styles.pluginName}>{t("工作区搜索")}</span>
            <span className={styles.builtinTag}>{t("内置")}</span>
          </span>
          <span className={styles.pluginDescription}>{t("让 Agent 按函数名和描述找代码、查引用")}</span>
        </div>
        <div className={styles.pluginState}>{stateBadge}</div>
      </div>
      {workspaceExtensionError && (
        <div className={styles.entryError}>
          {workspaceExtensionError}
          {"\n"}
          {t("如果安装因 SSH Agent 失败，可先运行 eval $(ssh-agent) 与 ssh-add 再重试。")}
        </div>
      )}
      <div className={styles.cardFooter}>
        <span className={`${styles.footerNote} ${missingCli ? styles.footerWarning : ""}`}>{note}</span>
        <div className={styles.footerActions}>
          <Button size="small" disabled={workspaceExtensionBusy} onClick={() => void saveVsix()}>
            {t("另存 VSIX")}
          </Button>
          {installable && (
            <Button size="small" variant="primary" disabled={workspaceExtensionBusy || missingCli} onClick={() => void install()}>
              {workspaceExtensionBusy ? t("安装中…") : entry.kind === "outdated" ? t("更新") : t("安装")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
