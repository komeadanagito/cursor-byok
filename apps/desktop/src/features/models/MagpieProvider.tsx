//! The local Magpie gateway as a provider: connect it, choose which of its chat models Cursor offers, and test them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type MagpieCatalog, type Model } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { Card } from "../../shared/ui/Card";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { checkIcon, searchIcon } from "../../shared/ui/icons";
import { brandIconUrl } from "../../shared/utils/brandIcons";
import { useMessage } from "../../shared/ui/message";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { PageActions } from "../../shell/PageActions";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import { MAGPIE_PROVIDER } from "./cursorProviders";
import { ModelCheck, ModelRow, ProviderIcon } from "./ProviderParts";
import styles from "./Providers.module.scss";

type GatewayModel = MagpieCatalog["models"][number];

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const vendor = (id: string) => id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
const knownVendors = new Map([
  ["anthropic", { name: "Anthropic", brand: "claude" }],
  ["openai", { name: "OpenAI", brand: "openai" }],
  ["google", { name: "Google", brand: "google" }],
  ["deepseek", { name: "DeepSeek", brand: "deepseek" }],
]);

export const enabledMagpieModels = (catalog: MagpieCatalog) => catalog.models.filter(model => !catalog.disabled.includes(model.id));

export const magpieSummary = (catalog: MagpieCatalog) =>
  `127.0.0.1:${catalog.port} · ${t("已启用 {enabled} / {total} 个模型", { enabled: enabledMagpieModels(catalog).length, total: catalog.models.length })}`;

/** Magpie's catalog: undefined while loading, null when the gateway is not connected. */
export function useMagpieCatalog() {
  const [catalog, setCatalog] = useState<MagpieCatalog | null | undefined>(undefined);
  const message = useMessage();
  const reload = useCallback(() => api.magpie().then(setCatalog, (cause: unknown) => {
    message(errorText(cause));
    setCatalog(null);
  }), [message]);
  useEffect(() => { void reload(); }, [reload]);
  return { catalog, setCatalog, reload };
}

