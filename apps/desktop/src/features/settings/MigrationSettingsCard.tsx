import { useRef, useState, type ChangeEvent } from "react";
import { api, type MigrationFile, type MigrationResult } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import styles from "./MigrationSettingsCard.module.scss";

/**
 * Moves a device's configuration — model entries with their keys and plugin
 * credentials — across machines as one file, so migration does not mean
 * dragging the whole database over.
 */
export function MigrationSettingsCard() {
  const message = useMessage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<MigrationFile | null>(null);
  const [importing, setImporting] = useState(false);

  const exportFile = () => {
    // The endpoint answers with Content-Disposition, so the browser saves it.
    const link = document.createElement("a");
    link.href = api.migrationExportUrl();
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
    message(t("已开始导出，请选择保存位置"));
  };

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as MigrationFile;
      if (parsed?.format !== "cursor-byok-migration") {
        message(t("这不是 cursor-byok 的迁移文件"));
        return;
      }
      setPending(parsed);
    } catch {
      message(t("迁移文件无法读取，可能已损坏"));
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    try {
      setImporting(true);
      const result = await api.migrationImport(pending);
      setPending(null);
      message(summary(result));
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setImporting(false);
    }
  };

  return <TitledCard title={t("设备迁移")}>
    <div className={styles.content}>
      <div className={styles.row}>
        <div className={styles.description}>
          <strong>{t("导出配置")}</strong>
          <small>{t("把模型配置（含 API Key）和插件凭证打包成一个文件。文件包含密钥，请妥善保存。")}</small>
        </div>
        <Button variant="secondary" onClick={exportFile}>{t("导出")}</Button>
      </div>
      <div className={styles.row}>
        <div className={styles.description}>
          <strong>{t("导入配置")}</strong>
          <small>{t("在另一台设备上恢复模型与插件凭证。已有配置不会被覆盖，只补充缺失的部分。")}</small>
        </div>
        <Button variant="secondary" disabled={importing} onClick={() => fileInput.current?.click()}>
          {importing ? t("导入中…") : t("导入")}
        </Button>
      </div>
      <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => void pickFile(event)} />
    </div>

    <ConfirmDialog
      open={pending !== null}
      title={t("导入迁移文件")}
      cancelLabel={t("取消")}
      confirmLabel={importing ? t("导入中…") : t("导入")}
      onCancel={() => setPending(null)}
      onConfirm={() => void confirmImport()}
    >
      <div className={styles.preview}>
        <span>{t("将导入 {models} 个模型和 {resources} 组插件凭证。已有配置保持不变。", {
          models: pending?.models.length ?? 0,
          resources: pending?.plugin_resources.length ?? 0,
        })}</span>
        {(pending?.models.length ?? 0) === 0 && (pending?.plugin_resources.length ?? 0) === 0 && (
          <span className={styles.warning}>{t("文件里没有可导入的内容")}</span>
        )}
      </div>
    </ConfirmDialog>
  </TitledCard>;
}

function summary(result: MigrationResult): string {
  const parts = [t("导入完成：新增 {added} 个模型（共 {total} 个），插件凭证新增 {resources} 条", {
    added: result.models_added,
    total: result.models_total,
    resources: result.resources_added,
  })];
  if (result.warnings.length > 0) parts.push(result.warnings.join("; "));
  return parts.join(" · ");
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
