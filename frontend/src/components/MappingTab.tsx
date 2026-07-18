import { useEffect, useState } from "react";
import { api, MappingPayload, MappingRow, TRANSFORM_OPTIONS } from "../api";

/** Default transform for an Archer field type (mirrors the backend). */
function transformForArcherType(type?: string | null): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("users") || t.includes("groups") || t.includes("permission")) return "users_list";
  if (t.includes("cross-reference") || t.includes("related record")) return "xref_display";
  if (t.includes("values list")) return "values_list";
  if (t.includes("date")) return "date";
  if (t.includes("numeric") || t.includes("number")) return "number";
  return "direct";
}

/**
 * Admin Panel → Field Mapping.
 * Archer field IDs/names differ per environment (DEV/UAT/PROD), so the mapping
 * lives in the database: point the app at an environment, Auto-map, fix the
 * leftovers, Save — no code change, no redeploy.
 */
export default function MappingTab() {
  const [payload, setPayload] = useState<MappingPayload | null>(null);
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);

  const load = () =>
    api.mapping.list().then((p) => { setPayload(p); setRows(p.rows); }).catch((e) => setErr(String(e.message ?? e)));

  useEffect(() => { load(); }, []);

  const dirty = (id: number, patch: Partial<MappingRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /**
   * Pick a column for a field. When mapping a previously-unmapped field, also pre-set
   * the transform from its Archer type (same default Auto-map uses) — the admin can
   * still change it, but a Users/Groups field shouldn't silently land as plain text.
   */
  const chooseColumn = (r: MappingRow, column: string | null) => {
    const patch: Partial<MappingRow> = { target_column: column };
    if (column && !r.target_column) patch.transform = transformForArcherType(r.archer_field_type);
    dirty(r.id, patch);
  };

  const autoMap = async () => {
    setBusy("auto"); setErr(null); setMsg(null);
    try {
      const r = await api.mapping.autoMap();
      await load();
      setMsg(`Auto-mapped ${r.applied} field${r.applied === 1 ? "" : "s"} · ${r.mapped} mapped, ${r.unmapped} still unmapped.`);
    } catch (e: any) { setErr(e.message ?? "Auto-map failed"); } finally { setBusy(null); }
  };

  const save = async () => {
    setBusy("save"); setErr(null); setMsg(null);
    try {
      const p = await api.mapping.save(
        rows.map((r) => ({ id: r.id, target_column: r.target_column, transform: r.transform, is_enabled: r.is_enabled })),
      );
      setPayload(p); setRows(p.rows);
      setMsg(`Saved · ${p.mapped} mapped, ${p.unmapped} unmapped.`);
    } catch (e: any) { setErr(e.message ?? "Save failed"); } finally { setBusy(null); }
  };

  if (!payload) return <div className="loading">{err ?? "loading mapping…"}</div>;

  // A column may only take one Archer field — grey out ones already used elsewhere.
  const takenBy = new Map<string, number>();
  rows.forEach((r) => { if (r.target_column) takenBy.set(r.target_column, r.id); });
  const unmappedCount = rows.filter((r) => !r.target_column).length;
  const shown = onlyUnmapped ? rows.filter((r) => !r.target_column) : rows;

  return (
    <div className="mapping-tab">
      <div className="tab-toolbar">
        <div className="map-summary">
          <b>{payload.source}</b> · {rows.length} Archer fields ·{" "}
          <span className="ok-chip">{rows.length - unmappedCount} mapped</span>{" "}
          {unmappedCount > 0 && <span className="warn-chip">{unmappedCount} unmapped</span>}
        </div>
        <div className="toolbar-actions">
          <label className="chk">
            <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} />
            Only unmapped
          </label>
          <button className="tb-btn" onClick={autoMap} disabled={!!busy}>
            {busy === "auto" ? "Auto-mapping…" : "⚡ Auto-map"}
          </button>
          <button className="tb-btn primary" onClick={save} disabled={!!busy}>
            {busy === "save" ? "Saving…" : "Save mapping"}
          </button>
        </div>
      </div>

      <p className="muted small">
        Each Archer field is stored in one reporting column. <b>Auto-map</b> matches fields whose names line up;
        anything left over (renamed or misspelled in Archer) is flagged below with a suggestion.
      </p>

      {err && <div className="login-error">{err}</div>}
      {msg && <div className="ok-note">{msg}</div>}

      <div className="records-table">
        <table className="findings">
          <thead>
            <tr>
              <th>Archer field</th>
              <th>Archer type</th>
              <th>→ Reporting column</th>
              <th>Transform</th>
              <th>Include</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.target_column ? undefined : "row-unmapped"}>
                <td>{r.archer_field_name}</td>
                <td className="muted">{r.archer_field_type ?? "—"}</td>
                <td>
                  <select
                    value={r.target_column ?? ""}
                    onChange={(e) => chooseColumn(r, e.target.value || null)}
                  >
                    <option value="">— ignore this field —</option>
                    {payload.targets.map((t) => {
                      const owner = takenBy.get(t.column);
                      const taken = owner !== undefined && owner !== r.id;
                      return (
                        <option key={t.column} value={t.column} disabled={taken}>
                          {t.column}{taken ? " (already used)" : ""}
                        </option>
                      );
                    })}
                  </select>
                  {!r.target_column && r.suggestion && (
                    <button className="link-btn suggest"
                            onClick={() => chooseColumn(r, r.suggestion!.column)}>
                      use “{r.suggestion.column}” ({Math.round(r.suggestion.score * 100)}%)
                    </button>
                  )}
                </td>
                <td>
                  <select value={r.transform} onChange={(e) => dirty(r.id, { transform: e.target.value })}>
                    {TRANSFORM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </td>
                <td>
                  <input type="checkbox" checked={r.is_enabled}
                         onChange={(e) => dirty(r.id, { is_enabled: e.target.checked })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
