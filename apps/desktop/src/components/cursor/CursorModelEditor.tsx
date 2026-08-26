import { useState } from "react";
import type { ModelInput, ModelType } from "../../api";
import { defaultCustomHeadersText } from "../../utils/modelDefaults";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { FormField, SecretTextInput, TextInput } from "../ui/FormControls";
import { JsonEditor } from "../ui/JsonEditor";
import { Combobox, Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { claudeIcon, openAiIcon } from "../ui/icons";
import { GrokAuthModal } from "./GrokAuthModal";
import styles from "./CursorSettings.module.scss";

export type CursorModelDraft = {
  model: ModelInput;
  openAIExtraParamsText: string;
  customHeadersText: string;
  anthropicExtraParamsText: string;
};

export const emptyCursorModelDraft = (): CursorModelDraft => ({
  model: {
    sort_order: 0,
    display_name: "",
    type: "openai",
    base_url: "",
    use_full_url: false,
    api_key: "",
    tooltip_data: t("备注"),
    model_id: "",
    reasoning_effort: null,
    openai_endpoint: "/v1/responses",
    openai_extra_params_enabled: false,
    openai_extra_params: {},
    custom_headers_enabled: false,
    custom_headers: {},
    anthropic_extra_params_enabled: false,
    anthropic_extra_params: {},
    context_window_tokens: null,
    max_completion_tokens: null,
    anthropic_max_tokens: null,
    anthropic_thinking_effort: "xhigh",
    thinking_budget_tokens: null,
  },
  openAIExtraParamsText: "{}",
  customHeadersText: defaultCustomHeadersText,
  anthropicExtraParamsText: "{}",
});

export function CursorModelEditor({ draft, modelOptions, discovering, onChange, onDiscover }: {
  draft: CursorModelDraft;
  modelOptions: string[];
  discovering: boolean;
  onChange: (draft: CursorModelDraft) => void;
  onDiscover: () => void;
}) {
  const [grokModalOpen, setGrokModalOpen] = useState(false);
  const setModel = (patch: Partial<ModelInput>) => onChange({ ...draft, model: { ...draft.model, ...patch } });
  const setType = (type: ModelType) => setModel({
    type,
    openai_endpoint: type === "openai" ? draft.model.openai_endpoint || "/v1/responses" : "",
    anthropic_thinking_effort: type === "anthropic" ? draft.model.anthropic_thinking_effort || "xhigh" : null,
  });
  const numberValue = (value: string) => value === "" ? null : Math.trunc(Number(value));
  const canDiscover = Boolean(draft.model.base_url.trim() && draft.model.api_key.trim());
  const requestUrlPlaceholder = draft.model.use_full_url
    ? draft.model.type === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : draft.model.openai_endpoint === "/v1/chat/completions"
        ? "https://api.openai.com/v1/chat/completions"
        : "https://api.openai.com/v1/responses"
    : draft.model.type === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com";

  const handleGrokAuthSuccess = (accessToken: string) => {
    setModel({
      type: "openai",
      openai_endpoint: "/v1/chat/completions",
      base_url: "https://api.x.ai/v1",
      api_key: accessToken,
      model_id: draft.model.model_id || "grok-beta",
      display_name: draft.model.display_name || "Grok",
      context_window_tokens: 500000,
      max_completion_tokens: 16384,
      tooltip_data: draft.model.tooltip_data === t("备注") ? "xAI Grok (OAuth)" : draft.model.tooltip_data,
    });
  };

  return <div className={styles.editor}>
    <div className={styles.grid}>
      <FormField label={t("模型类型")}><Select ariaLabel={t("模型类型")} value={draft.model.type} options={[
        { value: "openai", label: "OpenAI", icon: openAiIcon },
        { value: "anthropic", label: "Anthropic", icon: claudeIcon },
      ]} onChange={(value) => setType(value as ModelType)} /></FormField>
      {draft.model.type === "openai" && <FormField label={t("请求协议")} hint={t("只决定请求与响应的格式，不会改变请求地址。")}> <Select ariaLabel={t("请求协议")} value={draft.model.openai_endpoint} options={[
        { value: "/v1/responses", label: "Responses API" },
        { value: "/v1/chat/completions", label: "Chat Completions API" },
      ]} onChange={(openai_endpoint) => setModel({ openai_endpoint })} /></FormField>}

      <div className={styles.urlField}>
        <FormField label={draft.model.use_full_url ? t("完整请求 URL") : t("服务器地址")} hint={draft.model.use_full_url ? t("系统会原样使用此地址，不追加或修改请求路径。") : t("系统会根据请求协议自动追加标准端点路径。")}> <TextInput placeholder={requestUrlPlaceholder} value={draft.model.base_url} onChange={(event) => setModel({ base_url: event.target.value })} /></FormField>
        <Checkbox checked={draft.model.use_full_url} label={t("使用完整请求地址")} onChange={(use_full_url) => setModel({ use_full_url })} />
      </div>
      <div className={styles.apiKeyField}>
        <FormField label="API Key / Token" hint={t("访问模型服务所需的密钥。")}>
          <SecretTextInput placeholder="sk-xxxxxx" autoComplete="off" value={draft.model.api_key} onChange={(event) => setModel({ api_key: event.target.value })} />
        </FormField>
        <Button
          className={styles.authButton}
          size="small"
          onClick={() => setGrokModalOpen(true)}
        >
          ⚡ {t("Grok 账号授权登录")}
        </Button>
      </div>

      <GrokAuthModal
        open={grokModalOpen}
        onClose={() => setGrokModalOpen(false)}
        onSuccess={handleGrokAuthSuccess}
      />

      <FormField label={t("模型名称")} hint={t("可以直接输入模型标识，也可以读取接口返回的模型列表。")}> <Combobox value={draft.model.model_id} options={modelOptions} placeholder="gpt-5" append={<Button className={styles.discoverButton} disabled={discovering || !canDiscover} onClick={onDiscover}>{discovering ? t("获取中…") : t("获取模型")}</Button>} onChange={(model_id) => setModel({ model_id, display_name: draft.model.display_name || model_id })} /></FormField>
      <FormField label={t("显示名称")} hint={t("仅用于界面展示，不会改变发送给模型服务的模型名称。")}> <TextInput value={draft.model.display_name} onChange={(event) => setModel({ display_name: event.target.value })} /></FormField>
      <FormField className={styles.fullWidth} label={t("备注")} hint={t("显示在 Cursor 模型说明中。")}> <TextInput value={draft.model.tooltip_data} onChange={(event) => setModel({ tooltip_data: event.target.value })} /></FormField>

      <FormField label={t("上下文窗口 Token")} hint={t("留空时使用默认值。")}> <TextInput type="number" min={1} step={1} value={draft.model.context_window_tokens ?? ""} onChange={(event) => setModel({ context_window_tokens: numberValue(event.target.value) })} /></FormField>
      {draft.model.type === "openai" ? <>
        <FormField label={t("最大输出 Token")} hint={t("留空时使用默认值。")}> <TextInput type="number" min={1} step={1} value={draft.model.max_completion_tokens ?? ""} onChange={(event) => setModel({ max_completion_tokens: numberValue(event.target.value) })} /></FormField>
        <FormField label={t("推理强度")}> <Select ariaLabel={t("推理强度")} value={draft.model.reasoning_effort ?? ""} options={effortOptions(true)} onChange={(value) => setModel({ reasoning_effort: value || null })} /></FormField>
      </> : <>
        <FormField label={t("最大输出 Token")} hint={t("留空时使用默认值。")}> <TextInput type="number" min={1} step={1} value={draft.model.anthropic_max_tokens ?? ""} onChange={(event) => setModel({ anthropic_max_tokens: numberValue(event.target.value) })} /></FormField>
        <FormField label={t("思考强度")}> <Select ariaLabel={t("思考强度")} value={draft.model.anthropic_thinking_effort ?? "xhigh"} options={effortOptions(false)} onChange={(anthropic_thinking_effort) => setModel({ anthropic_thinking_effort })} /></FormField>
        <FormField label={t("思考预算 Token")} hint={t("留空时使用 adaptive thinking。")}> <TextInput type="number" min={1} step={1} value={draft.model.thinking_budget_tokens ?? ""} onChange={(event) => setModel({ thinking_budget_tokens: numberValue(event.target.value) })} /></FormField>
      </>}

      <ToggleJsonField
        label={t("自定义 Headers")}
        enabled={draft.model.custom_headers_enabled}
        text={draft.customHeadersText}
        onEnabledChange={(custom_headers_enabled) => setModel({ custom_headers_enabled })}
        onTextChange={(customHeadersText) => onChange({ ...draft, customHeadersText })}
      />
      {draft.model.type === "openai" ? <ToggleJsonField
        label={t("OpenAI 额外参数")}
        enabled={draft.model.openai_extra_params_enabled}
        text={draft.openAIExtraParamsText}
        onEnabledChange={(openai_extra_params_enabled) => setModel({ openai_extra_params_enabled })}
        onTextChange={(openAIExtraParamsText) => onChange({ ...draft, openAIExtraParamsText })}
      /> : <ToggleJsonField
        label={t("Anthropic 额外参数")}
        enabled={draft.model.anthropic_extra_params_enabled}
        text={draft.anthropicExtraParamsText}
        onEnabledChange={(anthropic_extra_params_enabled) => setModel({ anthropic_extra_params_enabled })}
        onTextChange={(anthropicExtraParamsText) => onChange({ ...draft, anthropicExtraParamsText })}
      />}
    </div>
  </div>;
}

function ToggleJsonField({ label, enabled, text, onEnabledChange, onTextChange }: {
  label: string;
  enabled: boolean;
  text: string;
  onEnabledChange: (enabled: boolean) => void;
  onTextChange: (text: string) => void;
}) {
  return <div className={`${styles.fullWidth} ${styles.jsonOption}`}>
    <label><span>{label}</span><Switch label={label} checked={enabled} onChange={onEnabledChange} /></label>
    {enabled && <JsonEditor ariaLabel={label} value={text} onChange={onTextChange} />}
  </div>;
}

function effortOptions(optional: boolean) {
  return [
    ...(optional ? [{ value: "", label: t("不设置") }] : []),
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
  ];
}
