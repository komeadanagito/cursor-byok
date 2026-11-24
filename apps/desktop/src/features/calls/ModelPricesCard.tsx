//! Editable per-(provider_url, model_id) price table below the call list on the calls page.
import { useState } from "react";
import type { LlmCall, ModelPrice, ModelPriceEntry } from "../../shared/api";
import { api } from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { useMessage } from "../../shared/ui/message";
import { Select } from "../../shared/ui/Select";
import { TextInput } from "../../shared/ui/FormControls";
import { providerIcon, windowCloseIcon } from "../../shared/ui/icons";
import { modelLogo } from "../../shared/utils/brandIcons";
import controls from "../../shared/ui/Controls.module.scss";
import { formatMoney } from "../../shared/utils/numberFormat";
import { parseRate, periodCost } from "./modelPrices";
import styles from "./ModelPricesCard.module.scss";

type Draft = { input: string; cacheRead: string; cacheWrite: string; output: string };

function draftOf(price: ModelPrice | null): Draft {
  return {
    input: price?.input_per_million != null ? String(price.input_per_million) : "",
    cacheRead: price?.cache_read_per_million != null ? String(price.cache_read_per_million) : "",
    cacheWrite: price?.cache_write_per_million != null ? String(price.cache_write_per_million) : "",
    output: price?.output_per_million != null ? String(price.output_per_million) : "",
  };
}

const keyOf = (entry: ModelPriceEntry) => `${entry.provider_url}${entry.model_id}`;

function PriceRow({ entry, calls }: { entry: ModelPriceEntry; calls: LlmCall[] }) {
  const message = useMessage();
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry.price));
  const [currency, setCurrency] = useState<"USD" | "CNY">(entry.price?.currency ?? "USD");

  const field = (name: keyof Draft) => ({
    value: draft[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((current) => ({ ...current, [name]: event.target.value })),
    onBlur: () => void save(),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") void save();
    },
  });

  const save = async () => {
    // Nothing to price until at least one rate is filled in.
    if (!draft.input.trim() && !draft.cacheRead.trim() && !draft.cacheWrite.trim() && !draft.output.trim() && !entry.price) {
      return;
    }
    const input = parseRate(draft.input);
    const output = parseRate(draft.output);
    const cacheRead = draft.cacheRead.trim() === "" ? null : parseRate(draft.cacheRead);
    const cacheWrite = draft.cacheWrite.trim() === "" ? null : parseRate(draft.cacheWrite);
    if (input === null || output === null) {
      message(t("输入与输出每百万 token 价格必须是非负数字"), { duration: 4000 });
      return;
    }
    if (draft.cacheRead.trim() !== "" && cacheRead === null || draft.cacheWrite.trim() !== "" && cacheWrite === null) {
      message(t("缓存价格必须是非负数字，留空则与输入价相同"), { duration: 4000 });
      return;
    }
    try {
      await api.setModelPrice({
        provider_url: entry.provider_url,
        model_id: entry.model_id,
        input_per_million: input,
        output_per_million: output,
        cache_read_per_million: cacheRead,
        cache_write_per_million: cacheWrite,
        currency,
      });
      await appStore.refreshModelPrices();
    } catch (error) {
      message(error instanceof Error ? error.message : String(error), { duration: 4000 });
    }
  };

  const clear = async () => {
    try {
      await api.deleteModelPrice({ provider_url: entry.provider_url, model_id: entry.model_id });
      await appStore.refreshModelPrices();
    } catch (error) {
      message(error instanceof Error ? error.message : String(error), { duration: 4000 });
    }
  };

  const cost = periodCost(calls, entry.provider_url, entry.model_id, entry.price);
  const costText = cost === null ? "—" : formatMoney(entry.price!.currency, cost);
  return (
    <div className={`${styles.row} ${entry.price ? "" : styles.unpriced}`} role="row">
      <span className={styles.modelCell} role="cell">
        <Icon className={styles.logo} mask={modelLogo({ model_id: entry.model_id, base_url: entry.provider_url })} icon={providerIcon} size="1.15em" />
        <span className={styles.modelName}>
          <span className={styles.modelId} title={entry.model_id}>{entry.model_id}</span>
          <span className={styles.channel} title={entry.provider_url}>{entry.channel_name}</span>
        </span>
      </span>
      <TextInput className={styles.rate} inputMode="decimal" aria-label={t("输入价（每百万）")} {...field("input")} />
      <TextInput className={styles.rate} inputMode="decimal" placeholder={entry.price ? t("同输入") : undefined} aria-label={t("缓存读取价，留空与输入相同")} {...field("cacheRead")} />
      <TextInput className={styles.rate} inputMode="decimal" placeholder={entry.price ? t("同输入") : undefined} aria-label={t("缓存写入价，留空与输入相同")} {...field("cacheWrite")} />
      <TextInput className={styles.rate} inputMode="decimal" aria-label={t("输出价（每百万）")} {...field("output")} />
      <span className={styles.currency} role="cell">
        <Select
          value={currency}
          ariaLabel={t("币种")}
          options={[{ value: "USD", label: "USD" }, { value: "CNY", label: "CNY" }]}
          onChange={(value) => setCurrency(value as "USD" | "CNY")}
        />
      </span>
      <span className={styles.cost} role="cell" title={cost === null ? t("未定价") : undefined}>{costText}</span>
      <span className={styles.clear} role="cell">
        {entry.price && (
          <button type="button" className={controls.iconButton} aria-label={t("清除价格")} title={t("清除价格")} onClick={() => void clear()}>
            <Icon icon={windowCloseIcon} size="0.9em" />
          </button>
        )}
      </span>
    </div>
  );
}

export function ModelPricesCard({ calls }: { calls: LlmCall[] }) {
  const { modelPrices } = useAppStore();
  if (modelPrices.length === 0) return null;
  return (
    <Card className={styles.card}>
      <div className={styles.table} role="table" aria-label={t("模型价格")}>
        <div className={`${styles.row} ${styles.header}`} role="row">
          <span role="columnheader">{t("模型价格 · 每百万 token")}</span>
          <span role="columnheader">{t("输入")}</span>
          <span role="columnheader">{t("缓存读取")}</span>
          <span role="columnheader">{t("缓存写入")}</span>
          <span role="columnheader">{t("输出")}</span>
          <span role="columnheader">{t("币种")}</span>
          <span role="columnheader" title={t("按当前筛选的调用计算")}>{t("本页费用")}</span>
          <span role="columnheader" aria-hidden />
        </div>
        {modelPrices.map((entry) => <PriceRow key={keyOf(entry)} entry={entry} calls={calls} />)}
      </div>
    </Card>
  );
}
