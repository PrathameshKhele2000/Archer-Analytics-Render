import { useEffect, useState } from "react";
import { api, ImportRoleRow, ImportUserRow, Permission, Role, SyncHistoryRow, SyncState } from "../api";
import { SafeUser } from "../auth";
import { buildCsv, downloadText, splitList } from "../csv";
import DataSourcesTab from "./DataSourcesTab";
import AccessControlTab from "./AccessControlTab";
import ImportPanel from "./ImportPanel";
import MappingTab from "./MappingTab";
import Modal from "./Modal";
import ViewsTab from "./ViewsTab";

function genPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s + "9!";
}

const USER_TEMPLATE =
  "email,fullName,password,roles\n" +
  "jane.doe@corp.local,Jane Doe,,analyst;viewer\n" +
  "john.roe@corp.local,John Roe,ChangeMe123!,admin\n";

function UsersTab({ currentUserId }: { currentUserId: number }) {
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [form, setForm] = useState({ email: "", password: "", fullName: "" });
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Edit user
  const [editUser, setEditUser] = useState<SafeUser | null>(null);
  const [editForm, setEditForm] = useState({ email: "", fullName: "", password: "" });
  const [editErr, setEditErr] = useState<string | null>(null);

  const load = () => {
    api.admin.users.list().then(setUsers).catch(console.error);
  };
  useEffect(load, []);

  const openEdit = (u: SafeUser) => {
    setEditErr(null);
    setEditForm({ email: u.email, fullName: u.full_name, password: "" });
    setEditUser(u);
  };

  const saveEdit = async () => {
    if (!editUser) return;
    setEditErr(null);
    if (!editForm.email.trim() || !editForm.fullName.trim()) return setEditErr("Email and full name are required.");
    if (editForm.password && editForm.password.length < 8) return setEditErr("Password must be at least 8 characters.");
    try {
      await api.admin.users.update(editUser.id, {
        email: editForm.email.trim(),
        fullName: editForm.fullName.trim(),
        ...(editForm.password ? { password: editForm.password } : {}),
      });
      setEditUser(null);
      load();
    } catch (e: any) {
      setEditErr(e.message ?? "Failed to update user");
    }
  };

  const removeUser = async (u: SafeUser) => {
    if (!confirm(`Delete user "${u.email}"? This cannot be undone.`)) return;
    try {
      await api.admin.users.remove(u.id);
      load();
    } catch (e: any) {
      alert(e.message ?? "Failed to delete user");
    }
  };

  const create = async () => {
    setError(null);
    if (!form.email.trim() || !form.fullName.trim() || form.password.length < 8) {
      setError("Email, full name, and a password of at least 8 characters are required.");
      return;
    }
    try {
      await api.admin.users.create(form);
      setForm({ email: "", password: "", fullName: "" });
      setCreateOpen(false);
      load();
    } catch (e: any) {
      setError(e.message ?? "Failed to create user");
    }
  };

  const toggleActive = async (u: SafeUser) => {
    await api.admin.users.update(u.id, { isActive: !u.is_active });
    load();
  };

  const exportUsers = () => downloadText(
    "users-export.csv",
    buildCsv(["email", "fullName", "password", "roles"],
      users.map((u) => [u.email, u.full_name, "", u.roles.join(";")])),
  );

  return (
    <div className="admin-tab">
      <div className="tab-toolbar">
        <span className="muted small">{users.length} user{users.length !== 1 ? "s" : ""}</span>
        <div className="toolbar-actions">
          <button className="link-btn" onClick={exportUsers}>⬆ Export CSV</button>
          <button className="tb-btn" onClick={() => setImportOpen(true)}>⬇ Import</button>
          <button className="tb-btn primary" onClick={() => { setError(null); setCreateOpen(true); }}>+ Create user</button>
        </div>
      </div>
      <table className="findings">
        <thead><tr><th>Email</th><th>Name</th><th>Roles (from groups)</th><th>Active</th><th>Last login</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.full_name}</td>
              <td>{u.roles.join(", ")}</td>
              <td>{u.is_active ? "Yes" : "No"}</td>
              <td className="num">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "—"}</td>
              <td className="row-actions">
                <button onClick={() => openEdit(u)}>Edit</button>
                <button onClick={() => toggleActive(u)}>{u.is_active ? "Deactivate" : "Activate"}</button>
                {u.id !== currentUserId && (
                  <button className="danger" onClick={() => removeUser(u)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {createOpen && (
        <Modal title="Create user" onClose={() => setCreateOpen(false)}>
          <div className="create-card in-modal">
            <div className="field-row">
              <label className="fld">Email
                <input value={form.email} autoFocus onChange={(e) => setForm({ ...form, email: e.target.value })}
                       placeholder="name@corp.local" />
              </label>
              <label className="fld">Full name
                <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                       placeholder="Jane Doe" />
              </label>
            </div>
            <div className="field-row">
              <label className="fld">Password
                <div className="pw-row">
                  <input type={showPw ? "text" : "password"} value={form.password}
                         onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min 8 chars" />
                  <button type="button" onClick={() => setShowPw((v) => !v)}>{showPw ? "Hide" : "Show"}</button>
                  <button type="button" onClick={() => { setForm({ ...form, password: genPassword() }); setShowPw(true); }}>Generate</button>
                </div>
              </label>
            </div>
            <p className="muted small">
              Access is granted through groups, not here — create the user, then add them to a group in
              Access Control → Groups.
            </p>
            <div className="form-actions">
              <button className="primary" onClick={create}>Create user</button>
              <button onClick={() => setCreateOpen(false)}>Cancel</button>
              {error && <span className="login-error inline">{error}</span>}
            </div>
          </div>
        </Modal>
      )}

      {editUser && (
        <Modal title={`Edit user — ${editUser.email}`} onClose={() => setEditUser(null)}>
          <div className="create-card in-modal">
            <div className="field-row">
              <label className="fld">Email
                <input value={editForm.email} autoFocus onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
              </label>
              <label className="fld">Full name
                <input value={editForm.fullName} onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })} />
              </label>
            </div>
            <div className="field-row">
              <label className="fld">Reset password <span className="muted small">(leave blank to keep current)</span>
                <input type="text" value={editForm.password} placeholder="min 8 chars"
                       onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} />
              </label>
            </div>
            <div className="fld">Roles
              <div className="muted small">
                {editUser.roles.length ? editUser.roles.join(", ") : "none"} — inherited from this user's groups.
                Change them in Access Control → Groups.
              </div>
            </div>
            <div className="form-actions">
              <button className="primary" onClick={saveEdit}>Save changes</button>
              <button onClick={() => setEditUser(null)}>Cancel</button>
              {editErr && <span className="login-error inline">{editErr}</span>}
            </div>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title="Import users" onClose={() => setImportOpen(false)} wide>
          <ImportPanel<ImportUserRow>
            title="Import users from CSV"
            hint="Columns: email, fullName, password, roles. Leave password blank to auto-generate one. Separate multiple roles with ; (e.g. analyst;viewer). Existing emails are updated."
            templateName="users-template.csv"
            templateContent={USER_TEMPLATE}
            columns={["Email", "Name", "Password", "Roles"]}
            parse={(objs) => objs.map((o) => ({
              email: o.email, fullName: o.fullname ?? o["full name"] ?? o.name ?? "",
              password: o.password || undefined, roles: splitList(o.roles),
            }))}
            toCells={(r) => [r.email, r.fullName, r.password ? "••••••" : "(auto-generated)", (r.roles ?? []).join(", ")]}
            onImport={(rows) => api.admin.users.import(rows)}
            onDone={load}
          />
        </Modal>
      )}
    </div>
  );
}


