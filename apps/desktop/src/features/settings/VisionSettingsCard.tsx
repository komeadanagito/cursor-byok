import { useEffect, useState } from "react";
import { api, pluginText, type VisionSettings } from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { useAppStore } from "../../shared/store/appStore";
import { ModelSelect, type ModelSelectOption } from "../../shared/ui/ModelSelect";
import { Select } from "../../shared/ui/Select";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { modelProviderName } from "../../shared/utils/modelProvider";
import { providerIcon } from "../../shared/ui/icons";
import { modelLogo } from "../../shared/utils/brandIcons";
import styles from "./CommitSettingsCard.module.scss";

export function VisionSettingsCard() {
  const { models, plugins } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [saved, setSaved] = useState<VisionSettings | null>(null);
  const [draft, setDraft] = useState<VisionSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    api.visionSettings().then(value => { if (active) setSaved(value); }, error => { if (active) message(String(error)); });
    return () => { active = false; };
  }, [message]);

  const readers = [
    { value: "cursor", label: t("Cursor 原生识图") },
    { value: "model", label: t("指定视觉模型") },
    { value: "mcp", label: t("识图 MCP") },
  ];
  const options: ModelSelectOption[] = models.filter(m => m.supports_images).map(m => ({
    value: m.model_hash, group: modelProviderName(m), label: m.display_name || m.model_id,
    iconMask: modelLogo(m),
    icon: providerIcon,
  }));
  for (const plugin of plugins) {
    for (const provider of plugin.providers.filter(p => p.configured)) {
      for (const model of provider.models.filter(m => m.enabled && m.images)) {
        options.push({ value: model.id, label: model.displayName, group: pluginText(provider.displayName, locale) || plugin.name, iconSrc: model.icon || undefined });
      }
    }
  }
  const canSave = draft && (draft.mode === "cursor" || (draft.mode === "model" ? options.some(o => o.value === draft.model_id) : draft.url.trim() && draft.tool.trim()));
  async function save() {
    if (!draft) return;
    setSaving(true);
    try { setSaved(await api.setVisionSettings(draft)); setDraft(null); }
    catch (error) { message(String(error)); }
    finally { setSaving(false); }
  }
  const label = saved?.mode === "model" ? options.find(o => o.value === saved.model_id)?.label || saved.model_id
    : saved?.mode === "mcp" ? `${saved.tool} · ${saved.url}` : readers[0].label;
  return <TitledCard title={t("图片识别")} action={draft ? <div className={styles.actionGroup}>
    <Button size="small" disabled={saving} onClick={() => setDraft(null)}>{t("取消")}</Button>
    <Button size="small" variant="primary" disabled={!canSave || saving} onClick={() => void save()}>{t("保存")}</Button>
  </div> : <button className={styles.textButton} disabled={!saved} onClick={() => setDraft(saved)}>{t("编辑")}</button>}>
    <div className={styles.content}>
      <div className={styles.row}>
        <div className={styles.details}>
          <strong>{t("识图方式")}</strong>
          <small>{t("主模型能识图时直接使用原图。纯文本模型默认由 Cursor 识图，也可指定视觉模型或 MCP。")}</small>
        </div>
        {!draft && <span className={styles.value}>{saved ? label : t("加载中…")}</span>}
      </div>
      {draft && <>
        <Select ariaLabel={t("识图方式")} options={readers} value={draft.mode} disabled={saving} onChange={mode => setDraft(mode === "model" ? { mode, model_id: "" } : mode === "mcp" ? { mode, url: "", tool: "analyze_image" } : { mode: "cursor" })} />
        {draft.mode === "model" && <ModelSelect mode="single" label={t("指定视觉模型")} options={options} value={draft.model_id} disabled={saving} onChange={model_id => setDraft({ mode: "model", model_id })} />}
        {draft.mode === "mcp" && <>
          <FormField label={t("MCP 地址")} hint={t("使用 Streamable HTTP。工具的 image 参数接收图片数据 URL，prompt 参数接收问题。") }><TextInput value={draft.url} disabled={saving} onChange={e => setDraft({ ...draft, url: e.target.value })} /></FormField>
          <FormField label={t("工具名称")}><TextInput value={draft.tool} disabled={saving} onChange={e => setDraft({ ...draft, tool: e.target.value })} /></FormField>
        </>}
      </>}
    </div>
  </TitledCard>;
}
