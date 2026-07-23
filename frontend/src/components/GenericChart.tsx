import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { QueryRow } from "../api";

const FONT = { fontFamily: "'IBM Plex Sans', sans-serif", color: "#68707c", fontSize: 11 };
// Top padding is small now that the legend lives in a corner dropdown, not above the plot.
const GRID = { left: 56, right: 20, top: 24, bottom: 40, containLabel: true };
/**
 * Chart colour themes. `default` is the original house palette; the rest are ordered
 * so adjacent series stay distinguishable (and readable for the common forms of
 * colour blindness) rather than being a smooth gradient.
 */
export const CHART_THEMES: { key: string; label: string; colors: string[] }[] = [
  { key: "default", label: "Default", colors: ["#5b7da8", "#b3382c", "#7a9471", "#d98e32", "#8a6ea8", "#3f9296", "#c05a8b", "#6b7280"] },
  { key: "ocean",   label: "Ocean",   colors: ["#1f4e79", "#2e86ab", "#54c0c9", "#8ecae6", "#2a9d8f", "#457b9d", "#0b3954", "#94b0c2"] },
  { key: "forest",  label: "Forest",  colors: ["#2d6a4f", "#52b788", "#95d5b2", "#b7935f", "#7f5539", "#40916c", "#d8ce9e", "#1b4332"] },
  { key: "sunset",  label: "Sunset",  colors: ["#c1350a", "#e8722a", "#f4a259", "#f6d06f", "#a4402d", "#7a2f36", "#e0918f", "#5c3b3b"] },
  { key: "berry",   label: "Berry",   colors: ["#6a2c70", "#b83b5e", "#f08a5d", "#c06c9b", "#8d5a97", "#e05780", "#4a2545", "#f2b5c4"] },
  { key: "slate",   label: "Slate",   colors: ["#37474f", "#607d8b", "#90a4ae", "#455a64", "#b0bec5", "#78909c", "#263238", "#cfd8dc"] },
  { key: "vivid",   label: "Vivid",   colors: ["#3d5afe", "#ff6d00", "#00bfa5", "#d500f9", "#ffd600", "#c51162", "#00b0ff", "#64dd17"] },
];

export const paletteOf = (theme?: string | null) =>
  (CHART_THEMES.find((t) => t.key === theme) ?? CHART_THEMES[0]).colors;

const PALETTE = CHART_THEMES[0].colors;

function useEcharts(
  option: echarts.EChartsOption | null,
  onClick?: (name: string) => void,
  onLegendToggle?: (name: string) => void,
) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const legendRef = useRef(onLegendToggle);
  legendRef.current = onLegendToggle;
  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    chart.current.on("click", (p: any) => clickRef.current?.(String(p.name)));
    // Clicking a legend entry hides/shows that series or category. We own the hidden
    // set (the toolbar dropdown writes to it too), so the event is routed back to it
    // and the legend's own selected state is re-derived from that on the next render.
    chart.current.on("legendselectchanged", (p: any) => legendRef.current?.(String(p.name)));
    // Covers both window resizes and the container widening when a dense chart switches
    // to the scrolling layout. Doing it here rather than on every option change means a
    // redraw is never triggered just because the component re-rendered.
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.current?.dispose(); };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    // notMerge replaces the chart in one paint. clear() + setOption() blanked the canvas
    // first, so every re-render flashed — most visibly on a drill click, where React
    // renders three times (busy on, rows in, busy off) and two of those carry identical
    // data. `option` is memoised upstream, so this now runs only when something changed.
    if (option) chart.current.setOption(option, { notMerge: true });
    else chart.current.clear();
  }, [option]);

  // Cursor tracks clickability without touching the chart itself.
  useEffect(() => {
    if (ref.current) ref.current.style.cursor = onClick ? "pointer" : "default";
  }, [onClick]);

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

const colorAt = (idx: number, palette: string[] = PALETTE) => palette[idx % palette.length];

