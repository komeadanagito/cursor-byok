//! Local Magpie gateway hook and classic modal selector for choosing enabled models.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type MagpieCatalog } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { TextInput } from "../../shared/ui/FormControls";
import { Modal } from "../../shared/ui/Modal";
import { useMessage } from "../../shared/ui/message";

type GatewayModel = MagpieCatalog["models"][number];

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const vendor = (id: string) => id.includes("/") ? id.slice(0, id.indexOf("/")) : "";

export const enabledMagpieModels = (catalog: MagpieCatalog) => catalog.models.filter((model) => !catalog.disabled.includes(model.id));

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

export function MagpieModelsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { catalog, setCatalog, reload } = useMagpieCatalog();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(Promise.resolve());
  const message = useMessage();

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

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

  const select = (ids: string[], on: boolean) => {
    if (!catalog) return;
    const enabled = new Set(enabledMagpieModels(catalog).map((model) => model.id));
    for (const id of ids) {
      if (on) enabled.add(id);
      else enabled.delete(id);
    }
    setCatalog({ ...catalog, disabled: catalog.models.map((model) => model.id).filter((id) => !enabled.has(id)) });
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
      const key = vendor(model.id) || t("其他");
      result.set(key, [...(result.get(key) ?? []), model]);
    }
    return [...result.entries()];
  }, [catalog, query]);

  return <Modal
    fullHeight
    open={open}
    title={t("Magpie 本地网关")}
    busy={busy}
    onClose={onClose}
    onSubmit={onClose}
    submitLabel={t("完成")}
  >
    {catalog === undefined
      ? <div style={{ padding: 12 }}>{t("正在读取 Magpie 状态…")}</div>
      : catalog === null
        ? <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span>{t("先在这台电脑上启动 Magpie，BYOK 会自动找到它并同步可用的对话模型。")}</span>
          <div>
            <Button variant="primary" disabled={busy} onClick={() => void connect()}>
              {busy ? t("处理中…") : t("连接 Magpie")}
            </Button>
          </div>
        </div>
        : <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px" }}>
              <TextInput
                value={query}
                placeholder={t("搜索模型名称或 ID")}
                aria-label={t("搜索模型名称或 ID")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button size="small" disabled={busy} onClick={() => void connect()}>{t("同步目录")}</Button>
            <Button size="small" disabled={busy} onClick={() => void disconnect()}>{t("断开连接")}</Button>
          </div>
          <div style={{ fontSize: 12, color: "var(--vscode-descriptionForeground)" }}>{magpieSummary(catalog)}</div>
          {groups.length === 0
            ? <div style={{ padding: 12, color: "var(--vscode-descriptionForeground)" }}>{t("没有匹配的模型")}</div>
            : groups.map(([groupName, groupModels]) => {
              const ids = groupModels.map((model) => model.id);
              const enabledCount = ids.filter((id) => !catalog.disabled.includes(id)).length;
              const all = enabledCount === ids.length;
              return <div key={groupName} style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: "1px solid var(--vscode-sideBar-border)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <strong>{groupName} ({enabledCount}/{ids.length})</strong>
                  <Button size="small" onClick={() => select(ids, !all)}>{all ? t("全不选") : t("全选")}</Button>
                </div>
                {groupModels.map((model) => {
                  const on = !catalog.disabled.includes(model.id);
                  const name = model.magpie_label ?? model.display_name ?? model.id;
                  return <Checkbox
                    key={model.id}
                    checked={on}
                    label={`${name} (${model.id})`}
                    onChange={(checked) => select([model.id], checked)}
                  />;
                })}
              </div>;
            })}
        </div>}
  </Modal>;
}
