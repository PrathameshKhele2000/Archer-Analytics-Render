import { useEffect, useState } from "react";
import { api, GrantableResources, ImportRoleRow, Permission, Role, UserGroup } from "../api";
import { SafeUser } from "../auth";
import { buildCsv, downloadText, splitList } from "../csv";
import ImportPanel from "./ImportPanel";
import Modal from "./Modal";
import MultiCheckDropdown from "./MultiCheckDropdown";

const ROLE_TEMPLATE =
  "name,description,permissions\n" +
  "auditor,Read-only auditor,dashboard:read;report:read;audit:read\n" +
  "compliance,Compliance reviewer,dashboard:read;report:read;report:export\n";

/** What a role can be granted access to. Read-only for now — the only level we issue. */
type ResourceKind = "views" | "dashboards";
const RESOURCE_LABEL: Record<ResourceKind, string> = { views: "Views", dashboards: "Dashboards" };

// ---------------------------------------------------------------- Roles

/**
 * One role: its read access to specific views/dashboards, plus (folded away) the
 * system permission codes that decide which parts of the app it can reach at all.
 */
function RoleCard({
  role, permissions, resources, onChanged,
}: {
  role: Role;
  permissions: Permission[];
  resources: GrantableResources;
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<ResourceKind>("views");
  const [showPerms, setShowPerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const granted = kind === "views" ? role.view_ids : role.dashboard_ids;
  const options = resources[kind].map((r) => ({ key: String(r.id), label: r.name }));

  // Each toggle saves immediately: the list is the source of truth, and an unsaved
  // checkbox in an access screen is the kind of thing that silently doesn't apply.
  const toggle = async (idStr: string) => {
    const id = Number(idStr);
    const next = granted.includes(id) ? granted.filter((g) => g !== id) : [...granted, id];
    setBusy(true); setErr(null);
    try {
      await api.admin.roles.setResources(role.id, kind === "views" ? { viewIds: next } : { dashboardIds: next });
      onChanged();
    } catch (e: any) {
      setErr(e.message ?? "Could not save access");
    } finally { setBusy(false); }
  };

  const togglePermission = async (code: string) => {
    const has = role.permissions.includes(code);
    const next = has ? role.permissions.filter((c) => c !== code) : [...role.permissions, code];
    const ids = permissions.filter((p) => next.includes(p.code)).map((p) => p.id);
    setBusy(true); setErr(null);
    try {
      await api.admin.roles.setPermissions(role.id, ids);
      onChanged();
    } catch (e: any) {
      setErr(e.message ?? "Could not save permissions");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm(`Delete role "${role.name}"? Users and groups holding it simply lose it. This cannot be undone.`)) return;
    try { await api.admin.roles.remove(role.id); onChanged(); }
    catch (e: any) { setErr(e.message ?? "Failed to delete role"); }
  };

  const named = (kindKey: ResourceKind, ids: number[]) =>
    resources[kindKey].filter((r) => ids.includes(r.id)).map((r) => r.name);
  const summary = [
    ...named("views", role.view_ids).map((n) => `View: ${n}`),
    ...named("dashboards", role.dashboard_ids).map((n) => `Dashboard: ${n}`),
  ];

  return (
    <div className="role-card">
      <div className="role-card-head">
        <h3>{role.name} {role.is_system && <span className="muted">(system)</span>}</h3>
        {!role.is_system && <button className="danger" onClick={remove}>Delete role</button>}
      </div>
      {role.description && <p className="muted">{role.description}</p>}

      <div className="access-row">
        <label className="fld inline">
          Access to
          <select value={kind} onChange={(e) => setKind(e.target.value as ResourceKind)}>
            <option value="views">Views</option>
            <option value="dashboards">Dashboards</option>
          </select>
        </label>
        <MultiCheckDropdown
          label={`Select ${RESOURCE_LABEL[kind].toLowerCase()}`}
          options={options}
          selected={(k) => granted.includes(Number(k))}
          onToggle={toggle}
        />
        <span className="access-level" title="Read access is the only level issued today">Read access</span>
        {busy && <span className="muted small">saving…</span>}
      </div>

      {summary.length > 0 ? (
        <div className="access-chips">
          {summary.map((s) => <span className="access-chip" key={s}>{s}</span>)}
        </div>
      ) : (
        <p className="muted small">No views or dashboards granted yet.</p>
      )}

      {err && <div className="login-error">{err}</div>}

      <button className="link-btn" onClick={() => setShowPerms((s) => !s)}>
        {showPerms ? "▴ Hide" : "▾ Show"} system permissions ({role.permissions.length})
      </button>
      {showPerms && (
        <>
          <p className="muted small">
            These decide which parts of the app the role can open at all (e.g. <code>report:read</code> to use the
            Views tab). Access above decides <em>which</em> views and dashboards it then sees.
          </p>
          <div className="perm-grid">
            {permissions.map((p) => (
              <label key={p.code} className="chk">
                <input type="checkbox" checked={role.permissions.includes(p.code)}
                       onChange={() => togglePermission(p.code)} />
                {p.code}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RolesPanel({
  roles, permissions, resources, reload,
}: {
  roles: Role[]; permissions: Permission[]; resources: GrantableResources; reload: () => void;
}) {
  const [newRole, setNewRole] = useState({ name: "", description: "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const createRole = async () => {
    await api.admin.roles.create(newRole);
    setNewRole({ name: "", description: "" });
    setCreateOpen(false);
    reload();
  };

  const exportRoles = () => downloadText(
    "roles-export.csv",
    buildCsv(["name", "description", "permissions"],
      roles.map((r) => [r.name, r.description ?? "", r.permissions.join(";")])),
  );

  return (
    <>
      <div className="tab-toolbar">
        <span className="muted small">{roles.length} role{roles.length !== 1 ? "s" : ""}</span>
        <div className="toolbar-actions">
          <button className="link-btn" onClick={exportRoles}>⬆ Export CSV</button>
          <button className="tb-btn" onClick={() => setImportOpen(true)}>⬇ Import</button>
          <button className="tb-btn primary" onClick={() => setCreateOpen(true)}>+ Create role</button>
        </div>
      </div>
      <p className="muted small">
        A role grants <b>read access</b> to the views and dashboards you pick. Assign it to users directly,
        or to a group so everyone in that group inherits it.
      </p>

      {roles.map((r) => (
        <RoleCard key={r.id} role={r} permissions={permissions} resources={resources} onChanged={reload} />
      ))}

      {createOpen && (
        <Modal title="Create role" onClose={() => setCreateOpen(false)}>
          <div className="create-card in-modal">
            <div className="field-row">
              <label className="fld">Name
                <input value={newRole.name} autoFocus
                       onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
                       placeholder="e.g. auditor" />
              </label>
              <label className="fld">Description
                <input value={newRole.description}
                       onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
                       placeholder="what this role is for" />
              </label>
            </div>
            <div className="form-actions">
              <button className="primary" disabled={!newRole.name.trim()} onClick={createRole}>Create role</button>
              <button onClick={() => setCreateOpen(false)}>Cancel</button>
              <span className="muted small">Grant it views and dashboards after creating.</span>
            </div>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title="Import roles" onClose={() => setImportOpen(false)} wide>
          <ImportPanel<ImportRoleRow>
            title="Import roles from CSV"
            hint="Columns: name, description, permissions. Separate multiple permission codes with ; (e.g. dashboard:read;report:read). Existing role names are updated in place."
            templateName="roles-template.csv"
            templateContent={ROLE_TEMPLATE}
            columns={["Name", "Description", "Permissions"]}
            parse={(objs) => objs.map((o) => ({
              name: o.name, description: o.description || undefined, permissions: splitList(o.permissions),
            }))}
            toCells={(r) => [r.name, r.description ?? "", (r.permissions ?? []).join(", ")]}
            onImport={(rows) => api.admin.roles.import(rows)}
            onDone={reload}
          />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Groups

interface GroupDraft { id?: number; name: string; description: string; roleIds: number[]; userIds: number[]; }

function GroupsPanel({ roles, reload: reloadRoles }: { roles: Role[]; reload: () => void }) {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [draft, setDraft] = useState<GroupDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api.admin.groups.list().then(setGroups).catch((e) => setErr(e.message ?? String(e)));
    api.admin.users.list().then(setUsers).catch(console.error);
  };
  useEffect(load, []);

  const openCreate = () => { setErr(null); setDraft({ name: "", description: "", roleIds: [], userIds: [] }); };
  const openEdit = (g: UserGroup) => {
    setErr(null);
    setDraft({
      id: g.id, name: g.name, description: g.description ?? "",
      roleIds: g.role_ids ?? [], userIds: g.user_ids ?? [],
    });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setErr("Give the group a name.");
    setBusy(true); setErr(null);
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      roleIds: draft.roleIds,
      userIds: draft.userIds,
    };
    try {
      if (draft.id) await api.admin.groups.update(draft.id, body);
      else await api.admin.groups.create(body);
      setDraft(null);
      load();
      reloadRoles(); // membership changes what a role effectively reaches
    } catch (e: any) {
      setErr(e.message ?? "Save failed");
    } finally { setBusy(false); }
  };

  const remove = async (g: UserGroup) => {
    if (!confirm(`Delete group "${g.name}"? Its ${g.member_count} member(s) keep their own roles but lose the group's.`)) return;
    try { await api.admin.groups.remove(g.id); load(); }
    catch (e: any) { setErr(e.message ?? "Delete failed"); }
  };

  const toggleIn = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const userLabel = (u: SafeUser) => `${u.full_name || u.email} (${u.email})`;

  return (
    <>
      <div className="tab-toolbar">
        <span className="muted small">{groups.length} group{groups.length !== 1 ? "s" : ""}</span>
        <div className="toolbar-actions">
          <button className="tb-btn primary" onClick={openCreate}>+ Create group</button>
        </div>
      </div>
      <p className="muted small">
        A group is a set of users that carries roles. Members get every role the group holds
        <b> in addition to</b> their own — nothing is taken away.
      </p>

      {err && !draft && <div className="login-error">{err}</div>}

      <div className="records-table">
        <table className="findings">
          <thead>
            <tr><th>Group</th><th>Roles it grants</th><th>Members</th><th></th></tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={4} className="muted">No groups yet. Create one to assign roles to several users at once.</td></tr>
            )}
            {groups.map((g) => (
              <tr key={g.id}>
                <td>
                  <b>{g.name}</b>
                  {g.description && <div className="muted small">{g.description}</div>}
                </td>
                <td className="muted">{g.role_names?.length ? g.role_names.join(", ") : <em>none</em>}</td>
                <td className="muted">{g.member_count}</td>
                <td>
                  <div className="panel-actions">
                    <button onClick={() => openEdit(g)}>Edit</button>
                    <button onClick={() => remove(g)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {draft && (
        <Modal title={draft.id ? "Edit group" : "Create group"} onClose={() => setDraft(null)} wide>
          <div className="create-card in-modal">
            <div className="field-row">
              <label className="fld">Name
                <input value={draft.name} autoFocus
                       onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                       placeholder="e.g. Treasury analysts" />
              </label>
              <label className="fld">Description
                <input value={draft.description}
                       onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                       placeholder="who this group is for" />
              </label>
            </div>

            <div className="field-label">Roles this group grants</div>
            <MultiCheckDropdown
              label="Select roles"
              options={roles.map((r) => ({ key: String(r.id), label: r.name }))}
              selected={(k) => draft.roleIds.includes(Number(k))}
              onToggle={(k) => setDraft({ ...draft, roleIds: toggleIn(draft.roleIds, Number(k)) })}
            />

            <div className="field-label">Users in this group</div>
            <MultiCheckDropdown
              label="Select users"
              options={users.map((u) => ({ key: String(u.id), label: userLabel(u) }))}
              selected={(k) => draft.userIds.includes(Number(k))}
              onToggle={(k) => setDraft({ ...draft, userIds: toggleIn(draft.userIds, Number(k)) })}
            />
            <p className="muted small">{draft.userIds.length} user{draft.userIds.length === 1 ? "" : "s"} selected.</p>

            {err && <div className="login-error">{err}</div>}
            <div className="builder-actions">
              <button className="primary" onClick={save} disabled={busy}>
                {busy ? "Saving…" : draft.id ? "Save group" : "Create group"}
              </button>
              <button onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Tab

/**
 * Admin Panel → Access Control.
 *
 * Two halves of one question, "who can see what":
 *  - Roles grant READ access to specific Views and Dashboards.
 *  - Groups hand a bundle of roles to a set of users at once.
 */
export default function AccessControlTab() {
  const [pane, setPane] = useState<"roles" | "groups">("roles");
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [resources, setResources] = useState<GrantableResources>({ views: [], dashboards: [] });

  const load = () => {
    api.admin.roles.list().then(setRoles).catch(console.error);
    api.admin.roles.permissions().then(setPermissions).catch(console.error);
    api.admin.roles.resources().then(setResources).catch(console.error);
  };
  useEffect(load, []);

  return (
    <div className="admin-tab">
      <div className="subtabs">
        <button className={pane === "roles" ? "active" : ""} onClick={() => setPane("roles")}>Roles</button>
        <button className={pane === "groups" ? "active" : ""} onClick={() => setPane("groups")}>Groups</button>
      </div>

      {pane === "roles"
        ? <RolesPanel roles={roles} permissions={permissions} resources={resources} reload={load} />
        : <GroupsPanel roles={roles} reload={load} />}
    </div>
  );
}