/**
 * The names a chart's legend lists (empty = the chart has no colour key to show).
 * A legend is a key from COLOUR to meaning, so it only exists where colour carries
 * information: one entry per slice (pie/donut) or per series (a split-by chart). A
 * single-series bar chart names every bar on its axis already, so it has none.
 */
export function legendNames(type: string, rows: QueryRow[]): string[] {
  if (type === "pie" || type === "donut") return uniq(rows.map((r) => r.x));
  return rows.some((r) => r.series != null) ? uniq(rows.map((r) => r.series)) : [];
}

/** Legend block placed under the plot; `selected` mirrors our own hidden set. */
function legendOption(names: string[], hidden: Set<string>): echarts.EChartsOption["legend"] {
  return {
    type: "scroll",
    bottom: 0,
    icon: "roundRect",
    itemWidth: 10,
    itemHeight: 10,
    textStyle: FONT,
    data: names,
    selected: Object.fromEntries(names.map((n) => [n, !hidden.has(n)])),
  };
}

function buildCartesian(
  rows: QueryRow[], type: "bar" | "line", horizontal: boolean, area: boolean, hidden: Set<string>,
  palette: string[], showLegend: boolean,
): echarts.EChartsOption {
  const hasSeries = rows.some((r) => r.series != null);
  const seriesNames = hasSeries ? uniq(rows.map((r) => r.series)) : ["value"];
  const singleBar = !hasSeries && type === "bar"; // single-series bar/column → color each bar

  // Single-series bars have one colour per CATEGORY, so hiding acts on categories;
  // for every other shape the hidden set names series.
  const allCats = uniq(rows.map((r) => r.x));
  const cats = singleBar ? allCats.filter((c) => !hidden.has(c)) : allCats;

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
      // Colours follow each category's ORIGINAL index, so hiding one never recolours
      // the rest.
      colorBy: singleBar ? "data" : "series",
      itemStyle: singleBar
        ? { color: (p: any) => colorAt(allCats.indexOf(String(p.name)), palette) }
        : { color: colorAt(idx, palette) },
      data,
    };
  });
  const series = built.filter((s) => singleBar || !hidden.has(String(s.name)));

  const catAxis = { type: "category" as const, data: cats, axisLabel: FONT };
  const valAxis = { type: "value" as const, axisLabel: FONT, splitLine: { lineStyle: { color: "#eef0ed" } } };
  // ECharts keys a cartesian legend by SERIES name, so only a split-by chart has one.
  const legendVals = hasSeries ? seriesNames : [];
  const withLegend = showLegend && legendVals.length > 1;

  return {
    color: palette,
    tooltip: { trigger: "axis" },
    // The legend sits under the plot, so the grid gives up that strip when it's shown.
    grid: withLegend ? { ...GRID, bottom: 58 } : GRID,
    legend: withLegend ? legendOption(legendVals, hidden) : undefined,
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? { ...catAxis, inverse: true } : valAxis,
    series: series as any,
  };
}

function buildPie(
  rows: QueryRow[], donut: boolean, hidden: Set<string>, palette: string[], showLegend: boolean,
): echarts.EChartsOption {
  const names = uniq(rows.map((r) => r.x));
  const data = rows
    .filter((r) => !hidden.has(r.x ?? "—"))
    // Explicit per-slice colour (by original order) so hiding slices keeps colours stable.
    .map((r) => ({ name: r.x ?? "—", value: Number(r.y), itemStyle: { color: colorAt(names.indexOf(r.x ?? "—"), palette) } }));
  const withLegend = showLegend && names.length > 1;
  return {
    color: palette,
    tooltip: { trigger: "item" },
    legend: withLegend ? legendOption(names, hidden) : undefined,
    series: [{
      type: "pie",
      radius: donut ? ["45%", "70%"] : "68%",
      // Shift the pie up a little when a legend occupies the bottom strip.
      center: ["50%", withLegend ? "44%" : "50%"],
      label: { fontSize: 11 },
      data,
    }],
  };
}

