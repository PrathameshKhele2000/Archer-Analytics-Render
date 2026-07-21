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
  const [mode, setMode] = useState<"aggregate" | "compare" | "clause">(existing?.spec.mode ?? "aggregate");
  const [dimension, setDimension] = useState(existing?.spec.dimension ?? "");
  const [groupBy, setGroupBy] = useState<string[]>(
    existing?.spec.groupBy ?? (existing?.spec.series ? [existing.spec.series] : []),
  );
  const [compareField, setCompareField] = useState(existing?.spec.compareField ?? "");
  // Y axis is chosen as an aggregate FUNCTION (+ a field for sum/avg/min/max) rather
  // than a flat list of pre-baked measure names — clearer and covers every field.
  const initialMeasure = existing?.spec.measure ?? "count";
  const initialParts = /^(sum|avg|min|max)_(.+)$/.exec(initialMeasure);
  const [aggFn, setAggFn] = useState<string>(
    initialParts ? initialParts[1] : initialMeasure === "count" ? "count" : "custom",
  );
  const [aggField, setAggField] = useState<string>(initialParts ? initialParts[2] : "");
  const [customMeasure, setCustomMeasure] = useState<string>(
    !initialParts && initialMeasure !== "count" ? initialMeasure : "",
  );
  const [conditions, setConditions] = useState<FilterCondition[]>(existing?.spec.conditions ?? []);
  const [logic, setLogic] = useState(existing?.spec.logic ?? "");
  const [showLegend, setShowLegend] = useState(existing?.spec.showLegend ?? true);
  const [limit, setLimit] = useState<string>(existing?.spec.limit ? String(existing.spec.limit) : "50");
  const [drilldown, setDrilldown] = useState<string[]>(existing?.spec.drilldown ?? []);
  const [tableColumns, setTableColumns] = useState<string[] | null>(existing?.spec.tableColumns ?? null);
  /** Split the dataset's measures into "fn + field" pairs plus any custom measures. */
  const aggCatalog = useMemo(() => {
    const byFn: Record<string, { key: string; label: string }[]> = { sum: [], avg: [], min: [], max: [] };
    const custom: { key: string; label: string }[] = [];
    for (const m of schema?.measures ?? []) {
      const mt = /^(sum|avg|min|max)_(.+)$/.exec(m.key);
      if (mt) {
        const label = schema?.dimensions.find((d) => d.key === mt[2])?.label
          ?? mt[2].replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
        byFn[mt[1]].push({ key: mt[2], label });
      } else if (m.key !== "count") custom.push(m);
    }
    return { byFn, custom };
  }, [schema]);

  const measure = useMemo(() => {
    if (aggFn === "count") return "count";
    if (aggFn === "custom") return customMeasure || "count";
    return aggField ? `${aggFn}_${aggField}` : "count";
  }, [aggFn, aggField, customMeasure]);

  const [preview, setPreview] = useState<any[]>([]); // QueryRow[] for charts, RecordRow[] for the table (records list)
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"chart" | "options" | "drill" | "filters">("chart");

  useEffect(() => {
    api.dashboards.schema(dataset).then((s) => {
      setSchema(s);
      if (!existing) {
        setDimension((d) => d || s.dimensions[0]?.key || "");

      }
    }).catch(console.error);
  }, [existing, dataset]);

  /** Switching dataset invalidates every field choice — its fields are different. */
  const changeDataset = (key: string) => {
    if (key === dataset) return;
    setDataset(key);
    setSchema(null);
    setDimension(""); setGroupBy([]); setCompareField(""); setAggFn("count"); setAggField(""); setCustomMeasure("");
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

  /**
   * Switching mode resets the fields that belong to the other modes, so the three are
   * genuinely independent — nothing from Compare Fields leaks into Group & Count, etc.
   * (The X-axis field is deliberately kept: both Calculate Values and Compare Fields use it.)
   */
  const changeMode = (m: "aggregate" | "compare" | "clause") => {
    if (m === mode) return;
    setMode(m);
    setCompareField("");
    if (m === "clause") {
      // Group & Count needs at least one level — seed one so it works straight away
      // (an empty level list is an invalid spec and the preview would 400).
      const first = schema?.dimensions[0]?.key;
      setGroupBy(first ? [first] : []);
      setAggFn("count"); setAggField(""); setCustomMeasure("");
    } else {
      setGroupBy([]);
    }
  };

  const isCompare = mode === "compare" && supportsSeries;
  const isClause = mode === "clause" && supportsSeries;

  // Auto caption: "what compared to what" (the drill path is not part of the displayed text).
  const caption = useMemo(() => {
    if (chartType === "table") return "Filtered records";
    const m = labelOf("measures", measure);
    if (isClause) {
      return groupBy.length
        ? `Number of records grouped by ${groupBy.map((g) => labelOf("dimensions", g)).join(" / ")}`
        : "Number of records";
    }
    if (isCompare) return `${m}: ${labelOf("dimensions", dimension)} vs ${labelOf("dimensions", compareField)}`;
    if (!needsDimension) return m;
    let c = `${m} by ${labelOf("dimensions", dimension)}`;
    if (supportsSeries && groupBy.length) c += `, split by ${groupBy.map((g) => labelOf("dimensions", g)).join(" / ")}`;
    return c;
  }, [schema, chartType, isCompare, isClause, measure, dimension, groupBy, compareField, needsDimension, supportsSeries]);

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
    mode: isClause ? "clause" : isCompare ? "compare" : "aggregate",
    dimension: isClause ? null : needsDimension ? dimension : null,
    series: null,
    groupBy: (isClause || (!isCompare && supportsSeries)) ? groupBy : [],
    compareField: isCompare ? compareField : null,
    measure: isClause ? "count" : measure, // Group & Count always counts records
    conditions: conditions.length ? conditions : null,
    logic: logic.trim() || null,
    showLegend,
    limit: limit ? Number(limit) : null,
    drilldown: needsDimension ? drilldown : [],
    caption,
    tableColumns: chartType === "table" ? tableColumns : null,
  }), [dataset, chartType, isCompare, isClause, dimension, groupBy, compareField, measure, conditions, logic, showLegend, limit, drilldown, caption, needsDimension, supportsSeries, tableColumns]);

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
    if (needsDimension && !isClause && !dimension) return;
    if (isCompare && !compareField) return;   // wait for the Y field in Compare Fields mode
    if (isClause && !groupBy.length) return;  // wait for at least one grouping level
    const t = setTimeout(() => {
      setError(null);
      api.dashboards.preview(spec)
        .then((r) => setPreview(r.rows))
        .catch((e) => setError(e.message ?? "Preview failed"));
    }, 250);
    return () => clearTimeout(t);
  }, [spec, schema, needsDimension, dimension, isClause, isCompare, compareField, groupBy]);

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
                <>
                  <div className="mode-toggle">
                    <button type="button" className={mode === "aggregate" ? "active" : ""}
                            onClick={() => changeMode("aggregate")}>Calculate Values</button>
                    <button type="button" className={mode === "compare" ? "active" : ""}
                            onClick={() => changeMode("compare")}>Compare Fields</button>
                    <button type="button" className={mode === "clause" ? "active" : ""}
                            onClick={() => changeMode("clause")}>Group &amp; Count</button>
                  </div>
                  <div className="mode-hint">
                    {mode === "aggregate" && "One value per category — pick what to measure and what to break it down by."}
                    {mode === "compare" && "Two fields side by side — every combination of X and Y, measured the same way."}
                    {mode === "clause" && "A grouped summary table. Choose the levels; no X/Y axis needed."}
                  </div>
                </>
              )}

              {needsDimension && !isClause && (
                <label className="builder-field">
                  X axis — field / column
                  <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
                    {schema.dimensions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
              )}

              {!isTable && isCompare && (
                <label className="builder-field">
                  Compare against — second field
                  <select value={compareField} onChange={(e) => setCompareField(e.target.value)}>
                    <option value="">— select a field —</option>
                    {schema.dimensions.filter((d) => d.key !== dimension).map((d) => (
                      <option key={d.key} value={d.key}>{d.label}</option>
                    ))}
                  </select>
                </label>
              )}

              {!isTable && !isClause && (
                <div className="agg-row">
                  <label className="builder-field">
                    {isClause ? "Count / measure" : "Y axis — aggregate"}
                    <select value={aggFn} onChange={(e) => {
                      const fn = e.target.value;
                      setAggFn(fn);
                      // jump to the first field that supports the chosen function
                      if (fn !== "count" && fn !== "custom" && !aggCatalog.byFn[fn]?.some((f) => f.key === aggField)) {
                        setAggField(aggCatalog.byFn[fn]?.[0]?.key ?? "");
                      }
                      if (fn === "custom" && !customMeasure) setCustomMeasure(aggCatalog.custom[0]?.key ?? "");
                    }}>
                      <option value="count">Count of records</option>
                      {(["sum", "avg", "min", "max"] as const).map((fn) =>
                        aggCatalog.byFn[fn].length ? (
                          <option key={fn} value={fn}>
                            {{ sum: "Sum of", avg: "Average of", min: "Minimum of", max: "Maximum of" }[fn]}
                          </option>
                        ) : null,
                      )}
                      {aggCatalog.custom.length > 0 && <option value="custom">Predefined measure…</option>}
                    </select>
                  </label>

                  {aggFn !== "count" && aggFn !== "custom" && (
                    <label className="builder-field">
                      field
                      <select value={aggField} onChange={(e) => setAggField(e.target.value)}>
                        {(aggCatalog.byFn[aggFn] ?? []).map((f) => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {aggFn === "custom" && (
                    <label className="builder-field">
                      measure
                      <select value={customMeasure} onChange={(e) => setCustomMeasure(e.target.value)}>
                        {aggCatalog.custom.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}

              {!isCompare && supportsSeries && (
                <div className="builder-field">
                  {isClause ? "Group by (levels, in order)" : "Group By (optional, multiple levels)"}
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
          ) : isClause && !groupBy.length ? (
            <div className="loading">Add at least one “Group by” level to see the breakdown.</div>
          ) : preview.length || chartType === "number" ? (
            <GenericChart
              type={chartType}
              rows={preview}
              showLegend={showLegend}
              clauseLevels={isClause ? groupBy.map((g) => labelOf("dimensions", g)) : undefined}
            />
          ) : (
            <div className="loading">No data for this selection.</div>
          )}
        </div>
      </div>
    </div>
  );
}
