//! The Cursor page: takeover, the provider list, and the open provider with its models, editor and settings.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, configuredPluginModels, type Model, type ModelInput } from "../../shared/api";
import { CursorCaGate, CursorCaProvider } from "./CursorGates";
import { CursorModelEditor, emptyCursorModelDraft, type CursorModelDraft } from "./CursorModelEditor";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import { MAGPIE_PROVIDER, manualProviders, mergeOrder, pluginProviders, type ManualProvider } from "./cursorProviders";
import styles from "./CursorSettings.module.scss";
import { PageContent } from "../../shell/layout/PageContent";
import { LegacyModelImport } from "./LegacyModelImport";
import { MagpiePage, magpieSummary, useMagpieCatalog } from "./MagpieProvider";
import { ProviderList, protocolLabel } from "./ProviderList";
import { ProviderPage } from "./ProviderPage";
import { ProviderIcon, ProviderTitle } from "./ProviderParts";
import providerStyles from "./Providers.module.scss";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { addIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { modelProviderName } from "../../shared/utils/modelProvider";

export function CursorSettingsPage() {
  const { models, cursorHarness, cursorBusy, plugins } = useAppStore();
  const navigate = useNavigate();
  const message = useMessage();
  const [draft, setDraft] = useState<CursorModelDraft | null>(null);
  const [editing, setEditing] = useState<Model | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [caCommand, setCaCommand] = useState<string | null>(null);
  const [waitingForCaRefresh, setWaitingForCaRefresh] = useState(false);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [confirmDisableTakeover, setConfirmDisableTakeover] = useState(false);
  const [testingModelHashes, setTestingModelHashes] = useState<Set<string>>(() => new Set());
  const [modelTestResults, setModelTestResults] = useState<Map<string, CursorModelTestState>>(() => new Map());
  const [savingAndTesting, setSavingAndTesting] = useState(false);
  const [batchTesting, setBatchTesting] = useState(false);
  // The open provider lives in the URL so the plugin page can link straight to
  // Magpie; keepAlive keeps the page mounted, so this seeds the first render.
  const [searchParams, setSearchParams] = useSearchParams();
  const [openKey, setOpenKey] = useState<string | null>(() => searchParams.get("open"));
  const [settingsGroup, setSettingsGroup] = useState<ManualProvider | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupBaseUrlDraft, setGroupBaseUrlDraft] = useState("");
  const [groupApiKeyDraft, setGroupApiKeyDraft] = useState("");
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const activeModelTests = useRef(new Map<string, { testId: string; controller: AbortController; cancelling: boolean }>());
  const caReady = cursorHarness?.ca === "ready";
  const cursorTakenOver = cursorHarness?.settings_applied ?? false;
  const takeoverLabel = cursorTakenOver ? t("关闭接管Cursor") : t("开启接管Cursor");
  const pluginModels = configuredPluginModels(plugins);
  const testTargets = [
    ...models.map((model) => ({ model_hash: model.model_hash, display_name: model.display_name })),
    ...pluginModels.map((model) => ({ model_hash: model.id, display_name: model.displayName })),
  ];
  const magpieModels = models.filter(m => m.gateway_capabilities);
  const providers = [...manualProviders(models), ...pluginProviders(pluginModels)];
  const opened = openKey === MAGPIE_PROVIDER ? MAGPIE_PROVIDER : providers.find(provider => provider.key === openKey) ?? null;
  const magpie = useMagpieCatalog();

  // A provider whose last model was deleted or renamed away is gone: back to the list.
  // keepAlive keeps this page mounted, so a link from the plugin page must
  // still switch the open provider when only the query changes.
  useEffect(() => {
    const key = searchParams.get("open");
    if (key !== openKey) setOpenKey(key);
  }, [searchParams]);

  useEffect(() => {
    if (openKey && !opened) open(null);
  }, [openKey, opened]);

  const open = (key: string | null) => {
    if (key === MAGPIE_PROVIDER) void magpie.reload();
    setOpenKey(key);
    setSearchParams(params => {
      if (key === null) params.delete("open");
      else params.set("open", key);
      return params;
    }, { replace: true });
  };

  useEffect(() => {
    if (caCommand) void api.copyCursorText(caCommand);
  }, [caCommand]);

  const initializeCa = async () => {
    const status = await appStore.initializeCursorCa();
    if (status?.ca === "untrusted" && status.ca_install_command) setCaCommand(status.ca_install_command);
  };
  const openNew = (provider?: ManualProvider) => {
    const next = emptyCursorModelDraft();
    next.model.sort_order = models.length + 1;
    const sample = provider?.models[0];
    if (sample) {
      next.providerId = `builtin/${sample.type}`;
      next.model = { ...next.model, type: sample.type, base_url: sample.base_url, use_full_url: sample.use_full_url, openai_endpoint: sample.openai_endpoint, group_name: sample.group_name };
    }
    setEditing(null);
    setModelOptions([]);
    setDraft(next);
  };
  const openEdit = (model: Model) => {
    setEditing(model);
    setModelOptions([model.model_id]);
    setDraft({
      providerId: `builtin/${model.type}`,
      editing: true,
      model: modelInput(model),
      openAIExtraParamsText: JSON.stringify(model.openai_extra_params, null, 2),
      customHeadersText: "",
      anthropicExtraParamsText: JSON.stringify(model.anthropic_extra_params, null, 2),
    });
  };
  const discover = async (): Promise<boolean> => {
    if (!draft) return false;
    setDiscovering(true);
    try {
      const custom_headers = editing && !draft.customHeadersText.trim() ? null : parseHeaders(draft.customHeadersText);
      const result = await api.discoverModels({
        model_hash: editing?.model_hash,
        type: draft.model.type,
        base_url: draft.model.base_url.trim(),
        api_key: draft.model.api_key.trim(),
        custom_headers_enabled: draft.model.custom_headers_enabled,
        custom_headers,
      });
      setModelOptions([...new Set(result.models)]);
      return true;
    } catch (cause) {
      message(errorText(cause));
      return false;
    } finally {
      setDiscovering(false);
    }
  };
  const persist = async (): Promise<Model | null> => {
    if (!draft) return null;
    const input = draftInput(draft, editing !== null);
    if (editing) return appStore.updateCursorModel(editing.model_hash, input);
    return (await appStore.createModels([input]))?.[0] ?? null;
  };
  const save = async () => {
    try {
      if (await persist()) {
        setDraft(null);
        setEditing(null);
      }
    } catch (cause) {
      message(errorText(cause));
    }
  };
  const cancelModelTest = async (modelHash: string) => {
    const active = activeModelTests.current.get(modelHash);
    if (!active || active.cancelling) return;
    active.cancelling = true;
    active.controller.abort();
    try {
      await api.cancelModelTest(modelHash, active.testId);
    } catch (cause) {
      message(t("取消测试失败：{error}", { error: errorText(cause) }), { duration: 5000 });
    }
  };
  const cancelAllModelTests = async () => {
    await Promise.all([...activeModelTests.current.keys()].map((modelHash) => cancelModelTest(modelHash)));
  };
  const testModel = async (model: { model_hash: string; display_name: string }, notify = true): Promise<"success" | "failure" | "cancelled"> => {
    if (activeModelTests.current.has(model.model_hash)) {
      await cancelModelTest(model.model_hash);
      return "cancelled";
    }
    const active = { testId: crypto.randomUUID(), controller: new AbortController(), cancelling: false };
    activeModelTests.current.set(model.model_hash, active);
    setTestingModelHashes((current) => new Set(current).add(model.model_hash));
    try {
      const result = await api.testModel(model.model_hash, active.testId, active.controller.signal);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "success", result }));
      if (notify) message(t("模型 {model} 连通性测试成功（{duration} ms）", { model: model.display_name, duration: result.duration_ms }));
      return "success";
    } catch (cause) {
      if (active.cancelling || active.controller.signal.aborted) {
        setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "cancelled" }));
        return "cancelled";
      }
      const error = errorText(cause);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "error", error }));
      if (notify) message(t("连通性测试失败：{error}", { error }), { duration: 5000 });
      return "failure";
    } finally {
      if (activeModelTests.current.get(model.model_hash) === active) activeModelTests.current.delete(model.model_hash);
      setTestingModelHashes((current) => {
        const next = new Set(current);
        next.delete(model.model_hash);
        return next;
      });
    }
  };
  const saveAndTest = async () => {
    setSavingAndTesting(true);
    let saved: Model | null = null;
    try {
      saved = await persist();
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingAndTesting(false);
    }
    if (!saved) return;
    setEditing(saved);
    await testModel(saved);
    await appStore.refresh();
  };
  const testAllModels = async (targets: { model_hash: string; display_name: string }[]) => {
    if (!targets.length || batchTesting) return;
    setBatchTesting(true);
    try {
      const results = await Promise.all(targets.map((model) => testModel(model, false)));
      const successful = results.filter((result) => result === "success").length;
      const failed = results.filter((result) => result === "failure").length;
      const cancelled = results.filter((result) => result === "cancelled").length;
      message(cancelled > 0
        ? t("连通性测试已取消：成功 {successful}，失败 {failed}", { successful, failed })
        : failed === 0
          ? t("全部 {count} 个模型连通性测试成功", { count: targets.length })
          : t("连通性测试完成：成功 {successful}，失败 {failed}", { successful, failed }),
      { duration: failed === 0 && cancelled === 0 ? 2400 : 5000 });
    } finally {
      setBatchTesting(false);
    }
  };
  const duplicateModel = (model: Model) => {
    const names = new Set(models.map(item => item.display_name));
    const baseName = t("{name} 副本", { name: model.display_name });
    let displayName = baseName;
    for (let suffix = 2; names.has(displayName); suffix += 1) displayName = `${baseName} ${suffix}`;
    setEditing(null);
    setModelOptions([model.model_id]);
    setDraft({
      providerId: `builtin/${model.type}`,
      model: { ...modelInput(model), sort_order: models.length + 1, display_name: displayName, custom_headers_enabled: false },
      openAIExtraParamsText: JSON.stringify(model.openai_extra_params, null, 2),
      customHeadersText: "", anthropicExtraParamsText: JSON.stringify(model.anthropic_extra_params, null, 2),
    });
  };
  const toggleTestAll = (targets: { model_hash: string; display_name: string }[]) => void (batchTesting ? cancelAllModelTests() : testAllModels(targets));
  const openGroupSettings = (group: ManualProvider) => {
    setGroupNameDraft(group.models.find((model) => model.group_name?.trim())?.group_name?.trim() ?? "");
    setGroupBaseUrlDraft(sharedValue(group.models.map((model) => model.base_url)) ?? "");
    setGroupApiKeyDraft("");
    setSettingsGroup(group);
  };
  const saveGroupSettings = async () => {
    if (!settingsGroup) return;
    const group_name = groupNameDraft.trim() || null;
    const base_url = groupBaseUrlDraft.trim();
    const api_key = groupApiKeyDraft.trim();
    setGroupSettingsBusy(true);
    try {
      for (const model of settingsGroup.models) {
        const input: ModelInput = {
          ...modelInput(model),
          group_name,
          ...(base_url ? { base_url } : {}),
          ...(api_key ? { api_key } : {}),
        };
        if (input.group_name === (model.group_name ?? null)
          && input.base_url === model.base_url
          && !api_key) continue;
        await api.updateModel(model.model_hash, input);
      }
      await appStore.refresh();
      open(`manual:${modelProviderName({ group_name, base_url: base_url || settingsGroup.models[0].base_url })}`);
      setSettingsGroup(null);
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setGroupSettingsBusy(false);
    }
  };
  const reorderModels = useCallback(async (subset: string[]) => {
    const all = appStore.getSnapshot().models.filter(model => !model.gateway_capabilities).map(model => model.model_hash);
    if (!await appStore.reorderCursorModels(mergeOrder(all, subset))) {
      message(appStore.getSnapshot().error || t("排序失败"));
    }
  }, [message]);

  const refreshCa = async () => {
    await appStore.refresh();
    if (appStore.getSnapshot().cursorHarness?.ca !== "ready") setWaitingForCaRefresh(false);
  };
  const openCaTerminal = () => {
    if (caCommand) void api.openCursorCaInstallTerminal(caCommand).catch((cause) => message(errorText(cause)));
    setCaCommand(null);
    setWaitingForCaRefresh(true);
  };
  const providerView = opened === MAGPIE_PROVIDER
    ? <MagpiePage
      catalog={magpie.catalog}
      setCatalog={magpie.setCatalog}
      models={magpieModels}
      busy={cursorBusy}
      testing={testingModelHashes}
      testResults={modelTestResults}
      batchTesting={batchTesting}
      onTest={(model) => void testModel(model)}
      onTestAll={toggleTestAll}
    />
    : opened
      ? <ProviderPage
        provider={opened}
        busy={cursorBusy}
        testing={testingModelHashes}
        testResults={modelTestResults}
        onTest={(model) => void testModel(model)}
        onEdit={openEdit}
        onDuplicate={(model) => void duplicateModel(model)}
        onDelete={setDeleting}
        onReorder={reorderModels}
      />
      : null;
  const content = <CursorCaProvider><CursorCaGate busy={cursorBusy} waitingForRefresh={waitingForCaRefresh} onInitialize={() => void initializeCa()} onRefresh={() => void refreshCa()}>
    <div className={styles.page}>
      {providerView ?? <LegacyModelImport>{({ busy: importingLegacyModels, previewing, open: openImport }) => <ProviderList
        providers={providers}
        magpie={magpie.catalog}
        magpieHashes={magpieModels.map(model => model.model_hash)}
        testResults={modelTestResults}
        busy={cursorBusy || importingLegacyModels || !caReady}
        previewingImport={previewing}
        onOpen={open}
        onAdd={() => openNew()}
        onImport={openImport}
      />}</LegacyModelImport>}
    </div>
  </CursorCaGate></CursorCaProvider>;

  const editorTestState = editing ? modelTestResults.get(editing.model_hash) : undefined;
  const editorTesting = Boolean(editing && testingModelHashes.has(editing.model_hash));
  const rowHeight = 53;
  const estimatedModelHeight = Math.max(380, opened === MAGPIE_PROVIDER
    ? ((magpie.catalog?.models.length ?? 0) + 2) * rowHeight
    : opened ? opened.models.length * rowHeight : (providers.length + 2) * rowHeight);
  const title = opened === MAGPIE_PROVIDER
    ? <ProviderTitle icon={<ProviderIcon provider={MAGPIE_PROVIDER} size="0.9em" />} name="Magpie" detail={magpie.catalog ? magpieSummary(magpie.catalog) : undefined} onBack={() => open(null)} />
    : opened
      ? <ProviderTitle icon={<ProviderIcon provider={opened} size="0.9em" />} name={opened.name}
        detail={[opened.kind === "manual" && opened.host !== opened.name ? opened.host : null, protocolLabel(opened), t("{count} 个模型", { count: opened.models.length })].filter(Boolean).join(" · ")}
        onBack={() => open(null)} />
      : "Cursor";
  const openedTargets = opened && opened !== MAGPIE_PROVIDER
    ? opened.kind === "manual" ? opened.models : opened.models.map(model => ({ model_hash: model.id, display_name: model.displayName }))
    : [];
  const testAllButton = (targets: { model_hash: string; display_name: string }[]) =>
    <button type="button" disabled={cursorBusy || targets.length === 0 || (!batchTesting && testingModelHashes.size > 0)} onClick={() => toggleTestAll(targets)}>{batchTesting ? t("取消全部测试") : t("一键测试")}</button>;
  const addButton = (label: string, onClick: () => void) => <TooltipTrigger label={caReady ? label : t("请先初始化 CA")}>
    <button className={controls.iconButton} aria-label={label} disabled={!caReady || cursorBusy} onClick={onClick}><Icon icon={addIcon} size="1.1em" /></button>
  </TooltipTrigger>;

  return <>
    <PageActions position="left">
      <div className={styles.takeoverActions}>
        <span className={styles.takeoverStatus}>{cursorTakenOver ? t("已接管") : t("未接管")}</span>
        <TooltipTrigger label={takeoverLabel}>
          <Switch
            checked={cursorTakenOver}
            disabled={cursorBusy || (!cursorTakenOver && !caReady)}
            label={takeoverLabel}
            onChange={(enabled) => {
              if (enabled) void appStore.setCursorEnabled(true);
              else setConfirmDisableTakeover(true);
            }}
          />
        </TooltipTrigger>
      </div>
    </PageActions>
    {opened === null && <PageActions>
      <div className={providerStyles.segmented}>{testAllButton(testTargets)}</div>
      {addButton(t("添加供应商"), () => openNew())}
    </PageActions>}
    {opened !== null && opened !== MAGPIE_PROVIDER && <PageActions>
      <div className={providerStyles.segmented}>
        {testAllButton(openedTargets)}
        {opened.kind === "manual"
          ? <button type="button" disabled={cursorBusy} onClick={() => openGroupSettings(opened)}>{t("供应商设置")}</button>
          : <button type="button" onClick={() => navigate("/plugins")}>{t("插件设置")}</button>}
      </div>
      {opened.kind === "manual" && addButton(t("添加模型"), () => openNew(opened))}
    </PageActions>}
    <PageContent title={title} sections={[{ key: `cursor-settings:${openKey ?? "list"}`, estimatedHeight: estimatedModelHeight, content }]} />
    <ConfirmDialog
      open={confirmDisableTakeover}
      title={t("关闭接管Cursor？")}
      cancelLabel={t("取消")}
      confirmLabel={t("关闭接管")}
      onCancel={() => setConfirmDisableTakeover(false)}
      onConfirm={() => {
        setConfirmDisableTakeover(false);
        void appStore.setCursorEnabled(false);
      }}
    >
      <p>{t("关闭后将移除 Cursor 本地代理配置。如果你需要登陆官方账号，通常不需要关闭操作，推荐直接登陆你的账号即可(byok模型与官方账号的模型已支持无缝衔接)，是否继续关闭并清理代理？")}</p>
    </ConfirmDialog>
    <Modal fullHeight open={draft !== null} title={editing ? t("编辑模型") : t("添加模型")} banner={draft && (editorTesting || editorTestState) ? <CursorModelTestResult state={editorTestState} testing={editorTesting} /> : undefined} busy={cursorBusy || savingAndTesting} onClose={() => { if (editing && editorTesting) void cancelModelTest(editing.model_hash); setDraft(null); setEditing(null); }} onSubmit={() => void save()} submitLabel={t("保存")} secondaryAction={<button type="button" className={controls.secondary} disabled={cursorBusy || savingAndTesting} onClick={() => void (editorTesting && editing ? cancelModelTest(editing.model_hash) : saveAndTest())}>{savingAndTesting ? t("处理中…") : editorTesting ? t("取消测试") : t("保存并测试")}</button>}>
      {draft && <>
        <CursorModelEditor draft={draft} modelOptions={modelOptions} discovering={discovering} onChange={setDraft} onDiscover={discover} />
      </>}
    </Modal>
    <ConfirmDialog open={caCommand !== null} title={t("安装本地 CA")} cancelLabel={t("关闭")} confirmLabel={t("打开终端")} onCancel={() => setCaCommand(null)} onConfirm={openCaTerminal}>
      <div className={styles.editor}><strong>{t("需要授权安装证书")}</strong><span>{t("安装命令已自动复制。点击“打开终端”，将命令粘贴到终端中执行，并按提示输入密码。")}</span><pre className={styles.command}>{caCommand}</pre></div>
    </ConfirmDialog>
    <Modal open={settingsGroup !== null} title={t("供应商设置")} busy={groupSettingsBusy || cursorBusy} onClose={() => setSettingsGroup(null)} onSubmit={() => void saveGroupSettings()} submitLabel={t("保存")}>
      {settingsGroup && <div className={styles.editor}>
        <FormField label={t("供应商名称")} hint={t("应用于该供应商下的全部模型，并作为 Cursor 模型选择器中的徽章标签；清空则恢复显示服务器域名。")}>
          <TextInput placeholder={settingsGroup.host} value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} />
        </FormField>
        <FormField label={t("服务器地址")} hint={t("修改后应用于该供应商下的全部模型；留空保持各模型现有配置不变。")}>
          <TextInput placeholder={t("留空保持不变")} value={groupBaseUrlDraft} onChange={(event) => setGroupBaseUrlDraft(event.target.value)} />
        </FormField>
        <FormField label="API Key" hint={t("修改后应用于该供应商下的全部模型；留空保持各模型现有配置不变。")}>
          <SecretTextInput placeholder={t("留空保持不变")} autoComplete="off" value={groupApiKeyDraft} onChange={(event) => setGroupApiKeyDraft(event.target.value)} />
        </FormField>
      </div>}
    </Modal>
    <ConfirmDialog open={deleting !== null} title={t("删除模型")} cancelLabel={t("取消")} confirmLabel={t("删除")} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void appStore.deleteModel(deleting.model_hash); setDeleting(null); }}><p>{t("确定删除这个模型吗？")}</p></ConfirmDialog>
  </>;
}