/**
 * Width a category axis needs to stay readable. Squeezing 200 bars into 700px gives
 * each one 3px and an unreadable axis, so past a threshold the canvas grows and the
 * panel scrolls horizontally instead of compressing.
 *
 * The overall width is bounded because browsers refuse to paint an arbitrarily wide
 * canvas — beyond that the bars do get thinner, which is the honest outcome for a
 * chart with thousands of categories.
 */
const PX_PER_CATEGORY = 34;
const MAX_CANVAS_PX = 24_000;

function scrollWidth(categories: number): number | undefined {
  if (categories < 2) return undefined;
  return Math.min(MAX_CANVAS_PX, categories * PX_PER_CATEGORY);
}

function useEchartsPanel(
  option: echarts.EChartsOption | null, label: string,
  onClick?: (name: string) => void, onLegendToggle?: (name: string) => void,
  minWidth?: number,
) {
  const ref = useEcharts(option, onClick, onLegendToggle);
  // minWidth drives the canvas; the parent (.chart-wrap) provides the scrollbar.
  return (
    <div className="chart" ref={ref} role="img" aria-label={label}
         style={minWidth ? { minWidth: `${minWidth}px` } : undefined} />
  );
}

/**
 * Compact dropdown of series/categories with checkboxes to show/hide them.
 * variant "overlay" pins it to the chart's top-right corner; "inline" lets it sit
 * in a toolbar (e.g. beside the Export button).
 */
