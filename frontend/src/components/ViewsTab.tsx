import { useEffect, useMemo, useState } from "react";
import { api, FieldsCatalog, FilterCondition, RecordView, Role } from "../api";
import FilterConditions from "./FilterConditions";
import Modal from "./Modal";
import MultiCheckDropdown from "./MultiCheckDropdown";

const REGISTER_KEY = "findings-register"; // the built-in full register (not deletable)

type RecCol = { key: string; label: string; numeric?: boolean };
type DatasetSchema = FieldsCatalog & { recordColumns: RecCol[] };

interface Draft {
  id?: number;
  datasetKey: string;
  name: string;
  description: string;
  conditions: FilterCondition[];
  logic: string;
  columns: string[];
  roleIds: number[];
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
  const [matches, setMatches] = useState<number | null>(null);
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
    api.admin.views.datasetSchema(draft.datasetKey).then(setSchema).catch((e) => setErr(String(e.message ?? e)));
  }, [draft?.datasetKey]);

  const defaultCols = (s: DatasetSchema | null) => (s?.recordColumns ?? []).slice(0, 8).map((c) => c.key);

  // Live "this view matches N records" while the admin builds the rule (per dataset).
  const scopeKey = useMemo(
    () => (draft ? JSON.stringify({ d: draft.datasetKey, c: draft.conditions, l: draft.logic }) : ""),
    [draft?.datasetKey, draft?.conditions, draft?.logic],
  );
  useEffect(() => {
    if (!draft) return;
    setMatches(null);
    const t = setTimeout(() => {
      api.admin.views.matchCount(draft.datasetKey, draft.conditions, draft.logic.trim() || undefined)
        .then(setMatches).catch(() => setMatches(null));
    }, 400);
    return () => clearTimeout(t);
  }, [scopeKey]);

  const openCreate = () => {
    setErr(null);
    setDraft({
      datasetKey: datasets[0]?.key ?? "archer-findings",
      name: "", description: "", conditions: [], logic: "", columns: [], roleIds: [],
    });
  };
  const openEdit = (v: RecordView) => {
    setErr(null);
    setDraft({
      id: v.id, datasetKey: v.dataset_key ?? "archer-findings",
      name: v.name, description: v.description ?? "",
      conditions: v.base_conditions ?? [], logic: v.base_logic ?? "",
      columns: v.columns ?? [], roleIds: v.role_ids ?? [],
    });
  };

  // Switching dataset invalidates the field/column choices (different fields).
  const changeDataset = (key: string) =>
    setDraft((d) => d && ({ ...d, datasetKey: key, conditions: [], logic: "", columns: [] }));

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setErr("Give the view a name.");
    const cols = draft.columns.length ? draft.columns : defaultCols(schema);
    if (!cols.length) return setErr("Pick at least one column.");
    setBusy(true); setErr(null);
    const byKey = new Map((schema?.recordColumns ?? []).map((c) => [c.key, c.label]));
    const body = {
      name: draft.name.trim(),
      datasetKey: draft.datasetKey,
      description: draft.description.trim() || undefined,
      baseConditions: draft.conditions,
      baseLogic: draft.logic.trim() || null,
      columns: cols.map((k) => ({ key: k, label: byKey.get(k) ?? k })),
      roleIds: draft.roleIds,
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
    if (!confirm(`Delete the view "${v.name}"? The records themselves are not affected.`)) return;
    try { await api.admin.views.remove(v.id); await load(); }
    catch (e: any) { setErr(e.message ?? "Delete failed"); }
  };

  const toggleCol = (key: string) =>
    setDraft((d) => d && ({ ...d, columns: d.columns.includes(key) ? d.columns.filter((k) => k !== key) : [...d.columns, key] }));
  const toggleRole = (id: number) =>
    setDraft((d) => d && ({ ...d, roleIds: d.roleIds.includes(id) ? d.roleIds.filter((r) => r !== id) : [...d.roleIds, id] }));

  const roleNames = (ids: number[]) =>
    ids.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).join(", ") || "— nobody yet —";
  const datasetName = (key: string) => datasets.find((d) => d.key === key)?.name ?? key;

  // Which columns the picker shows are "on" — default set until the admin customizes.
  const shownCols = draft && (draft.columns.length ? draft.columns : defaultCols(schema));

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
        in every view it matches. Choose the dataset, the rows, the columns, and who can see it.
      </p>

      {err && !draft && <div className="login-error">{err}</div>}

      <div className="records-table">
        <table className="findings">
          <thead>
            <tr><th>View</th><th>Dataset</th><th>Scope (preset filter)</th><th>Columns</th><th>Visible to roles</th><th></th></tr>
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
                <td className="muted">{v.columns?.length ?? 0}</td>
                <td className="muted">{roleNames(v.role_ids ?? [])}</td>
                <td>
                  <div className="panel-actions">
                    <button onClick={() => openEdit(v)}>Edit</button>
                    {v.key !== REGISTER_KEY && <button onClick={() => remove(v)}>✕</button>}
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

            <div className="field-label">Which records (preset filter)</div>
            <p className="muted small">
              Users can narrow this further, but never see outside it.
              {matches !== null && <> This view currently matches <b>{matches.toLocaleString()}</b> records.</>}
            </p>
            {schema
              ? <FilterConditions conditions={draft.conditions} logic={draft.logic} catalog={schema}
                                  onChange={(c, l) => setDraft({ ...draft, conditions: c, logic: l })} />
              : <div className="loading">loading {datasetName(draft.datasetKey)} fields…</div>}

            <div className="field-label">Columns to show</div>
            <MultiCheckDropdown
              label="Select columns"
              options={(schema?.recordColumns ?? []).map((c) => ({ key: c.key, label: c.label }))}
              selected={(k) => !!shownCols?.includes(k)}
              onToggle={toggleCol}
            />

            <div className="field-label">Visible to roles</div>
            <div className="col-picker">
              {roles.map((r) => (
                <label className="chk" key={r.id}>
                  <input type="checkbox" checked={draft.roleIds.includes(r.id)} onChange={() => toggleRole(r.id)} />
                  {r.name}
                </label>
              ))}
            </div>

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