function modelInput(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return { ...input, api_key: "", custom_headers: null };
}

/** 组内所有模型取值一致时返回该值,否则返回 null(表单留空表示保持不变)。 */
function sharedValue(values: string[]): string | null {
  const [first, ...rest] = values;
  if (first === undefined) return null;
  return rest.every((value) => value === first) ? first : null;
}

function draftInput(draft: CursorModelDraft, editing: boolean): ModelInput {
  const model = {
    ...draft.model,
    display_name: draft.model.display_name.trim(),
    base_url: draft.model.base_url.trim(),
    api_key: draft.model.api_key.trim(),
    tooltip_data: draft.model.tooltip_data.trim(),
    model_id: draft.model.model_id.trim(),
    openai_extra_params: parseObject(draft.openAIExtraParamsText, t("OpenAI 额外参数")),
    custom_headers: editing && !draft.customHeadersText.trim() ? null : parseHeaders(draft.customHeadersText),
    anthropic_extra_params: parseObject(draft.anthropicExtraParamsText, t("Anthropic 额外参数")),
  };
  if (!model.display_name || !model.base_url || (!editing && !model.api_key) || !model.tooltip_data || !model.model_id) throw new Error(t("服务器地址或完整请求 URL、API Key、模型名称、显示名称和备注不能为空"));
  for (const [label, value] of [[t("上下文窗口 Token"), model.context_window_tokens], [t("最大输出 Token"), model.type === "openai" ? model.max_completion_tokens : model.anthropic_max_tokens], [t("思考预算 Token"), model.thinking_budget_tokens]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(t("{label} 必须是大于 0 的整数", { label }));
  }
  return model;
}

function parseHeaders(text: string): Record<string, string> {
  const parsed = parseObject(text, t("自定义 Headers"));
  if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error(t("自定义 Headers 的值必须都是字符串"));
  return parsed as Record<string, string>;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(t("{label} 必须是有效 JSON", { label })); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("{label} 必须是 JSON 对象", { label }));
  return parsed as Record<string, unknown>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
