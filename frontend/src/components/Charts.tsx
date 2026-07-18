import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { AgingRow, BuRow, SEV_COLORS, SevRow, TrendRow } from "../api";

const FONT = { fontFamily: "'IBM Plex Sans', sans-serif", color: "#68707c", fontSize: 11 };
const GRID = { left: 48, right: 20, top: 36, bottom: 32 };

function useChart(option: echarts.EChartsOption | null) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const onResize = () => chart.current?.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.current?.dispose(); };
  }, []);
  useEffect(() => { if (option) chart.current?.setOption(option); }, [option]);
  return ref;
}

export function SeverityDonut({ data }: { data: SevRow[] }) {
  const ref = useChart(
    data.length
      ? {
          tooltip: { trigger: "item" },
          legend: { bottom: 0, textStyle: FONT, icon: "rect", itemWidth: 10, itemHeight: 10 },
          series: [{
            type: "pie", radius: ["48%", "72%"], center: ["50%", "44%"],
            label: { show: false },
            data: data.map((d) => ({
              name: d.severity_name, value: d.total,
              itemStyle: { color: SEV_COLORS[d.severity_name] ?? "#9aa1a9" },
            })),
          }],
        }
      : null
  );
  return <div className="chart" ref={ref} role="img" aria-label="Findings by severity" />;
}

export function BusinessUnitBars({ data }: { data: BuRow[] }) {
  const ref = useChart(
    data.length
      ? {
          tooltip: { trigger: "axis" },
          grid: { ...GRID, left: 130 },
          xAxis: { type: "value", axisLabel: FONT, splitLine: { lineStyle: { color: "#eef0ed" } } },
          yAxis: { type: "category", inverse: true, axisLabel: FONT,
                   data: data.map((d) => d.bu_name) },
          series: [{
            type: "bar", name: "Open findings", barMaxWidth: 16,
            itemStyle: { color: "#1a1d21" },
            data: data.map((d) => d.open_count),
          }],
        }
      : null
  );
  return <div className="chart" ref={ref} role="img" aria-label="Open findings by business unit" />;
}

export function MonthlyTrend({ data }: { data: TrendRow[] }) {
  const ref = useChart(
    data.length
      ? {
          tooltip: { trigger: "axis" },
          legend: { top: 0, right: 10, textStyle: FONT, icon: "rect", itemWidth: 10, itemHeight: 10 },
          grid: GRID,
          xAxis: { type: "category", axisLabel: { ...FONT, formatter: (v: string) => v.slice(0, 7) },
                   data: data.map((d) => d.month) },
          yAxis: { type: "value", axisLabel: FONT, splitLine: { lineStyle: { color: "#eef0ed" } } },
          series: [
            { name: "Created", type: "line", smooth: true, symbol: "none",
              lineStyle: { color: "#b3382c", width: 2 }, itemStyle: { color: "#b3382c" },
              data: data.map((d) => d.created) },
            { name: "Closed", type: "line", smooth: true, symbol: "none",
              lineStyle: { color: "#7a9471", width: 2 }, itemStyle: { color: "#7a9471" },
              data: data.map((d) => d.closed) },
          ],
        }
      : null
  );
  return <div className="chart" ref={ref} role="img" aria-label="Findings created versus closed per month" />;
}

export function AgingStack({ data }: { data: AgingRow[] }) {
  const buckets: [keyof AgingRow, string, string][] = [
    ["d0_30", "0-30 days", "#c7cfd8"],
    ["d31_90", "31-90 days", "#8fa3b8"],
    ["d91_180", "91-180 days", "#d98e32"],
    ["d180_plus", "180+ days", "#b3382c"],
  ];
  const ref = useChart(
    data.length
      ? {
          tooltip: { trigger: "axis" },
          legend: { top: 0, right: 10, textStyle: FONT, icon: "rect", itemWidth: 10, itemHeight: 10 },
          grid: GRID,
          xAxis: { type: "category", axisLabel: FONT, data: data.map((d) => d.severity_name) },
          yAxis: { type: "value", axisLabel: FONT, splitLine: { lineStyle: { color: "#eef0ed" } } },
          series: buckets.map(([key, name, color]) => ({
            name, type: "bar" as const, stack: "age", barMaxWidth: 42,
            itemStyle: { color },
            data: data.map((d) => d[key] as number),
          })),
        }
      : null
  );
  return <div className="chart" ref={ref} role="img" aria-label="Aging of open findings by severity" />;
}
