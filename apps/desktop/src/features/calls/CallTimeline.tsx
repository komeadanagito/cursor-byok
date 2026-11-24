//! Summarizes the filtered calls and charts each call's context input in time order.
import type { EChartsCoreOption } from "echarts/core";
import { useMemo } from "react";
import type { LlmCall } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import { TitledCard } from "../../shared/ui/TitledCard";
import { EChart } from "../home/charts/EChart";
import { cacheMetrics, callTokens, median } from "./callMetrics";
import { compactTokens, duration, isFailed, outputSpeed, tokenColors, tokenLabel, type TokenPart } from "./tokenParts";
import styles from "./CallTimeline.module.scss";

const rate = (count: number, total: number) => total > 0 ? `${(count / total * 100).toFixed(1)}%` : "—";
const INPUT_PARTS: TokenPart[] = ["read", "input", "write"];
// Past this many bars, rounded ends and gaps blur into noise; draw flat, gapless columns.
const DENSE_BARS = 120;

type TooltipItem = { dataIndex: number };

export function CallTimeline({ calls, dark }: { calls: LlmCall[]; dark: boolean }) {
  const metrics = cacheMetrics(calls);
  const firstText = median(calls.flatMap(call => call.ttft_ms === null ? [] : [call.ttft_ms]));
  const total = median(calls.flatMap(call => call.duration_ms === null ? [] : [call.duration_ms]));
  const failures = calls.filter(isFailed).length;
  const toolCounts = calls.flatMap(call => call.launched_tool_count === null ? [] : [call.launched_tool_count]);
  const speed = median(calls.filter(call => call.status !== "running").flatMap(call => outputSpeed(call) ?? []));
  const ordered = useMemo(() => [...calls].reverse().filter(call => callTokens(call).totalInput !== null), [calls]);
  const samples = useMemo(() => ordered.map(callTokens), [ordered]);
  const peak = Math.max(0, ...samples.map(sample => sample.totalInput ?? 0));
  const latest = samples.at(-1)?.totalInput;

  const tiles: Array<[string, string, string]> = [
    [t("有缓存读取的请求"), rate(metrics.hits, metrics.reported), `${metrics.hits} / ${metrics.reported}`],
    [t("缓存输入占比"), rate(metrics.read, metrics.input), `${compactTokens(metrics.read)} / ${compactTokens(metrics.input)}`],
    [t("首字 P50"), duration(firstText), t("总耗时 P50 {time}", { time: duration(total) })],
    [t("最新上下文"), latest == null ? "—" : compactTokens(latest), t("峰值 {count}", { count: compactTokens(peak) })],
    [t("请求"), calls.length.toLocaleString(), t("失败 {count}", { count: failures })],
    [t("已发起工具调用"), toolCounts.length > 0 ? toolCounts.reduce((sum, value) => sum + value, 0).toLocaleString() : "—",
      speed === null ? t("输出速度 —") : t("输出速度 {speed} tok/s", { speed: speed.toFixed(1) })],
  ];

  const colors = tokenColors(dark);
  const muted = dark ? "#ffffff80" : "#00000080";
  const dense = ordered.length > DENSE_BARS;
  const option = useMemo<EChartsCoreOption>(() => ({
    animation: false,
    grid: { top: 34, left: 8, right: 8, bottom: 4, containLabel: true },
    legend: {
      top: 0, right: 0, itemWidth: 10, itemHeight: 10, itemGap: 16, icon: "roundRect",
      textStyle: { color: muted },
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "var(--vscode-editorHoverWidget-background)",
      borderColor: "var(--vscode-editorHoverWidget-border)",
      textStyle: { color: "var(--vscode-foreground)" },
      extraCssText: "border-radius: 8px; box-shadow: var(--oa-tooltip-shadow); line-height: 1.6; font-size: var(--call-chart-tooltip-font-size);",
      axisPointer: { type: "shadow", shadowStyle: { color: dark ? "#ffffff10" : "#0000000a" } },
      formatter: (params: unknown) => {
        const index = (params as TooltipItem[])[0].dataIndex;
        const call = ordered[index];
        const sample = samples[index];
        const context = sample.totalInput ?? 0;
        const rows = INPUT_PARTS.map(part => {
          const value = sample[part] ?? 0;
          return `<div style="display:flex;gap:16px;justify-content:space-between"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${colors[part]}"></span>${tokenLabel(part)}</span><b>${value.toLocaleString()}</b></div>`;
        }).join("");
        return `<div style="opacity:.7">${new Date(call.created_at_ms).toLocaleTimeString(undefined, { hour12: false })} · ${call.display_name}</div>`
          + rows
          + `<div style="display:flex;justify-content:space-between;margin-top:4px;padding-top:4px;border-top:1px solid ${dark ? "#ffffff1a" : "#0000001a"}"><span>${t("上下文")}</span><b>${context.toLocaleString()}</b></div>`;
      },
    },
    xAxis: {
      type: "category",
      data: ordered.map(call => new Date(call.created_at_ms).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit" })),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: dark ? "#ffffff1f" : "#0000001f" } },
      axisLabel: { color: muted, hideOverlap: true, margin: 10 },
    },
    yAxis: {
      type: "value",
      splitNumber: 4,
      axisLabel: { color: muted, formatter: (value: number) => compactTokens(value) },
      splitLine: { lineStyle: { color: dark ? "#ffffff12" : "#00000010" } },
    },
    series: INPUT_PARTS.map((part, index) => ({
      name: tokenLabel(part),
      type: "bar",
      stack: "context",
      barCategoryGap: dense ? "0%" : "30%",
      barMaxWidth: 22,
      large: dense,
      color: colors[part],
      itemStyle: { borderRadius: !dense && index === INPUT_PARTS.length - 1 ? [3, 3, 0, 0] : 0 },
      emphasis: { focus: "series" },
      data: samples.map(sample => sample[part] ?? 0),
    })),
  }), [colors, dark, dense, muted, ordered, samples]);

  return <div className={styles.root}>
    <Card className={styles.tiles}>
      {tiles.map(([label, value, detail]) => <div key={label} className={styles.tile}>
        <span className={styles.label}>{label}</span>
        <strong className={styles.value}>{value}</strong>
        <small className={styles.detail}>{detail}</small>
      </div>)}
    </Card>
    <TitledCard title={t("上下文增长")}>
      {samples.length > 0
        ? <EChart option={option} className={styles.chart} />
        : <div className={styles.empty}>{t("暂无上下文数据")}</div>}
    </TitledCard>
  </div>;
}