export function SeriesLegend({
  names, hidden, onToggle, variant = "overlay", palette = PALETTE,
}: {
  names: string[]; hidden: Set<string>; onToggle: (name: string) => void;
  variant?: "overlay" | "inline"; palette?: string[];
}) {
  const visible = names.filter((n) => !hidden.has(n)).length;
  return (
    <details className={`series-dd${variant === "inline" ? " inline" : ""}`}>
      <summary title="Show or hide values">Series · {visible}/{names.length}</summary>
      <div className="series-dd-panel">
        {names.map((n, i) => (
          <label key={n} className="chk">
            <input type="checkbox" checked={!hidden.has(n)} onChange={() => onToggle(n)} />
            <span className="series-dot" style={{ background: colorAt(i, palette) }} />
            <span className="series-name">{n}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

/**
 * ECharts chart with an on-chart legend (when the spec asks for one) plus the corner
 * show/hide dropdown. Always calls hooks (Rules of Hooks).
 */
function ChartWithLegend({
  type, rows, showLegend, theme, onSliceClick, hidden: controlledHidden, onToggleHidden,
}: {
  type: string; rows: QueryRow[]; showLegend?: boolean; theme?: string | null;
  onSliceClick?: (name: string) => void; hidden?: Set<string>;
  onToggleHidden?: (name: string) => void;
}) {
  const [internalHidden, setInternalHidden] = useState<Set<string>>(new Set());
  // When a parent supplies `hidden` it owns the show/hide state (its dropdown lives
  // elsewhere, e.g. a toolbar), so we don't draw our own corner dropdown.
  const controlled = controlledHidden !== undefined;
  const hidden = controlled ? controlledHidden : internalHidden;
  const names = legendNames(type, rows);
  const wantsLegend = showLegend ?? true;
  const canDropdown = !controlled && wantsLegend && names.length > 1;
  const toggleInternal = (n: string) =>
    setInternalHidden((prev) => { const s = new Set(prev); if (s.has(n)) s.delete(n); else s.add(n); return s; });
  // A click on the chart's own legend feeds the same hidden set the dropdown uses,
  // so the two controls can never disagree.
  const toggle = controlled ? onToggleHidden : toggleInternal;

  const palette = paletteOf(theme);
  // Built only when its inputs change. Rebuilding it every render gave the redraw effect
  // a new object each time, so the chart repainted on unrelated state changes too.
  const option = useMemo<echarts.EChartsOption | null>(() => {
    if (!rows.length) return null;
    switch (type) {
      case "bar": return buildCartesian(rows, "bar", true, false, hidden, palette, wantsLegend);
      case "column": return buildCartesian(rows, "bar", false, false, hidden, palette, wantsLegend);
      case "line": return buildCartesian(rows, "line", false, false, hidden, palette, wantsLegend);
      case "area": return buildCartesian(rows, "line", false, true, hidden, palette, wantsLegend);
      case "pie": return buildPie(rows, false, hidden, palette, wantsLegend);
      case "donut": return buildPie(rows, true, hidden, palette, wantsLegend);
      default: return null;
    }
  }, [type, rows, hidden, palette, wantsLegend]);

  // Only a category axis needs room per value; pie/donut have no axis to crowd.
  const cartesian = ["bar", "column", "line", "area"].includes(type);
  // A horizontal bar chart grows DOWNWARD with categories, so widening it doesn't help.
  const minWidth = cartesian && type !== "bar" ? scrollWidth(uniq(rows.map((r) => r.x)).length) : undefined;

  const panel = useEchartsPanel(option, `${type} chart`, onSliceClick, toggle, minWidth);
  return (
    <div className={`chart-wrap${minWidth ? " is-scrollable" : ""}`}>
      {canDropdown && <SeriesLegend names={names} hidden={hidden} onToggle={toggleInternal} palette={palette} />}
      {panel}
    </div>
  );
}

/**
 * Grouping rows (g0, g1, … + y) folded to one labelled bar each, cached against the
 * source array so repeated renders reuse the same result — and therefore the same
 * object identity the redraw memo depends on.
 */
const foldedClauseRows = new WeakMap<object, QueryRow[]>();
function foldClauseRows(rows: QueryRow[], levelCount: number): QueryRow[] {
  const cached = foldedClauseRows.get(rows);
  if (cached) return cached;
  const folded = rows.map((r: any) => ({
    x: Array.from({ length: levelCount }, (_, l) => r[`g${l}`] ?? "—").join(" / "),
    y: r.y,
  })) as QueryRow[];
  foldedClauseRows.set(rows, folded);
  return folded;
}

interface GenericChartProps {
  type: string;
  rows: QueryRow[];
  showLegend?: boolean;
  /** Colour palette key (see CHART_THEMES); undefined = the default palette. */
  theme?: string | null;
  onSliceClick?: (name: string) => void;
  /** When set, the parent controls which series are hidden (and renders the dropdown itself). */
  hidden?: Set<string>;
  /** Called when the chart's own legend is clicked, for the controlled case above. */
  onToggleHidden?: (name: string) => void;
  /** Column headers for Group & Count (clause) rows, one per grouping level. */
  clauseLevels?: string[];
}

export default function GenericChart({ type, rows: rawRows, showLegend, theme, onSliceClick, hidden, onToggleHidden, clauseLevels }: GenericChartProps) {
  let rows = rawRows;
  // Group & Count (clause) rows carry one column per grouping level: g0, g1, ... + y.
  const isClauseRows = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], "g0");
  if (isClauseRows) {
    const levelCount = Object.keys(rows[0]).filter((k) => /^g\d+$/.test(k)).length;
    const headers = Array.from({ length: levelCount }, (_, i) => clauseLevels?.[i] ?? `Level ${i + 1}`);

    // A table shows every level in its own column — the clearest form for a breakdown.
    if (type === "table") {
      return (
        <div className="chart chart-table">
          <table className="findings">
            <thead>
              <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}<th>Value</th></tr>
            </thead>
            <tbody>
              {rows.map((r: any, i) => (
                <tr key={i}>
                  {headers.map((_, l) => <td key={l}>{r[`g${l}`] ?? "—"}</td>)}
                  <td className="num">{Number(r.y).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    // Any other chart type: fold the levels into one readable label per bar/slice
    // ("Green / Application"), so the groups are actually visible on the chart.
    // Cached on the source rows: a fresh array here would be a new identity every
    // render, defeating the memo that keeps the chart from repainting needlessly.
    rows = foldClauseRows(rawRows, levelCount);
  }

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

  return (
    <ChartWithLegend type={type} rows={rows} showLegend={showLegend} theme={theme}
                     onSliceClick={onSliceClick} hidden={hidden} onToggleHidden={onToggleHidden} />
  );
}
