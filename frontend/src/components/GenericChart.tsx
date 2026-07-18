import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import { QueryRow } from "../api";

const FONT = { fontFamily: "'IBM Plex Sans', sans-serif", color: "#68707c", fontSize: 11 };
// Top padding is small now that the legend lives in a corner dropdown, not above the plot.
const GRID = { left: 56, right: 20, top: 24, bottom: 40, containLabel: true };
const PALETTE = ["#5b7da8", "#b3382c", "#7a9471", "#d98e32", "#8a6ea8", "#3f9296", "#c05a8b", "#6b7280"];

function useEcharts(option: echarts.EChartsOption | null, onClick?: (name: string) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    chart.current.on("click", (p: any) => clickRef.current?.(String(p.name)));
    const onResize = () => chart.current?.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.current?.dispose(); };
  }, []);
  useEffect(() => {
    if (!chart.current) return;
    chart.current.clear();
    if (option) chart.current.setOption(option);
    // Show a pointer cursor when the chart is clickable (drill enabled).
    if (ref.current) ref.current.style.cursor = clickRef.current ? "pointer" : "default";
  }, [option, onClick]);
  return ref;
}

/** Distinct, order-preserving values. */
function uniq(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = v ?? "—";
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

const colorAt = (idx: number) => PALETTE[idx % PALETTE.length];

/** The series/category names a chart's legend dropdown offers (empty = no legend needed). */
export function legendNames(type: string, rows: QueryRow[]): string[] {
  if (type === "pie" || type === "donut") return uniq(rows.map((r) => r.x));
  return rows.some((r) => r.series != null) ? uniq(rows.map((r) => r.series)) : [];
}

function buildCartesian(
  rows: QueryRow[], type: "bar" | "line", horizontal: boolean, area: boolean, hidden: Set<string>,
): echarts.EChartsOption {
  const cats = uniq(rows.map((r) => r.x));
  const hasSeries = rows.some((r) => r.series != null);
  const seriesNames = hasSeries ? uniq(rows.map((r) => r.series)) : ["value"];

  const singleBar = !hasSeries && type === "bar"; // single-series bar/column → color each bar
  const built = seriesNames.map((name, idx) => {
    const data = cats.map((c) => {
      const match = rows.find((r) => (r.x ?? "—") === c && (hasSeries ? (r.series ?? "—") === name : true));
      return match ? Number(match.y) : 0;
    });
    return {
      name,
      type,
      stack: hasSeries && type === "bar" ? "total" : undefined,
      areaStyle: area ? { opacity: 0.25 } : undefined,
      smooth: type === "line",
      symbol: type === "line" ? "circle" : undefined,
      barMaxWidth: 46,
      // Single-series bars get a different palette color per category (like pie/donut).
      colorBy: singleBar ? "data" : "series",
      itemStyle: singleBar ? undefined : { color: colorAt(idx) },
      data,
    };
  });
  // Colours are assigned by original index above, so hiding a series never recolours the rest.
  const series = built.filter((s) => !hidden.has(String(s.name)));

  const catAxis = { type: "category" as const, data: cats, axisLabel: FONT };
  const valAxis = { type: "value" as const, axisLabel: FONT, splitLine: { lineStyle: { color: "#eef0ed" } } };

  return {
    color: PALETTE,
    tooltip: { trigger: "axis" },
    grid: GRID,
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? { ...catAxis, inverse: true } : valAxis,
    series: series as any,
  };
}

function buildPie(rows: QueryRow[], donut: boolean, hidden: Set<string>): echarts.EChartsOption {
  const names = uniq(rows.map((r) => r.x));
  const data = rows
    .filter((r) => !hidden.has(r.x ?? "—"))
    // Explicit per-slice colour (by original order) so hiding slices keeps colours stable.
    .map((r) => ({ name: r.x ?? "—", value: Number(r.y), itemStyle: { color: colorAt(names.indexOf(r.x ?? "—")) } }));
  return {
    color: PALETTE,
    tooltip: { trigger: "item" },
    series: [{
      type: "pie",
      radius: donut ? ["45%", "70%"] : "68%",
      center: ["50%", "50%"],
      label: { fontSize: 11 },
      data,
    }],
  };
}

function useEchartsPanel(option: echarts.EChartsOption | null, label: string, onClick?: (name: string) => void) {
  const ref = useEcharts(option, onClick);
  return <div className="chart" ref={ref} role="img" aria-label={label} />;
}

/**
 * Compact dropdown of series/categories with checkboxes to show/hide them.
 * variant "overlay" pins it to the chart's top-right corner; "inline" lets it sit
 * in a toolbar (e.g. beside the Export button).
 */
export function SeriesLegend({
  names, hidden, onToggle, variant = "overlay",
}: {
  names: string[]; hidden: Set<string>; onToggle: (name: string) => void;
  variant?: "overlay" | "inline";
}) {
  const visible = names.filter((n) => !hidden.has(n)).length;
  return (
    <details className={`series-dd${variant === "inline" ? " inline" : ""}`}>
      <summary title="Show or hide values">Series · {visible}/{names.length}</summary>
      <div className="series-dd-panel">
        {names.map((n, i) => (
          <label key={n} className="chk">
            <input type="checkbox" checked={!hidden.has(n)} onChange={() => onToggle(n)} />
            <span className="series-dot" style={{ background: colorAt(i) }} />
            <span className="series-name">{n}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

/** ECharts chart + corner legend dropdown. Always calls hooks (Rules of Hooks). */
function ChartWithLegend({
  type, rows, showLegend, onSliceClick, hidden: controlledHidden,
}: {
  type: string; rows: QueryRow[]; showLegend?: boolean;
  onSliceClick?: (name: string) => void; hidden?: Set<string>;
}) {
  const [internalHidden, setInternalHidden] = useState<Set<string>>(new Set());
  // When a parent supplies `hidden` it owns the legend (rendered elsewhere, e.g. a
  // toolbar), so we don't draw our own corner dropdown.
  const controlled = controlledHidden !== undefined;
  const hidden = controlled ? controlledHidden : internalHidden;
  const names = legendNames(type, rows);
  const canLegend = !controlled && (showLegend ?? true) && names.length > 1;
  const toggle = (n: string) =>
    setInternalHidden((prev) => { const s = new Set(prev); if (s.has(n)) s.delete(n); else s.add(n); return s; });

  let option: echarts.EChartsOption | null = null;
  switch (type) {
    case "bar": option = buildCartesian(rows, "bar", true, false, hidden); break;
    case "column": option = buildCartesian(rows, "bar", false, false, hidden); break;
    case "line": option = buildCartesian(rows, "line", false, false, hidden); break;
    case "area": option = buildCartesian(rows, "line", false, true, hidden); break;
    case "pie": option = buildPie(rows, false, hidden); break;
    case "donut": option = buildPie(rows, true, hidden); break;
    default: option = null;
  }

  const panel = useEchartsPanel(rows.length ? option : null, `${type} chart`, onSliceClick);
  return (
    <div className="chart-wrap">
      {canLegend && <SeriesLegend names={names} hidden={hidden} onToggle={toggle} />}
      {panel}
    </div>
  );
}

interface GenericChartProps {
  type: string;
  rows: QueryRow[];
  showLegend?: boolean;
  onSliceClick?: (name: string) => void;
  /** When set, the parent controls which series are hidden (and renders the legend itself). */
  hidden?: Set<string>;
}

export default function GenericChart({ type, rows, showLegend, onSliceClick, hidden }: GenericChartProps) {
  // 'number' and 'table' render as plain HTML, not ECharts.
  if (type === "number") {
    const value = rows[0]?.y ?? 0;
    return <div className="chart chart-number"><span>{Number(value).toLocaleString()}</span></div>;
  }
  if (type === "table") {
    const hasSeries = rows.some((r) => r.series != null);
    return (
      <div className="chart chart-table">
        <table className="findings">
          <thead><tr><th>Group</th>{hasSeries && <th>Split</th>}<th>Value</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.x ?? "—"}</td>
                {hasSeries && <td>{r.series ?? "—"}</td>}
                <td className="num">{Number(r.y).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return <ChartWithLegend type={type} rows={rows} showLegend={showLegend} onSliceClick={onSliceClick} hidden={hidden} />;
}
