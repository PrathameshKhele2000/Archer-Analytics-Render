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

// Every field is a dimension, a measure and searchable — these are always on, so
// they're set here rather than offered as per-field checkboxes. (The catalog only
// builds numeric measures for numeric columns, so "measure" on text is a harmless no-op.)
const FIELD_FLAGS = { is_dimension: true, is_measurable: true, is_searchable: true } as const;
const emptyField = (): DatasetFieldDef => ({ label: "", data_type: "text", ...FIELD_FLAGS });

const emptyDraft = (): CreateDatasetBody => ({
  name: "", description: "", sourceTable: "", keyColumn: "", watermarkColumn: "",
  fields: [emptyField()],
});

/** "Device Name" -> "device_name" (mirrors the backend; shown so the admin sees the real column). */
const toColumn = (s: string) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

// Mirrors backend/src/datasets/dataset.entity.ts resolveColumnKey(). Kept in sync
// deliberately rather than shared, so this file has no build dependency on the backend
// package — but the algorithm must match, or the name shown here would lie about what
// Create actually stores. "record_id" is what breaks most often: it's the column WE add
// automatically, so a CSV header like "Record Id" (a routine Archer export column)
// collides with it — the old behavior was a hard failure on Create with no preview of
// the collision. Now it's silently renamed to record_id_2, and this preview shows that.
const RESERVED_COLUMNS = new Set(["record_id", "synced_at"]);
const MAX_COLUMN_LEN = 58;
function resolveColumnKey(labelOrKey: string, index: number, taken: Set<string>): string {
  let base = toColumn(labelOrKey);
  if (!/^[a-z]/.test(base)) base = base ? `f_${base}` : `field_${index + 1}`;
  base = base.slice(0, MAX_COLUMN_LEN);
  let key = base;
  let n = 2;
  while (RESERVED_COLUMNS.has(key) || taken.has(key)) {
    const suffix = `_${n++}`;
    key = base.slice(0, MAX_COLUMN_LEN - suffix.length) + suffix;
  }
  taken.add(key);
  return key;
}
/** Column keys for a WHOLE field list at once, so duplicates within it resolve consistently. */
function resolveColumnKeys(fields: { key?: string; label: string }[]): string[] {
  const taken = new Set<string>();
  return fields.map((f, i) => resolveColumnKey(f.key || f.label, i, taken));
}