export function MagpiePage({ catalog, setCatalog, models, busy: pageBusy, testing, testResults, batchTesting, onTest, onTestAll }: {
  catalog: MagpieCatalog | null | undefined;
  setCatalog: (catalog: MagpieCatalog | null) => void;
  /** Magpie's models as Cursor sees them: the enabled ones, keyed by gateway id in `model_id`. */
  models: Model[];
  busy: boolean;
  testing: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  batchTesting: boolean;
  onTest: (model: Model) => void;
  onTestAll: (models: Model[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(Promise.resolve());
  const message = useMessage();
  const cursorModels = useMemo(() => new Map(models.map(model => [model.model_id, model])), [models]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (cause) { message(errorText(cause)); } finally { setBusy(false); }
  };
  const connect = () => run(async () => {
    await api.connectMagpie();
    setCatalog(await api.magpie());
    await appStore.refresh();
  });
  const disconnect = () => run(async () => {
    await api.disconnectMagpie();
    setCatalog(null);
    await appStore.refresh();
  });
  // A choice applies at once; saves run one after another so the last click is the one that stays.
  const select = (ids: string[], on: boolean) => {
    if (!catalog) return;
    const enabled = new Set(enabledMagpieModels(catalog).map(model => model.id));
    for (const id of ids) {
      if (on) enabled.add(id);
      else enabled.delete(id);
    }
    setCatalog({ ...catalog, disabled: catalog.models.map(model => model.id).filter(id => !enabled.has(id)) });
    saving.current = saving.current.then(async () => {
      try {
        await api.selectMagpieModels([...enabled]);
        await appStore.refresh();
      } catch (cause) {
        message(errorText(cause));
        setCatalog(await api.magpie());
      }
    });
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const result = new Map<string, GatewayModel[]>();
    for (const model of catalog?.models ?? []) {
      const name = model.magpie_label ?? model.display_name ?? model.id;
      if (needle && !`${model.id} ${name}`.toLowerCase().includes(needle)) continue;
      const key = vendor(model.id);
      result.set(key, [...(result.get(key) ?? []), model]);
    }
    return [...result.entries()];
  }, [catalog, query]);

  if (catalog === undefined) return <Card className={styles.list}><div className={styles.empty}>{t("正在读取 Magpie 状态…")}</div></Card>;

  if (catalog === null) {
    return <Card className={styles.list}>
      <div className={styles.intro}>
        <ProviderIcon provider={MAGPIE_PROVIDER} size="3em" />
        <strong>{t("连接本机 Magpie 网关")}</strong>
        <span>{t("先在这台电脑上启动 Magpie，BYOK 会自动找到它并同步可用的对话模型。")}</span>
        <ul>
          <li><Icon icon={checkIcon} size="1em" />{t("自动发现本机端口，无需填写 API Key")}</li>
          <li><Icon icon={checkIcon} size="1em" />{t("启动时和每 10 分钟同步一次模型目录")}</li>
          <li><Icon icon={checkIcon} size="1em" />{t("独立于手动添加的供应商，互不影响")}</li>
        </ul>
        <button type="button" className={controls.primary} disabled={busy} onClick={() => void connect()}>{busy ? t("处理中…") : t("连接 Magpie")}</button>
      </div>
    </Card>;
  }

  const fallback = <ProviderIcon provider={MAGPIE_PROVIDER} />;
  return <>
    <PageActions>
      <label className={styles.search}>
        <Icon icon={searchIcon} size="1em" />
        <input value={query} placeholder={t("搜索模型名称或 ID")} aria-label={t("搜索模型名称或 ID")} onChange={event => setQuery(event.target.value)} />
      </label>
      <div className={styles.segmented}>
        <button type="button" disabled={pageBusy || models.length === 0} onClick={() => onTestAll(models)}>{batchTesting ? t("取消全部测试") : t("一键测试")}</button>
        <button type="button" disabled={busy} onClick={() => void connect()}>{t("同步目录")}</button>
        <button type="button" disabled={busy} onClick={() => void disconnect()}>{t("断开连接")}</button>
      </div>
    </PageActions>
    {groups.length === 0 ? <Card className={styles.list}><div className={styles.empty}>{t("没有匹配的模型")}</div></Card> : <div className={styles.groups}>
      {groups.map(([key, group]) => {
        const ids = group.map(model => model.id);
        const enabled = ids.filter(id => !catalog.disabled.includes(id)).length;
        const all = enabled === ids.length;
        const vendorInfo = knownVendors.get(key.toLowerCase());
        const logo = brandIconUrl(vendorInfo?.brand);
        return <Card key={key} className={styles.list}>
          <div className={styles.groupHeader}>
            {logo && <Icon mask={logo} />}
            <strong>{vendorInfo?.name ?? (key || t("其他"))}</strong>
            <span className={styles.groupCount}>{enabled} / {ids.length}</span>
            <button type="button" className={styles.textButton} onClick={() => select(ids, !all)}>{all ? t("全不选") : t("全选")}</button>
          </div>
            {group.map(model => {
              const on = !catalog.disabled.includes(model.id);
              const name = model.magpie_label ?? model.display_name ?? model.id;
              const cursorModel = on ? cursorModels.get(model.id) : undefined;
              const running = cursorModel ? testing.has(cursorModel.model_hash) : false;
              return <ModelRow
                key={model.id}
                modelId={model.id}
                name={name}
                fallback={fallback}
                muted={!on}
                badges={[...(model.reasoning ? [t("推理")] : []), ...(model.modalities?.input.includes("image") ? [t("图片")] : [])]}
                context={model.context_window ?? null}
                leading={<ModelCheck checked={on} label={t("启用 {model}", { model: name })} onChange={checked => select([model.id], checked)} />}
                trailing={cursorModel && <div className={styles.actions}>
                  <CursorModelTestResult compact state={testResults.get(cursorModel.model_hash)} testing={running} />
                  <TruncatedButton size="small" disabled={pageBusy && !running} label={running ? t("取消测试") : t("测试")} onClick={() => onTest(cursorModel)} />
                </div>}
              />;
            })}
        </Card>;
      })}
    </div>}
  </>;
}