function SyncTab() {
  const [status, setStatus] = useState<SyncState[]>([]);
  const [history, setHistory] = useState<SyncHistoryRow[]>([]);

  const load = () => {
    api.sync.status().then(setStatus).catch(console.error);
    api.sync.history(25).then(setHistory).catch(console.error);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="admin-tab">
      <div className="sync-actions">
        <button onClick={() => api.sync.run(false).then(() => setTimeout(load, 1500))}>Run incremental sync</button>
        <button onClick={() => api.sync.run(true).then(() => setTimeout(load, 1500))}>Run full sync</button>
      </div>
      {status.map((s) => (
        <p key={s.module_alias}>
          <b>{s.module_alias}</b>: {s.last_status} · {s.rows_synced.toLocaleString()} rows
          {s.last_run_at ? ` · last run ${new Date(s.last_run_at).toLocaleString()}` : ""}
          {s.error_detail ? ` · error: ${s.error_detail}` : ""}
        </p>
      ))}
      <h3>Run history</h3>
      <table className="findings">
        <thead><tr><th>Started</th><th>Type</th><th>Attempt</th><th>Status</th><th>Rows</th><th>Duration</th><th>Error</th></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td className="num">{new Date(h.started_at).toLocaleString()}</td>
              <td>{h.run_type}</td>
              <td className="num">{h.attempt}</td>
              <td>{h.status}</td>
              <td className="num">{h.rows_synced.toLocaleString()}</td>
              <td className="num">{h.duration_ms ? `${(h.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
              <td>{h.error_detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab() {
  const [rows, setRows] = useState<{ id: number; action: string; entity_type: string | null; user_email: string | null; status_code: number | null; created_at: string }[]>([]);
  useEffect(() => { api.audit.search({ size: "50" }).then((r) => setRows(r.rows)).catch(console.error); }, []);
  return (
    <div className="admin-tab">
      <table className="findings">
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="num">{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.user_email ?? "system"}</td>
              <td>{r.action}</td>
              <td>{r.entity_type}</td>
              <td className="num">{r.status_code}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TABS = [
  { key: "users", label: "Users", render: (p: TabProps) => <UsersTab currentUserId={p.currentUserId} />, permission: "admin:users:manage" },
  { key: "roles", label: "Access Control", render: () => <AccessControlTab />, permission: "admin:roles:manage" },
  { key: "datasets", label: "Data Sources", render: () => <DataSourcesTab />, permission: "admin:datasets:manage" },
  { key: "views", label: "Views", render: () => <ViewsTab />, permission: "admin:reports:manage" },
  { key: "mapping", label: "Findings Field Mapping", render: () => <MappingTab />, permission: "admin:mapping:manage" },
  { key: "sync", label: "Sync", render: () => <SyncTab />, permission: "sync:read" },
  { key: "audit", label: "Audit", render: () => <AuditTab />, permission: "audit:read" },
];

interface TabProps { currentUserId: number }

export default function AdminPanel({ permissions, currentUserId }: { permissions: string[]; currentUserId: number }) {
  const available = TABS.filter((t) => permissions.includes(t.permission));
  const [active, setActive] = useState(available[0]?.key);
  if (!available.length) return <div className="loading">No admin sections available.</div>;
  const tab = available.find((t) => t.key === active) ?? available[0];
  return (
    <section className="panel">
      <div className="admin-tabs">
        {available.map((t) => (
          <button key={t.key} className={active === t.key ? "active" : ""} onClick={() => setActive(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab.render({ currentUserId })}
    </section>
  );
}
