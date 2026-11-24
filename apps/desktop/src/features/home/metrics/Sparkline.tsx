//! Hoverable single-series trend line drawn under an overview stat card.
import { useEffect, useId, useState } from "react";
import { useKeepAliveContext } from "keepalive-for-react";
import type { OverviewGranularity } from "../../../shared/api";
import { useTooltip } from "../../../shared/ui/Tooltip";
import { formatTooltipTime } from "../charts/DailyTokenUsageChart";
import styles from "./HomeMetrics.module.scss";

type Point = { x: number; y: number };

// Scales between the range's own low and high so a steady metric still shows
// its movement; a flat series sits mid-height instead of hugging an edge.
function verticalScale(values: (number | null)[]) {
  const measured = values.filter((value): value is number => value !== null);
  const low = Math.min(...measured);
  const high = Math.max(...measured);
  return (value: number) => high > low ? 0.9 - ((value - low) / (high - low)) * 0.75 : 0.5;
}

// Normalised 0..1 coordinates; null values break the line instead of dropping to zero.
function segments(values: (number | null)[], y: (value: number) => number): Point[][] {
  const last = Math.max(1, values.length - 1);
  const result: Point[][] = [];
  let current: Point[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) result.push(current);
      current = [];
      return;
    }
    current.push({ x: values.length === 1 ? 0.5 : index / last, y: y(value) });
  });
  if (current.length > 0) result.push(current);
  return result;
}

export function Sparkline({ values, times, granularity, format, tone = "accent", label }: {
  values: (number | null)[];
  times: number[];
  granularity: OverviewGranularity;
  format: (value: number) => string;
  tone?: "accent" | "danger";
  label: string;
}) {
  const { show, hide } = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const gradient = `spark-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { active } = useKeepAliveContext();
  // A kept-alive page is hidden without a pointerleave; drop its tooltip with it.
  useEffect(() => {
    if (active) return;
    setHover(null);
    hide();
  }, [active, hide]);
  const y = verticalScale(values);
  // A lone point has no width; stretch it into a flat line so it stays visible.
  const parts = segments(values, y).map((points) => points.length === 1 ? [{ ...points[0], x: 0 }, { ...points[0], x: 1 }] : points);
  const lines = parts.map((points) => points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x * 100} ${point.y * 100}`).join(" "));
  const areas = parts.map((points) =>
    `M${points[0].x * 100} 100 ${points.map((point) => `L${point.x * 100} ${point.y * 100}`).join(" ")} L${points.at(-1)!.x * 100} 100 Z`);
  const hovered = hover === null ? null : values[hover];
  const hoverX = hover === null ? 0 : values.length === 1 ? 50 : (hover / Math.max(1, values.length - 1)) * 100;
  const hoverY = hovered == null ? 100 : y(hovered) * 100;

  const pointAt = (clientX: number, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width)));
    return Math.round(ratio * Math.max(0, values.length - 1));
  };

  if (values.length === 0) return <div className={styles.sparkline} />;

  return <div
    className={`${styles.sparkline} ${tone === "danger" ? styles.sparklineDanger : ""}`}
    role="img"
    aria-label={label}
    onPointerMove={(event) => {
      const index = pointAt(event.clientX, event.currentTarget);
      if (index === hover) return;
      setHover(index);
      const value = values[index];
      const element = event.currentTarget;
      const box = element.getBoundingClientRect();
      const x = box.left + (values.length === 1 ? 0.5 : index / Math.max(1, values.length - 1)) * box.width;
      show({ getBoundingClientRect: () => new DOMRect(x, box.top, 0, box.height), contextElement: element }, undefined,
        <div className={styles.sparkTooltip}>
          <span>{formatTooltipTime(times[index], granularity)}</span>
          <strong>{value === null ? "—" : format(value)}</strong>
        </div>);
    }}
    onPointerLeave={() => { setHover(null); hide(); }}
  >
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" className={styles.sparkFadeTop} />
          <stop offset="100%" className={styles.sparkFadeBottom} />
        </linearGradient>
      </defs>
      {areas.map((path, index) => <path key={`a${index}`} d={path} fill={`url(#${gradient})`} />)}
      {lines.map((path, index) => <path key={`l${index}`} className={styles.sparkLine} d={path} vectorEffect="non-scaling-stroke" />)}
      {hover !== null && <line className={styles.sparkCursor} x1={hoverX} x2={hoverX} y1={0} y2={100} vectorEffect="non-scaling-stroke" />}
    </svg>
    {hover !== null && hovered != null && <span className={styles.sparkDot} style={{ left: `${hoverX}%`, top: `${hoverY}%` }} />}
  </div>;
}
