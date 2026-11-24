//! An open manual or plugin provider: its models, sortable for manual ones, each testable and, when manual, editable.
import { useEffect, useRef } from "react";
import Sortable from "sortablejs";
import type { Model } from "../../shared/api";
import { ActionMenu } from "../../shared/ui/ActionMenu";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { dragIcon } from "../../shared/ui/icons";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import type { CursorProvider, ManualProvider } from "./cursorProviders";
import { ModelRow, ProviderIcon } from "./ProviderParts";
import styles from "./Providers.module.scss";

type ModelActions = {
  busy: boolean;
  testing: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  onTest: (target: { model_hash: string; display_name: string }) => void;
  onEdit: (model: Model) => void;
  onDuplicate: (model: Model) => void;
  onDelete: (model: Model) => void;
  onReorder: (modelHashes: string[]) => void;
};

export function ProviderPage({ provider, ...actions }: ModelActions & { provider: CursorProvider }) {
  if (provider.kind === "manual") return <ManualModels provider={provider} {...actions} />;
  const icon = <ProviderIcon provider={provider} />;
  return <Card className={styles.list}>
    {provider.models.map(model => {
      const testing = actions.testing.has(model.id);
      return <ModelRow
        key={model.id}
        modelId={model.modelId}
        name={model.displayName}
        fallback={icon}
        badges={model.images ? [] : [t("不支持图片")]}
        context={null}
        trailing={<div className={styles.actions}>
          <CursorModelTestResult compact state={actions.testResults.get(model.id)} testing={testing} />
          <TruncatedButton size="small" disabled={actions.busy && !testing} label={testing ? t("取消测试") : t("测试")} onClick={() => actions.onTest({ model_hash: model.id, display_name: model.displayName })} />
        </div>}
      />;
    })}
  </Card>;
}

function ManualModels({ provider, busy, testing, testResults, onTest, onEdit, onDuplicate, onDelete, onReorder }: ModelActions & { provider: ManualProvider }) {
  const list = useRef<HTMLDivElement>(null);
  const sortable = useRef<Sortable | null>(null);
  const current = useRef(provider.models);
  const reorder = useRef(onReorder);
  current.current = provider.models;
  reorder.current = onReorder;

  useEffect(() => {
    if (!list.current) return;
    sortable.current = Sortable.create(list.current, {
      animation: 160,
      dataIdAttr: "data-id",
      handle: `.${styles.handle}`,
      ghostClass: styles.sortGhost,
      chosenClass: styles.sortChosen,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      onEnd: () => {
        const next = sortable.current?.toArray() ?? [];
        const previous = current.current.map(model => model.model_hash);
        // Sortable moved the DOM itself; put it back so React stays the owner of the order.
        sortable.current?.sort(previous, false);
        if (next.join() !== previous.join()) reorder.current(next);
      },
    });
    return () => {
      sortable.current?.destroy();
      sortable.current = null;
    };
  }, []);

  useEffect(() => {
    sortable.current?.option("disabled", busy);
  }, [busy]);

  const icon = <ProviderIcon provider={provider} />;
  const mixed = provider.types.length > 1;
  return <Card className={styles.list}>
    <div ref={list}>
      {provider.models.map(model => {
        const running = testing.has(model.model_hash);
        const badges = [
          ...(mixed ? [model.type === "anthropic" ? "Anthropic" : "OpenAI"] : []),
          ...(model.type === "openai" && model.openai_endpoint === "/v1/chat/completions" ? ["Chat Completions"] : []),
          ...(model.supports_images ? [] : [t("不支持图片")]),
        ];
        return <ModelRow
          key={model.model_hash}
          dataId={model.model_hash}
          modelId={model.model_id}
          name={model.display_name}
          fallback={icon}
          badges={badges}
          context={model.context_window_tokens}
          leading={<button type="button" className={styles.handle} disabled={busy} aria-label={t("拖动排序")} title={t("拖动排序")}>
            <Icon icon={dragIcon} size="1.1em" />
          </button>}
          trailing={<div className={styles.actions}>
            <CursorModelTestResult compact state={testResults.get(model.model_hash)} testing={running} />
            <TruncatedButton size="small" disabled={busy && !running} label={running ? t("取消测试") : t("测试")} onClick={() => onTest(model)} />
            <TruncatedButton size="small" disabled={busy} label={t("编辑")} onClick={() => onEdit(model)} />
            <ActionMenu label={t("更多")} disabled={busy} items={[
              { id: "duplicate", label: t("复制"), onSelect: () => onDuplicate(model) },
              { id: "delete", label: t("删除"), onSelect: () => onDelete(model) },
            ]} />
          </div>}
        />;
      })}
    </div>
  </Card>;
}