/** Header names commonly used for an export's unique row identifier, checked in order. */
const ID_HEADER_HINTS = [
  /^record\s*id$/i, /^content\s*id$/i, /^.*archer.*id$/i, /^vsr\s*archer\s*id$/i, /^id$/i,
];

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
  const [syncingKey, setSyncingKey] = useState<string | null>(null);

  const load = () => api.admin.datasets.list().then(setRows).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  // The run itself is fire-and-forget on the backend (it has to be — a full sync
  // can take a long time, far longer than an HTTP call should wait) — so the ONLY
  // way to know if a dataset is genuinely still syncing, as opposed to that click
  // having just completed instantly, is to poll real status, same as the Sync tab.
  const [liveRunning, setLiveRunning] = useState<Set<string>>(new Set());
  useEffect(() => {
    const poll = () => api.sync.status()
      .then((rows) => setLiveRunning(new Set(rows.filter((r) => r.last_status === "running").map((r) => r.module_alias))))
      .catch(() => undefined);
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  // Full sync for just this one pipe — the global "Run full sync" in Admin -> Sync
  // pulls every dataset, which is rarely what you want while testing one specific
  // dataset's config. Uses the same ?dataset= support the backend already has.
  const runSync = (d: Dataset) => {
    setErr(null); setSyncingKey(d.key);
    api.sync.run(true, d.key)
      .then(() => setLiveRunning((s) => new Set(s).add(d.key)))
      .catch((e: any) => setErr(e.message ?? `Sync failed for '${d.name}'`))
      .finally(() => setSyncingKey(null));
  };

  const stopSync = (d: Dataset) => {
    setErr(null); setSyncingKey(d.key);
    api.sync.cancel(d.key)
      .catch((e: any) => setErr(e.message ?? `Couldn't stop '${d.name}'`))
      .finally(() => setSyncingKey(null));
  };

  // Unlike Run full sync (upsert-only — a row deleted at the source just stays
  // behind here forever), Truncate & Sync replaces the table wholesale, so rows
  // removed at the source disappear here too. It's still safe if it fails partway:
  // the backend pulls the fresh copy into a holding table first and only swaps it
  // in once the ENTIRE pull has succeeded, so a failed run leaves the existing
  // table completely untouched — never a truncate followed by a broken/partial
  // reload. Confirmed up front regardless, since "replaces the whole table" is
  // the kind of thing that shouldn't happen from a misclick.
  const runTruncateSync = (d: Dataset) => {
    if (!confirm(
      `Truncate & Sync '${d.name}'?\n\nThis replaces the entire local table with a fresh pull from the source — records deleted at the source will be removed here too. The existing data stays untouched unless the whole pull succeeds.`,
    )) return;
    setErr(null); setSyncingKey(d.key);
    api.sync.run(true, d.key, true)
      .then(() => setLiveRunning((s) => new Set(s).add(d.key)))
      .catch((e: any) => setErr(e.message ?? `Truncate & Sync failed for '${d.name}'`))
      .finally(() => setSyncingKey(null));
  };

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
      const rawHeaders = table[0].map((h) => h.trim());
      // De-duplicate header TEXT before it becomes an object key. Two columns literally
      // named "Status" (or a blank trailing column from a trailing comma) would otherwise
      // collide as the same object property below — the second silently overwrites the
      // first, and both fields end up reading identical data with no error at all.
      const seenHeader = new Map<string, number>();
      const headers = rawHeaders.map((h) => {
        const label = h || "Column";
        const n = (seenHeader.get(label) ?? 0) + 1;
        seenHeader.set(label, n);
        return n === 1 ? label : `${label} (${n})`;
      });
      const rows: Record<string, string>[] = table.slice(1).map((r) => {
        const o: Record<string, string> = {};
        headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
        return o;
      });
      const fields: DatasetFieldDef[] = headers.map((h) => ({
        label: h, data_type: guessType(rows.map((r) => r[h])), ...FIELD_FLAGS,
      }));
      // Guess the row-identity column from common export header names (VSR Archer ID,
      // Record Id, ContentId, ...), so re-importing the same file upserts instead of
      // appending duplicate rows under fresh sequential ids. Left blank if nothing
      // matches — importRows falls back to numbering rows itself.
      const idHeader = headers.find((h) => ID_HEADER_HINTS.some((re) => re.test(h)));
      setDraft({
        ...draft, fields, sourceTable: "", watermarkColumn: "",
        keyColumn: idHeader ?? "",
      }); // CSV dataset has no live feed
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
      if (!cols.length) return setErr("No columns found on that table.");
      const realNames = new Set(cols.map((c) => c.name.toLowerCase()));

      // The key/watermark columns are detected automatically from the real source —
      // the admin never has to type them. If the current draft value isn't a real
      // column here, guess an id-shaped one from the real names; if that also comes
      // up empty, leave it blank and the fallback field below appears so it can still
      // be set by hand for the rare table with no recognizable id-like column name.
      let keyCol = (draft.keyColumn || "").trim();
      if (!keyCol || !realNames.has(keyCol.toLowerCase())) {
        keyCol = cols.find((c) => ID_HEADER_HINTS.some((re) => re.test(c.name)))?.name ?? "";
      }
      let wmCol = (draft.watermarkColumn || "").trim();
      if (wmCol && !realNames.has(wmCol.toLowerCase())) wmCol = "";

      const keyColLower = keyCol.toLowerCase();
      const fields: DatasetFieldDef[] = cols
        .filter((c) => c.name.toLowerCase() !== keyColLower) // key column -> record_id (added automatically)
        .map((c) => ({ label: c.name, data_type: c.dataType, ...FIELD_FLAGS }));
      setDraft({ ...draft, fields, keyColumn: keyCol, watermarkColumn: wmCol });
      setDiscovered(fields.length);
      if (!keyCol) {
        setErr(
          "Couldn't guess the row-id column from these column names — set \"Record id column\" below " +
          "to the real unique-id column from this table before saving, or sync will fail.",
        );
      }
    } catch (e: any) {
      // e.message is now the backend's actual reason (connection failure with the
      // real driver error, "table not found", etc.) rather than a bare status code.
      setErr(e.message ?? "Discover failed");
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
          // Two rows sharing the same id (a duplicate export row, a history/versioning
          // row, ...) are not an error — the later one wins, same as re-importing the
          // same id a second time would — but it does mean fewer rows landed than the
          // file had, which is worth saying rather than leaving the admin to notice a
          // row-count mismatch on their own.
          const notes: string[] = [];
          if (res.duplicates) notes.push(`${res.duplicates.toLocaleString()} duplicate id${res.duplicates === 1 ? "" : "s"} collapsed (last row for that id was kept)`);
          if (res.skipped) notes.push(`${res.skipped.toLocaleString()} row${res.skipped === 1 ? "" : "s"} skipped (no usable id)`);
          alert(
            `Dataset created and ${res.loaded.toLocaleString()} rows imported from ${csvName}.` +
            (notes.length ? `\n\n${notes.join("; ")}.` : ""),
          );
        }
      }
      closeModal();
      await load();
    } catch (e: any) { setErr(e.message ?? "Save failed"); }
    finally { setBusy(false); }
  };

  const remove = async (d: Dataset) => {
    const warning = d.is_protected
      ? `Remove the built-in "${d.name}" dataset and drop its table (${d.target_table})?\n\n` +
        `This is the original Vulnerability Findings pipe — its Field Mapping entries, its views, ` +
        `and any charts built on it or on those views will be deleted along with it. ` +
        `The data is a copy from Archer, so it can be re-synced if you recreate it.`
      : `Remove the "${d.name}" dataset and drop its table (${d.target_table})?\n\n` +
        `Its views, and any charts built on it or on those views, will be deleted too. ` +
        `The data is a copy from Archer, so it can be re-synced.`;
    if (!confirm(warning)) return;
    try {
      const res = await api.admin.datasets.remove(d.id);
      await load();
      if (res.deletedViews || res.deletedCharts) {
        alert(`"${d.name}" removed — also deleted ${res.deletedViews} view${res.deletedViews === 1 ? "" : "s"} and ${res.deletedCharts} chart${res.deletedCharts === 1 ? "" : "s"} that were built on it.`);
      }
    }
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
                  {/* Icon-only: this row repeats per dataset, so every character here is
                      multiplied by row count — a text label costs real width N times over,
                      unlike the page-level "+ Add dataset" button above (paid once). title=
                      keeps the action discoverable on hover instead of losing meaning. */}
                  <div className="panel-actions">
                    {d.source_table && (
                      liveRunning.has(d.key) ? (
                        <button onClick={() => stopSync(d)} disabled={syncingKey === d.key} className="danger-outline"
                                title={syncingKey === d.key ? "Stopping…" : "Stop sync"}>
                          {syncingKey === d.key ? "…" : "⏹"}
                        </button>
                      ) : (
                        <>
                          <button onClick={() => runSync(d)} disabled={syncingKey === d.key}
                                  title={syncingKey === d.key ? "Starting…" : "Run full sync"}>
                            {syncingKey === d.key ? "…" : "↻"}
                          </button>
                          <button onClick={() => runTruncateSync(d)} disabled={syncingKey === d.key}
                                  className="danger-outline"
                                  title={syncingKey === d.key ? "Starting…" : "Truncate & Sync — replace the whole table with a fresh pull; deletions at the source are reflected here too"}>
                            {syncingKey === d.key ? "…" : "↺"}
                          </button>
                        </>
                      )
                    )}
                    <button onClick={() => openEdit(d)} title="Edit">✎</button>
                    <button onClick={() => remove(d)} title="Delete dataset">✕</button>
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
            <div className="grid-2col">
              <label className="builder-field">
                Source table (MS SQL)
                <input value={draft.sourceTable ?? ""} onChange={(e) => setDraft({ ...draft, sourceTable: e.target.value })}
                       placeholder="dbo.ArcherDevicesFeed" />
              </label>
            </div>
            <p className="muted small">
              The row-id and last-updated columns are detected automatically from Discover (or from the
              CSV headers) — no need to type them. Target table will be <code>ds_{toColumn(draft.name) || "…"}</code>.
            </p>

            {/* Manual fallback: only shown when editing an existing dataset (Discover isn't
                available there), or when auto-detect genuinely couldn't guess a row-id column
                from the real names — the common path never shows these at all. */}
            {(!!editing || ((discovered != null || !!csvRows) && !draft.keyColumn)) && (
              <div className="grid-2col">
                <label className="builder-field">
                  Record id column
                  <input value={draft.keyColumn ?? ""} onChange={(e) => setDraft({ ...draft, keyColumn: e.target.value })}
                         placeholder="e.g. ContentId" />
                </label>
                <label className="builder-field">
                  Last-updated column (optional)
                  <input value={draft.watermarkColumn ?? ""} onChange={(e) => setDraft({ ...draft, watermarkColumn: e.target.value })}
                         placeholder="e.g. LastUpdated" />
                </label>
              </div>
            )}

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
            {(() => {
              // Resolved once over the fields that actually HAVE a label — mirroring
              // exactly what Create sends (it drops blank rows), so a still-empty row
              // the admin hasn't typed into yet doesn't get a premature "field_3" name
              // or falsely trip the collision hint below.
              const labeled = draft.fields.filter((f) => f.label.trim());
              const labeledKeys = resolveColumnKeys(labeled);
              const resolvedKeys = draft.fields.map((f) => {
                if (!f.label.trim()) return "";
                return labeledKeys[labeled.indexOf(f)];
              });
              const renamed = draft.fields.some((f, i) => f.label.trim() && resolvedKeys[i] !== toColumn(f.label));
              return (
                <>
                  {renamed && (
                    <p className="muted small">
                      Some column names below were adjusted to avoid clashing with a reserved
                      name or another field — the field <b>labels</b> you see are unaffected.
                    </p>
                  )}
                  <div className="records-table" style={{ maxHeight: 260 }}>
                    <table className="findings">
                      <thead>
                        <tr><th>Field name</th><th>Column</th><th>Type</th><th></th></tr>
                      </thead>
                      <tbody>
                        {draft.fields.map((f, i) => (
                          <tr key={i}>
                            <td><input value={f.label} onChange={(e) => patchField(i, { label: e.target.value })}
                                       placeholder="e.g. Device Name" /></td>
                            <td className="muted"><code>{resolvedKeys[i] || "—"}</code></td>
                            <td>
                              <select value={f.data_type} onChange={(e) => patchField(i, { data_type: e.target.value })}>
                                {DATA_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <button className="lvl-remove"
                                      onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, idx) => idx !== i) })}>✕</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
            <button type="button" className="lvl-add" onClick={() => setDraft({ ...draft, fields: [...draft.fields, emptyField()] })}>
              + Add field
            </button>
            <p className="muted small">
              Every field is automatically usable as a chart axis, as a measure (numeric fields), and in global search.
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
