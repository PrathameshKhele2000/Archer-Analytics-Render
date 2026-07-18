import { useEffect, useState } from "react";
import { api, CreateDatasetBody, Dataset, DatasetFieldDef, DATA_TYPE_OPTIONS } from "../api";
import { parseCsv } from "../csv";
import Modal from "./Modal";

/** Guess a column's type from a sample of its CSV values. */
function guessType(values: string[]): string {
  const vals = values.map((v) => (v ?? "").trim()).filter(Boolean).slice(0, 30);
  if (!vals.length) return "text";
  // A cell that holds several values separated by ; or | is a multi-value (list) field.
  if (vals.some((v) => /[;|]/.test(v))) return "json";
  if (vals.every((v) => /^-?\d+$/.test(v))) return "integer";
  if (vals.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  if (vals.every((v) => /^(true|false|yes|no|y|n|1|0)$/i.test(v))) return "boolean";
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})/.test(v))) return "timestamp";
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v))) return "date";
  return "text";
}

const emptyField = (): DatasetFieldDef => ({ label: "", data_type: "text" });

const emptyDraft = (): CreateDatasetBody => ({
  name: "", description: "", sourceTable: "", keyColumn: "ContentId", watermarkColumn: "LastUpdated",
  fields: [emptyField()],
});

/** "Device Name" -> "device_name" (mirrors the backend; shown so the admin sees the real column). */
const toColumn = (s: string) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

/**
 * Admin Panel → Data Sources.
 * A dataset is a pipe: ONE flat reporting table in MS SQL → ONE table here. Adding one
 * only ever creates a new ds_* table, so it cannot disturb the datasets already running.
 */
