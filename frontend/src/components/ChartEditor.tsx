import { useEffect, useMemo, useState } from "react";
import { api, ChartSpec, ChartTypeDef, DashboardSchema, FieldsCatalog, FilterCondition, QueryRow, RecordRow } from "../api";

import FilterConditions from "./FilterConditions";
import GenericChart from "./GenericChart";
import MultiCheckDropdown from "./MultiCheckDropdown";
import { RecordsTableView } from "./RecordsChart";

interface Props {
  dashboardKey: string;
  existing?: { widgetId: number; title: string; spec: ChartSpec };
  onSaved: () => void;
  onCancel: () => void;
}

const CHART_ICON: Record<string, string> = {
  column: "▊▁▊", bar: "▬▭", line: "╱╲", area: "◤", pie: "◔", donut: "◍", number: "42", table: "▦",
};

/** Archer-style chart designer: pick a type, then X-axis field, Y-axis value, split-by, filters — with live preview. */
export default function ChartEditor({ dashboardKey, existing, onSaved, onCancel }: Props) {
  const [schema, setSchema] = useState<DashboardSchema | null>(null);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [dataset, setDataset] = useState(existing?.spec.dataset || "archer-findings");
  const [chartType, setChartType] = useState(existing?.spec.chartType ?? "column");
  const [mode, setMode] = useState<"aggregate" | "compare">(existing?.spec.mode ?? "aggregate");
  const [dimension, setDimension] = useState(existing?.spec.dimension ?? "");
  const [groupBy, setGroupBy] = useState<string[]>(
    existing?.spec.groupBy ?? (existing?.spec.series ? [existing.spec.series] : []),
  );
  const [compareField, setCompareField] = useState(existing?.spec.compareField ?? "");
  const [measure, setMeasure] = useState(existing?.spec.measure ?? "count");
  const [conditions, setConditions] = useState<FilterCondition[]>(existing?.spec.conditions ?? []);
  const [logic, setLogic] = useState(existing?.spec.logic ?? "");
  const [showLegend, setShowLegend] = useState(existing?.spec.showLegend ?? true);
  const [limit, setLimit] = useState<string>(existing?.spec.limit ? String(existing.spec.limit) : "50");
  const [drilldown, setDrilldown] = useState<string[]>(existing?.spec.drilldown ?? []);
  const [tableColumns, setTableColumns] = useState<string[] | null>(existing?.spec.tableColumns ?? null);
  const [preview, setPreview] = useState<any[]>([]); // QueryRow[] for charts, RecordRow[] for the table (records list)
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"chart" | "options" | "drill" | "filters">("chart");

  useEffect(() => {
    api.dashboards.schema(dataset).then((s) => {
      setSchema(s);
      if (!existing) {
        setDimension((d) => d || s.dimensions[0]?.key || "");
        setMeasure((m) => m || s.measures[0]?.key || "count");
      }
    }).catch(console.error);
  }, [existing, dataset]);

  /** Switching dataset invalidates every field choice — its fields are different. */
  const changeDataset = (key: string) => {
    if (key === dataset) return;
    setDataset(key);
    setSchema(null);
    setDimension(""); setGroupBy([]); setCompareField(""); setMeasure("count");
    setConditions([]); setLogic(""); setDrilldown([]); setTableColumns(null);
    setPreview([]); setError(null);
  };

  /** The dataset's record columns (drives the table-chart column picker). */
  const recordCols = schema?.recordColumns ?? [];
  const defaultRecordCols = recordCols.slice(0, 8).map((c) => c.key);

  const filterCatalog: FieldsCatalog | null = schema
    ? { fields: schema.filterFields, operators: schema.operators }
    : null;

  const chartDef: ChartTypeDef | undefined = schema?.chartTypes.find((c) => c.key === chartType);
  const needsDimension = chartDef?.needsDimension ?? true;
  const supportsSeries = chartDef?.supportsSeries ?? false;

  const labelOf = (kind: "dimensions" | "measures", key?: string | null) =>
    (key && schema?.[kind].find((i) => i.key === key)?.label) || key || "";

  const isCompare = mode === "compare" && supportsSeries;

  // Auto caption: "what compared to what" (the drill path is not part of the displayed text).
  const caption = useMemo(() => {
    if (chartType === "table") return "Filtered records";
    if (isCompare) return `${labelOf("dimensions", dimension)} vs ${labelOf("dimensions", compareField)}`;
    const m = labelOf("measures", measure);
    if (!needsDimension) return m;
    let c = `${m} by ${labelOf("dimensions", dimension)}`;
    if (supportsSeries && groupBy.length) c += `, split by ${groupBy.map((g) => labelOf("dimensions", g)).join(" / ")}`;
    return c;
  }, [schema, chartType, isCompare, measure, dimension, groupBy, compareField, needsDimension, supportsSeries]);

  const isTable = chartType === "table";
  // Record columns a Table (records list) chart can show, with the user's selection applied.
  const colShown = (key: string) => (tableColumns ? tableColumns.includes(key) : defaultRecordCols.includes(key));
  const toggleTableCol = (key: string) => {
    const base = tableColumns ?? defaultRecordCols;
    const on = new Set(base);
    on.has(key) ? on.delete(key) : on.add(key);
    if (on.size === 0) return; // keep at least one column
    setTableColumns(recordCols.map((c) => c.key).filter((k) => on.has(k))); // preserve catalog order
  };

  const spec: ChartSpec = useMemo(() => ({
    dataset,
    chartType,
    mode: isCompare ? "compare" : "aggregate",
    dimension: needsDimension ? dimension : null,
    series: null,
    groupBy: !isCompare && supportsSeries ? groupBy : [],
    compareField: isCompare ? compareField : null,
    measure: isCompare ? "count" : measure, // measure is ignored (count) in compare mode
    conditions: conditions.length ? conditions : null,
    logic: logic.trim() || null,
    showLegend: isCompare ? true : showLegend,
    limit: limit ? Number(limit) : null,
    drilldown: needsDimension ? drilldown : [],
    caption,
    tableColumns: chartType === "table" ? tableColumns : null,
  }), [dataset, chartType, isCompare, dimension, groupBy, compareField, measure, conditions, logic, showLegend, limit, drilldown, caption, needsDimension, supportsSeries, tableColumns]);

  // Group By options: dimensions not on the X axis or already picked at an earlier level.
  const groupByOptions = (atIndex: number) =>
    (schema?.dimensions ?? []).filter(
      (d) => d.key !== dimension && !groupBy.slice(0, atIndex).includes(d.key),
    );

  // Drill path options: dimensions not used as the X axis or an earlier level.
  const drillOptions = (atIndex: number) =>
    (schema?.dimensions ?? []).filter(
      (d) => d.key !== dimension && !drilldown.slice(0, atIndex).includes(d.key),
    );

  // Debounced live preview whenever the spec changes.
  useEffect(() => {
    if (!schema) return;
    if (needsDimension && !dimension) return;
    if (isCompare && !compareField) return; // wait for the Y field in Compare Fields mode
    const t = setTimeout(() => {
      setError(null);
      api.dashboards.preview(spec)
        .then((r) => setPreview(r.rows))
        .catch((e) => setError(e.message ?? "Preview failed"));
    }, 250);
    return () => clearTimeout(t);
  }, [spec, schema, needsDimension, dimension]);

  const save = async () => {
    if (!title.trim()) return setError("Give the chart a title.");
    setSaving(true);
    setError(null);
    try {
      if (existing) await api.dashboards.updateChart(dashboardKey, existing.widgetId, { title, spec });
      else await api.dashboards.addChart(dashboardKey, { title, spec });
      onSaved();
    } catch (e: any) {
      setError(e.message ?? "Failed to save chart");
    } finally {
      setSaving(false);
    }
  };

  if (!schema) return <div className="loading">loading builder…</div>;

  const TABS: { key: typeof tab; label: string }[] = [
    { key: "chart", label: "Chart" },
    { key: "options", label: "Options" },
    ...(needsDimension ? [{ key: "drill" as const, label: "Drill-down" }] : []),
    { key: "filters", label: "Filter" },
  ];
  const activeTab = TABS.some((t) => t.key === tab) ? tab : "chart";

  return (
    <div className="chart-editor">
      <div className="editor-controls">
        <div className="grid-2col">
          <label className="builder-field">
            Chart title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Open findings by BU" />
          </label>
          {schema.datasets.length > 1 && (
            <label className="builder-field">
              Data source
              <select value={dataset} onChange={(e) => changeDataset(e.target.value)}>
                {schema.datasets.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
              </select>
            </label>
          )}
        </div>

        <div className="editor-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={activeTab === t.key ? "active" : ""}
                    onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>

        <div className="editor-tab-body">
          {activeTab === "chart" && (
            <>
              <div className="field-label">Chart type</div>
              <div className="type-gallery">
                {schema.chartTypes.map((c) => (
                  <button key={c.key} className={`type-tile${chartType === c.key ? " active" : ""}`}
                          onClick={() => setChartType(c.key)} title={c.label} type="button">
                    <span className="type-icon">{CHART_ICON[c.key] ?? "▦"}</span>
                    <span className="type-name">{c.label}</span>
                  </button>
                ))}
              </div>

              {supportsSeries && (
                <div className="mode-toggle">
                  <button type="button" className={mode === "aggregate" ? "active" : ""}
                          onClick={() => setMode("aggregate")}>Calculate Values</button>
                  <button type="button" className={mode === "compare" ? "active" : ""}
                          onClick={() => setMode("compare")}>Compare Fields</button>
                </div>
              )}

              {needsDimension && (
                <label className="builder-field">
                  X axis — field / column
                  <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
                    {schema.dimensions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
              )}

              {!isTable && (isCompare ? (
                <label className="builder-field">
                  Y axis — field / column
                  <select value={compareField} onChange={(e) => setCompareField(e.target.value)}>
                    <option value="">— select a field —</option>
                    {schema.dimensions.filter((d) => d.key !== dimension).map((d) => (
                      <option key={d.key} value={d.key}>{d.label}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="builder-field">
                  Y axis — Aggregate
                  <select value={measure} onChange={(e) => setMeasure(e.target.value)}>
                    {schema.measures.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </select>
                </label>
              ))}

              {!isCompare && supportsSeries && (
                <div className="builder-field">
                  Group By (optional, multiple levels)
                  <div className="drill-levels">
                    {groupBy.map((lvl, i) => (
                      <div className="drill-level" key={i}>
                        {i > 0 && <span className="sep">/</span>}
                        <select value={lvl}
                                onChange={(e) => setGroupBy((g) => g.map((x, idx) => idx === i ? e.target.value : x))}>
                          {groupByOptions(i).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                        </select>
                        <button type="button" className="lvl-remove"
                                onClick={() => setGroupBy((g) => g.filter((_, idx) => idx !== i))}>✕</button>
                      </div>
                    ))}
                    {groupBy.length < 4 && groupByOptions(groupBy.length).length > 0 && (
                      <button type="button" className="lvl-add"
                              onClick={() => setGroupBy((g) => [...g, groupByOptions(g.length)[0].key])}>
                        + Add Group By level
                      </button>
                    )}
                  </div>
                </div>
              )}

              {isTable && (
                <div className="builder-field">
                  Columns to show
                  <p className="muted small">Pick which record columns appear. Use the <b>Filter</b> tab to choose which records are listed.</p>
                  <MultiCheckDropdown
                    label="Select columns"
                    options={recordCols.map((c) => ({ key: c.key, label: c.label }))}
                    selected={colShown}
                    onToggle={toggleTableCol}
                  />
                </div>
              )}
            </>
          )}

          {activeTab === "options" && (
            <div className="editor-display">
              <label className="chk">
                <input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} />
                Show legend
              </label>
              <label className="inline-field">
                Row limit
                <input type="number" min={1} max={1000} value={limit}
                       onChange={(e) => setLimit(e.target.value)} />
              </label>
            </div>
          )}

          {activeTab === "drill" && needsDimension && (
            <div className="drill-levels">
              <p className="muted small">Click a bar/slice on the saved chart to drill from the base field down each level.</p>
              <div className="drill-base">Base: <b>{labelOf("dimensions", dimension)}</b></div>
              {drilldown.map((lvl, i) => (
                <div className="drill-level" key={i}>
                  <span className="sep">›</span>
                  <select value={lvl}
                          onChange={(e) => setDrilldown((d) => d.map((x, idx) => idx === i ? e.target.value : x))}>
                    {drillOptions(i).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                  <button type="button" className="lvl-remove"
                          onClick={() => setDrilldown((d) => d.filter((_, idx) => idx !== i))}>✕</button>
                </div>
              ))}
              {drilldown.length < 5 && drillOptions(drilldown.length).length > 0 && (
                <button type="button" className="lvl-add"
                        onClick={() => setDrilldown((d) => [...d, drillOptions(d.length)[0].key])}>
                  + Add drill level
                </button>
              )}
            </div>
          )}

          {activeTab === "filters" && filterCatalog && (
            <FilterConditions conditions={conditions} logic={logic} catalog={filterCatalog}
                              onChange={(c, l) => { setConditions(c); setLogic(l); }} />
          )}
        </div>

        <div className="caption-preview">{caption}</div>

        {error && <div className="login-error">{error}</div>}
        <div className="builder-actions">
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : existing ? "Save chart" : "Add chart"}
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>

      <div className="editor-preview">
        <div className="field-label">Live preview</div>
        <div className="preview-panel">
          {isTable ? (
            preview.length
              ? <RecordsTableView cols={(tableColumns?.length ? tableColumns : defaultRecordCols)
                    .map((k) => recordCols.find((c) => c.key === k))
                    .filter(Boolean)
                    .map((c) => ({ key: c!.key, label: c!.label, numeric: c!.numeric }))}
                  rows={preview as unknown as RecordRow[]} />
              : <div className="loading">No records match this filter.</div>
          ) : preview.length || chartType === "number" ? (
            <GenericChart type={chartType} rows={preview} />
          ) : (
            <div className="loading">No data for this selection.</div>
          )}
        </div>
      </div>
    </div>
  );
}
