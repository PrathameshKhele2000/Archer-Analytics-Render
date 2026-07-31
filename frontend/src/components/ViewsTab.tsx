import { useEffect, useMemo, useState } from "react";
import { api, FieldsCatalog, FilterCondition, RecordView, Role } from "../api";
import { formatCell } from "../recordColumns";
import FilterConditions from "./FilterConditions";
import Modal from "./Modal";
import MultiCheckDropdown from "./MultiCheckDropdown";

type RecCol = { key: string; label: string; numeric?: boolean };
type DatasetSchema = FieldsCatalog & { recordColumns: RecCol[] };

interface Draft {
  id?: number;
  datasetKey: string;
  name: string;
  description: string;
  conditions: FilterCondition[];
  logic: string;
  /** "all" shows every matching row; "top" shows only the first `rowLimit`. */
  rowMode: "all" | "top";
  rowLimit: string; // kept as text so the input can be empty while being typed
  columns: string[];
}

/**
 * Admin Panel → Record Views.
 * A view is a SAVED RULE (dataset + preset filter + columns + role access), not a
 * folder of copied records — so it stays correct after every sync. Each view is built
 * on ONE dataset; its columns and filter fields come from that dataset's catalog.
 */
export default function ViewsTab() {
  const [views, setViews] = useState<RecordView[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [datasets, setDatasets] = useState<{ key: string; name: string }[]>([]);
  const [schema, setSchema] = useState<DatasetSchema | null>(null); // for the draft's dataset
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftTab, setDraftTab] = useState<"columns" | "rows" | "condition">("columns");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [matches, setMatches] = useState<{ total: number; capped: boolean } | null>(null);
  const [preview, setPreview] = useState<Record<string, any>[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.admin.views.list().then(setViews).catch((e) => setErr(String(e.message ?? e)));

  useEffect(() => {
    load();
    api.admin.roles.list().then(setRoles).catch(console.error);
    api.admin.views.datasets().then(setDatasets).catch(console.error);
  }, []);

  // Load the selected dataset's fields + columns whenever the draft's dataset changes.
  useEffect(() => {
    if (!draft) return;
    setSchema(null);
    api.admin.views.datasetSchema(draft.datasetKey).then((s) => {
      setSchema(s);
      // Default to EVERY column selected when none are chosen yet (creating a view, or
      // after switching dataset). Editing an existing view keeps its saved columns.
      setDraft((d) => (d && d.columns.length ? d : d && { ...d, columns: s.recordColumns.map((c) => c.key) }));
    }).catch((e) => setErr(String(e.message ?? e)));
  }, [draft?.datasetKey]);

  // Live "this view matches N records" + a sample preview while the admin builds the
  // rule (per dataset). Columns are included so switching which fields are shown
  // refreshes the preview to match, not just changes to the condition itself.
  const scopeKey = useMemo(
    () => (draft ? JSON.stringify({ d: draft.datasetKey, c: draft.conditions, l: draft.logic, cols: draft.columns }) : ""),
    [draft?.datasetKey, draft?.conditions, draft?.logic, draft?.columns],
  );
  useEffect(() => {
    if (!draft) return;
    setMatches(null);
    setPreview(null);
    setPreviewLoading(true);
    const t = setTimeout(() => {
      const logic = draft.logic.trim() || undefined;
      api.admin.views.matchCount(draft.datasetKey, draft.conditions, logic)
        .then(setMatches).catch(() => setMatches(null));
      // Same columns the view will actually be saved with, so what's shown here is
      // what the view will really look like — not a generic "every field" preview.
      api.admin.views.previewMatches(draft.datasetKey, draft.conditions, logic, draft.columns)
        .then((r) => setPreview(r.rows))
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 400);
    return () => clearTimeout(t);
  }, [scopeKey]);

  const openCreate = () => {
    setErr(null);
    setDraftTab("columns");
    setDraft({
      datasetKey: datasets[0]?.key ?? "archer-findings",
      name: "", description: "", conditions: [], logic: "",
      rowMode: "all", rowLimit: "", columns: [],
    });
  };
  const openEdit = (v: RecordView) => {
    setErr(null);
    setDraftTab("columns");
    setDraft({
      id: v.id, datasetKey: v.dataset_key ?? "archer-findings",
      name: v.name, description: v.description ?? "",
      conditions: v.base_conditions ?? [], logic: v.base_logic ?? "",
      rowMode: v.row_limit ? "top" : "all",
      rowLimit: v.row_limit ? String(v.row_limit) : "",
      columns: v.columns ?? [],
    });
  };

  // Switching dataset invalidates the field/column choices (different fields).
  const changeDataset = (key: string) =>
    setDraft((d) => d && ({ ...d, datasetKey: key, conditions: [], logic: "", columns: [] }));

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setErr("Give the view a name.");
    const cols = draft.columns;
    if (!cols.length) return setErr("Pick at least one column.");
    const rowLimit = draft.rowMode === "top" ? Number(draft.rowLimit) : null;
    if (rowLimit !== null && (!Number.isInteger(rowLimit) || rowLimit < 1)) {
      return setErr("Enter how many rows to show (a whole number, 1 or more).");
    }
    setBusy(true); setErr(null);
    const byKey = new Map((schema?.recordColumns ?? []).map((c) => [c.key, c.label]));
    const body = {
      name: draft.name.trim(),
      datasetKey: draft.datasetKey,
      description: draft.description.trim() || undefined,
      baseConditions: draft.conditions,
      baseLogic: draft.logic.trim() || null,
      rowLimit,
      columns: cols.map((k) => ({ key: k, label: byKey.get(k) ?? k })),
      // Access is managed from Access Control (role → views), not here — so we never
      // send roleIds. Omitting it leaves any grants set there untouched.
    };
    try {
      if (draft.id) await api.admin.views.update(draft.id, body);
      else await api.admin.views.create(body);
      setDraft(null);
      await load();
    } catch (e: any) {
      setErr(e.message ?? "Save failed");
    } finally { setBusy(false); }
  };

  const remove = async (v: RecordView) => {
    if (!confirm(`Delete the view "${v.name}"? The records themselves are not affected, but any charts built on this view will be deleted too.`)) return;
    try {
      const res = await api.admin.views.remove(v.id);
      await load();
      if (res.deletedCharts) {
        alert(`"${v.name}" deleted — also deleted ${res.deletedCharts} chart${res.deletedCharts === 1 ? "" : "s"} that were built on it.`);
      }
    }
    catch (e: any) { setErr(e.message ?? "Delete failed"); }
  };

  const toggleCol = (key: string) =>
    setDraft((d) => d && ({ ...d, columns: d.columns.includes(key) ? d.columns.filter((k) => k !== key) : [...d.columns, key] }));
  const labelOf = (key: string) => schema?.recordColumns.find((c) => c.key === key)?.label ?? key;

  const roleNames = (ids: number[]) =>
    ids.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).join(", ") || "— nobody yet —";
  const datasetName = (key: string) => datasets.find((d) => d.key === key)?.name ?? key;

  return (
    <div className="views-tab">
      <div className="tab-toolbar">
        <div className="map-summary">{views.length} view{views.length === 1 ? "" : "s"} across {datasets.length} dataset{datasets.length === 1 ? "" : "s"}</div>
        <div className="toolbar-actions">
          <button className="tb-btn primary" onClick={openCreate}>+ Create view</button>
        </div>
      </div>

      <p className="muted small">
        A view is a <b>saved filter on one dataset</b>, so it refreshes itself on every sync and a record appears
        in every view it matches. Choose the dataset, the rows, and the columns; grant access to it in Access Control.
      </p>

      {err && !draft && <div className="login-error">{err}</div>}

      <div className="records-table">
        <table className="findings">
          <thead>
            <tr><th>View</th><th>Dataset</th><th>Scope (preset filter)</th><th>Rows</th><th>Columns</th><th>Visible to roles</th><th></th></tr>
          </thead>
          <tbody>
            {views.map((v) => (
              <tr key={v.id}>
                <td>
                  <b>{v.name}</b>
                  {v.description && <div className="muted small">{v.description}</div>}
                </td>
                <td className="muted">{datasetName(v.dataset_key)}</td>
                <td className="muted">
                  {v.base_conditions?.length
                    ? <>{v.base_conditions.length} condition{v.base_conditions.length > 1 ? "s" : ""}
                        {v.base_logic ? <> · logic <code>{v.base_logic}</code></> : null}</>
                    : <em>all records</em>}
                </td>
                <td className="muted">{v.row_limit ? `top ${v.row_limit.toLocaleString()}` : "all"}</td>
                <td className="muted">{v.columns?.length ?? 0}</td>
                <td className="muted">{roleNames(v.role_ids ?? [])}</td>
                <td>
                  <div className="panel-actions">
                    <button onClick={() => openEdit(v)}>Edit</button>
                    <button onClick={() => remove(v)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {draft && (
        <Modal title={draft.id ? "Edit view" : "Create view"} onClose={() => setDraft(null)} wide>
          <div className="create-card in-modal">
            <div className="grid-3col">
              <label className="builder-field">
                Data source
                <select value={draft.datasetKey} onChange={(e) => changeDataset(e.target.value)} disabled={!!draft.id}>
                  {datasets.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
                </select>
              </label>
              <label className="builder-field">
                Name
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                       placeholder="e.g. Critical Open" />
              </label>
              <label className="builder-field">
                Description
                <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                       placeholder="What this list is for" />
              </label>
            </div>
            {draft.id && <p className="muted small">A view's dataset can't be changed after creation.</p>}

            <div className="subtabs">
              <button className={draftTab === "columns" ? "active" : ""} onClick={() => setDraftTab("columns")}>
                Columns To Show
              </button>
              <button className={draftTab === "rows" ? "active" : ""} onClick={() => setDraftTab("rows")}>
                Row To Show
              </button>
              <button className={draftTab === "condition" ? "active" : ""} onClick={() => setDraftTab("condition")}>
                Show On Condition
              </button>
            </div>

            {draftTab === "columns" && (
              <>
                <div className="field-label">
                  Columns to show <span className="muted">({draft.columns.length} of {schema?.recordColumns.length ?? 0})</span>
                </div>
                <MultiCheckDropdown
                  label="Select columns"
                  options={(schema?.recordColumns ?? []).map((c) => ({ key: c.key, label: c.label }))}
                  selected={(k) => draft.columns.includes(k)}
                  onToggle={toggleCol}
                />
                <p className="muted small">
                  Picking a column adds it to the bottom of the list below — drag rows to set the order they
                  appear in the view's table and exports.
                </p>
                {draft.columns.length > 0 && (
                  <ul className="col-order-list">
                    {draft.columns.map((key, i) => (
                      <li
                        key={key}
                        className={`col-order-item${dragIdx === i ? " dragging" : ""}`}
                        draggable
                        onDragStart={() => setDragIdx(i)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          setDraft((d) => {
                            if (!d || dragIdx === null || dragIdx === i) return d;
                            const cols = [...d.columns];
                            const [moved] = cols.splice(dragIdx, 1);
                            cols.splice(i, 0, moved);
                            return { ...d, columns: cols };
                          });
                          setDragIdx(null);
                        }}
                        onDragEnd={() => setDragIdx(null)}
                      >
                        <span className="drag-handle" title="Drag to reorder">⠿</span>
                        <span className="col-order-label">{labelOf(key)}</span>
                        <button type="button" className="link-btn" onClick={() => toggleCol(key)}>✕</button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="muted small">
                  Who can see the view is set in <b>Access Control → Roles</b> (grant a role access to it, then
                  put people in a group that holds the role).
                </p>
              </>
            )}

            {draftTab === "rows" && (
              <>
                <div className="field-label">Rows to show</div>
                <div className="row-limit">
                  <label className="chk">
                    <input type="radio" name="rowMode" checked={draft.rowMode === "all"}
                           onChange={() => setDraft({ ...draft, rowMode: "all" })} />
                    All matching rows
                  </label>
                  <label className="chk">
                    <input type="radio" name="rowMode" checked={draft.rowMode === "top"}
                           onChange={() => setDraft({ ...draft, rowMode: "top" })} />
                    Only the top
                  </label>
                  <input className="row-limit-input" type="number" min={1} step={1}
                         value={draft.rowLimit} placeholder="e.g. 100"
                         disabled={draft.rowMode !== "top"}
                         onChange={(e) => setDraft({ ...draft, rowLimit: e.target.value })}
                         aria-label="Number of rows to show" />
                  <span className="muted small">rows</span>
                </div>
                <p className="muted small">
                  “Top” counts down the view’s own sort order, so users see the first N rows and nothing beyond
                  them — in the table and in exports.
                  {draft.rowMode === "top" && matches !== null && Number(draft.rowLimit) > 0 && (
                    <> This view matches <b>{matches.total.toLocaleString()}{matches.capped ? "+" : ""}</b> records
                      and will show <b>{Math.min(Number(draft.rowLimit), matches.total).toLocaleString()}</b>.</>
                  )}
                </p>
              </>
            )}

            {draftTab === "condition" && (
              <>
                <div className="field-label">Which records (preset filter)</div>
                <p className="muted small">
                  Users can narrow this further, but never see outside it.
                  {matches !== null && <> This view currently matches <b>{matches.total.toLocaleString()}{matches.capped ? "+" : ""}</b> records.</>}
                </p>
                {schema
                  ? <FilterConditions conditions={draft.conditions} logic={draft.logic} catalog={schema}
                                      onChange={(c, l) => setDraft({ ...draft, conditions: c, logic: l })} />
                  : <div className="loading">loading {datasetName(draft.datasetKey)} fields…</div>}

                <div className="field-label" style={{ marginTop: 16 }}>
                  Preview — first {preview?.length ?? 50} matching records
                </div>
                {previewLoading && <div className="loading">loading preview…</div>}
                {!previewLoading && preview && preview.length === 0 && (
                  <p className="muted small">No records match this condition yet.</p>
                )}
                {!previewLoading && preview && preview.length > 0 && (
                  <div className="records-table" style={{ maxHeight: 320, overflow: "auto" }}>
                    <table className="findings">
                      <thead>
                        <tr>{Object.keys(preview[0]).map((k) => <th key={k}>{labelOf(k)}</th>)}</tr>
                      </thead>
                      <tbody>
                        {preview.map((r, i) => (
                          <tr key={i}>{Object.keys(preview[0]).map((k) => <td key={k}>{formatCell(r[k])}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {err && <div className="login-error">{err}</div>}
            <div className="builder-actions">
              <button className="primary" onClick={save} disabled={busy || !schema}>
                {busy ? "Saving…" : draft.id ? "Save view" : "Create view"}
              </button>
              <button onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