export default function DataSourcesTab() {
  const [rows, setRows] = useState<Dataset[]>([]);
  const [draft, setDraft] = useState<CreateDatasetBody | null>(null);
  const [editing, setEditing] = useState<Dataset | null>(null); // dataset being edited (null = creating)
  const [sql, setSql] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<number | null>(null);
  const [csvRows, setCsvRows] = useState<Record<string, string>[] | null>(null); // parsed CSV to load after create
  const [csvName, setCsvName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.admin.datasets.list().then(setRows).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  const patchField = (i: number, patch: Partial<DatasetFieldDef>) =>
    setDraft((d) => d && ({ ...d, fields: d.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) }));

  /**
   * Read a CSV file: auto-fill fields from its headers (guessing each type from the
   * data), keep the rows to load into the new table after Create, and show a preview.
   */
  const onCsvFile = async (file?: File) => {
    if (!file || !draft) return;
    setErr(null); setSql(null); setDiscovered(null);
    try {
      // parseCsv keeps the original header casing (parseCsvObjects lowercases them),
      // so field labels read nicely and match the row keys we send to the backend.
      const table = parseCsv(await file.text());
      if (table.length < 2) return setErr("No data rows found in the CSV (check the header row).");
      const headers = table[0].map((h) => h.trim());
      const rows: Record<string, string>[] = table.slice(1).map((r) => {
        const o: Record<string, string> = {};
        headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
        return o;
      });
      const fields: DatasetFieldDef[] = headers.map((h) => {
        const type = guessType(rows.map((r) => r[h]));
        const numeric = type === "number" || type === "integer";
        // Default every column to a dimension so it's available on a chart's X axis /
        // compare fields; numeric columns are also measures (Y axis). Admins can narrow
        // this per-field in Edit.
        return { label: h, data_type: type, is_searchable: type === "text",
                 is_measurable: numeric, is_dimension: true };
      });
      setDraft({ ...draft, fields, sourceTable: "", watermarkColumn: "" }); // CSV dataset has no live feed
      setCsvRows(rows); setCsvName(file.name);
    } catch (e: any) {
      setErr(e.message ?? "Could not read the CSV file.");
    }
  };
  const clearCsv = () => { setCsvRows(null); setCsvName(null); };

  /**
   * Scan the source table in MS SQL and auto-fill the fields with real column names +
   * types (INFORMATION_SCHEMA). The record-id column becomes record_id automatically,
   * so it's excluded from the field list. The admin can still adjust before Create.
   */
  const discover = async () => {
    if (!draft?.sourceTable?.trim()) return setErr("Enter the source table first (e.g. dbo.ArcherFindingsFeed).");
    setDiscovering(true); setErr(null); setSql(null); setDiscovered(null);
    try {
      const cols = await api.admin.source.columns(draft.sourceTable.trim());
      const keyCol = (draft.keyColumn || "").trim().toLowerCase();
      const fields: DatasetFieldDef[] = cols
        .filter((c) => c.name.toLowerCase() !== keyCol) // key column -> record_id (added automatically)
        .map((c) => ({
          label: c.name,
          data_type: c.dataType,
          is_searchable: c.dataType === "text",
          is_measurable: c.dataType === "number" || c.dataType === "integer",
          // Every column is a dimension by default (available on the chart X axis /
          // compare fields); admins can narrow this per-field in Edit.
          is_dimension: true,
        }));
      if (!fields.length) return setErr("No columns found on that table.");
      setDraft({ ...draft, fields });
      setDiscovered(fields.length);
    } catch (e: any) {
      setErr(e.message?.includes("400")
        ? "Couldn't read the source. Is the MS SQL connection configured (MSSQL_* in .env) and the table name correct?"
        : (e.message ?? "Discover failed"));
    } finally { setDiscovering(false); }
  };

  const preview = async () => {
    if (!draft) return;
    setErr(null); setSql(null);
    try { setSql((await api.admin.datasets.preview(draft)).sql); }
    catch (e: any) { setErr(e.message ?? "Preview failed"); }
  };

  /** Open the modal pre-filled with a dataset's current settings + fields (edit mode). */
  const openEdit = async (d: Dataset) => {
    setErr(null); setSql(null); clearCsv();
    try {
      const fields = await api.admin.datasets.fields(d.id);
      setEditing(d);
      setDraft({
        name: d.name, description: d.description ?? "",
        sourceTable: d.source_table ?? "", keyColumn: d.key_column, watermarkColumn: d.watermark_column ?? "",
        fields: fields.filter((f) => f.key !== "record_id").map((f) => ({ key: f.key, label: f.label, data_type: f.data_type,
          is_dimension: f.is_dimension, is_measurable: f.is_measurable, is_searchable: f.is_searchable })),
      });
    } catch (e: any) { setErr(e.message ?? "Could not load the dataset."); }
  };

  const closeModal = () => { setDraft(null); setEditing(null); setSql(null); clearCsv(); };

  const create = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setErr("Give the dataset a name.");
    if (!draft.fields.some((f) => f.label.trim())) return setErr("Add at least one field.");
    setBusy(true); setErr(null);
    const body = { ...draft, fields: draft.fields.filter((f) => f.label.trim()) };
    try {
      if (editing) {
        await api.admin.datasets.update(editing.id, body);
      } else {
        const created = await api.admin.datasets.create(body);
        if (csvRows?.length) {
          const res = await api.admin.datasets.importRows(created.id, csvRows, draft.keyColumn?.trim() || undefined);
          alert(`Dataset created and ${res.loaded.toLocaleString()} rows imported from ${csvName}.`);
        }
      }
      closeModal();
      await load();
    } catch (e: any) { setErr(e.message ?? "Save failed"); }
    finally { setBusy(false); }
  };

  const remove = async (d: Dataset) => {
    if (!confirm(`Remove the "${d.name}" dataset and drop its table (${d.target_table})?\n\nThe data is a copy from Archer, so it can be re-synced.`)) return;
    try { await api.admin.datasets.remove(d.id); await load(); }
    catch (e: any) { setErr(e.message ?? "Remove failed"); }
  };

  return (
    <div className="datasets-tab">
      <div className="tab-toolbar">
        <div className="map-summary">{rows.length} dataset{rows.length === 1 ? "" : "s"}</div>
        <div className="toolbar-actions">
          <button className="tb-btn primary" onClick={() => { setErr(null); setSql(null); setDiscovered(null); clearCsv(); setEditing(null); setDraft(emptyDraft()); }}>
            + Add dataset
          </button>
        </div>
      </div>

      <p className="muted small">
        Each dataset is one <b>pipe</b>: a flat Archer reporting table in MS SQL is copied into its own
        table here. Pipes are independent — a new one can't affect the others.
      </p>

      {err && !draft && <div className="login-error">{err}</div>}

      <div className="records-table">
        <table className="findings">
          <thead>
            <tr><th>Dataset</th><th>Source (MS SQL)</th><th>Target (Postgres)</th><th>Fields</th><th>Sync key</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>
                  <b>{d.name}</b>{d.is_protected && <span className="ok-chip" style={{ marginLeft: 6 }}>built-in</span>}
                  {d.description && <div className="muted small">{d.description}</div>}
                </td>
                <td className="muted"><code>{d.source_table ?? "— not set —"}</code></td>
                <td className="muted">
                  <code>{d.target_table}</code>
                  {!d.table_exists && <span className="warn-chip" style={{ marginLeft: 6 }}>table missing</span>}
                </td>
                <td className="muted">{d.field_count}</td>
                <td className="muted"><code>{d.key_column}</code>{d.watermark_column ? <> · <code>{d.watermark_column}</code></> : null}</td>
                <td>
                  <div className="panel-actions">
                    <button onClick={() => openEdit(d)}>Edit</button>
                    {!d.is_protected && <button onClick={() => remove(d)}>✕</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {draft && (
        <Modal title={editing ? `Edit dataset — ${editing.name}` : "Add dataset"} onClose={closeModal} wide>
          <div className="create-card in-modal">
            <div className="grid-2col">
              <label className="builder-field">
                Name
                <input value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                       placeholder="e.g. Devices" />
              </label>
              <label className="builder-field">
                Description
                <input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                       placeholder="What this data is" />
              </label>
            </div>

            <div className="field-label">Where it comes from</div>
            <div className="grid-3col">
              <label className="builder-field">
                Source table (MS SQL)
                <input value={draft.sourceTable ?? ""} onChange={(e) => setDraft({ ...draft, sourceTable: e.target.value })}
                       placeholder="dbo.ArcherDevicesFeed" />
              </label>
              <label className="builder-field">
                Record id column
                <input value={draft.keyColumn ?? ""} onChange={(e) => setDraft({ ...draft, keyColumn: e.target.value })}
                       placeholder="ContentId" />
              </label>
              <label className="builder-field">
                Last-updated column
                <input value={draft.watermarkColumn ?? ""} onChange={(e) => setDraft({ ...draft, watermarkColumn: e.target.value })}
                       placeholder="LastUpdated" />
              </label>
            </div>
            <p className="muted small">
              The record id makes re-syncing update rather than duplicate; the last-updated column enables
              incremental sync. Target table will be <code>ds_{toColumn(draft.name) || "…"}</code>.
            </p>

            {!editing && <div className="discover-bar">
              <button type="button" className="tb-btn" onClick={discover} disabled={discovering}>
                {discovering ? "Scanning…" : "🔍 Discover columns from source"}
              </button>
              <span className="muted small">— or —</span>
              <label className="tb-btn" style={{ cursor: "pointer" }}>
                📄 Import a CSV
                <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
                       onChange={(e) => onCsvFile(e.target.files?.[0])} />
              </label>
              <span className="muted small">
                {csvName
                  ? `Loaded ${csvName} — ${csvRows?.length.toLocaleString()} rows. Fields auto-filled; review types then Create.`
                  : discovered != null
                    ? `Found ${discovered} columns — review the types below, then Create.`
                    : "Fill fields from an MS SQL feed, or upload a CSV (its columns become the fields)."}
              </span>
            </div>}

            {csvRows && csvRows.length > 0 && (
              <>
                <div className="field-label">Preview (first 5 rows of the CSV)</div>
                <div className="records-table" style={{ maxHeight: 180 }}>
                  <table className="findings">
                    <thead><tr>{Object.keys(csvRows[0]).map((h) => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {csvRows.slice(0, 5).map((r, i) => (
                        <tr key={i}>{Object.keys(csvRows[0]).map((h) => <td key={h}>{r[h] || "—"}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="field-label">Fields</div>
            <div className="records-table" style={{ maxHeight: 260 }}>
              <table className="findings">
                <thead>
                  <tr><th>Field name</th><th>Column</th><th>Type</th><th>Group by</th><th>Measure</th><th>Search</th><th></th></tr>
                </thead>
                <tbody>
                  {draft.fields.map((f, i) => (
                    <tr key={i}>
                      <td><input value={f.label} onChange={(e) => patchField(i, { label: e.target.value })}
                                 placeholder="e.g. Device Name" /></td>
                      <td className="muted"><code>{toColumn(f.label) || "—"}</code></td>
                      <td>
                        <select value={f.data_type} onChange={(e) => patchField(i, { data_type: e.target.value })}>
                          {DATA_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                      <td><input type="checkbox" checked={!!f.is_dimension} onChange={(e) => patchField(i, { is_dimension: e.target.checked })} /></td>
                      <td><input type="checkbox" checked={!!f.is_measurable} onChange={(e) => patchField(i, { is_measurable: e.target.checked })} /></td>
                      <td><input type="checkbox" checked={!!f.is_searchable} onChange={(e) => patchField(i, { is_searchable: e.target.checked })} /></td>
                      <td>
                        <button className="lvl-remove"
                                onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, idx) => idx !== i) })}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="lvl-add" onClick={() => setDraft({ ...draft, fields: [...draft.fields, emptyField()] })}>
              + Add field
            </button>
            <p className="muted small">
              <b>Group by</b> = usable as a chart axis · <b>Measure</b> = can be summed/averaged · <b>Search</b> = included in global search.
            </p>

            {sql && <pre className="sql-preview">{sql}</pre>}
            {err && <div className="login-error">{err}</div>}

            <div className="builder-actions">
              <button onClick={preview}>Preview SQL</button>
              <button className="primary" onClick={create} disabled={busy}>
                {busy ? "Saving…" : editing ? "Save changes" : "Create dataset"}
              </button>
              <button onClick={closeModal}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
