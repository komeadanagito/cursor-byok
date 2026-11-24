import { useEffect, useState } from "react";
import { CallList } from "./CallList";
import { PageActions } from "../../shell/PageActions";
import { Checkbox } from "../../shared/ui/Checkbox";
import { Select } from "../../shared/ui/Select";
import { PageContent } from "../../shell/layout/PageContent";
import { appStore, useAppStore } from "../../shared/store/appStore";

const CALL_REFRESH_INTERVAL_MS = 2_000;

export function CallsPage() {
  const { calls, theme } = useAppStore();
  const dark = theme === "default-dark";
  const [model, setModel] = useState("");
  const [conversation, setConversation] = useState("");
  const [agent, setAgent] = useState("");
  const [failures, setFailures] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      if (document.visibilityState === "visible") await appStore.refreshCalls();
      if (!disposed) timer = window.setTimeout(() => void poll(), CALL_REFRESH_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void appStore.refreshCalls();
    };
    timer = window.setTimeout(() => void poll(), CALL_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const models = [...new Map(calls.map((call) => [call.model_id, call.display_name])).entries()];
  const conversations = [...new Set(calls.map((call) => call.conversation_id).filter(Boolean))];
  const agentId = (call: (typeof calls)[number]) => call.run_kind === "subagent" ? `subagent:${call.subagent_kind ?? ""}` : call.run_kind ?? "unknown";
  const agents = [...new Map(calls.map((call) => [agentId(call), call.run_kind === "subagent" ? call.subagent_kind || t("子代理") :
    call.run_kind === "root" ? t("主代理") : t("未记录代理")])).entries()];
  const filtered = calls.filter((call) => (!model || call.model_id === model)
    && (!agent || agentId(call) === agent)
    && (!conversation || call.conversation_id === conversation)
    && (!failures || ["failed", "error"].includes(call.status)));

  return <>
    <PageActions>
      <Select value={model} ariaLabel={t("筛选模型")} onChange={setModel} options={[{ value: "", label: t("全部模型") }, ...models.map(([value, label]) => ({ value, label }))]} />
      <Select value={conversation} ariaLabel={t("筛选会话")} onChange={setConversation} options={[{ value: "", label: t("全部会话") }, ...conversations.map((value) => ({ value, label: value.slice(0, 12) }))]} />
      <Select value={agent} ariaLabel={t("筛选代理")} onChange={setAgent} options={[{ value: "", label: t("全部代理") }, ...agents.map(([value, label]) => ({ value, label }))]} />
      <Checkbox checked={failures} onChange={setFailures} label={t("仅失败")} />
    </PageActions>
    <PageContent title={t("调用")} sections={[
      { key: "calls", estimatedHeight: 1_200, content: <CallList calls={filtered} dark={dark} onOpenExternal={(call) => void appStore.openCallDetails(call.call_id)} /> },
    ]} />
  </>;
}
