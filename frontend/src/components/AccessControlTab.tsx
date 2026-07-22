import { useEffect, useState } from "react";
import { api, GrantableResources, ImportRoleRow, Role, UserGroup } from "../api";
import { SafeUser } from "../auth";
import { buildCsv, downloadText, splitList } from "../csv";
import CheckList, { CheckOption } from "./CheckList";
import ImportPanel from "./ImportPanel";
import Modal from "./Modal";

const ROLE_TEMPLATE =
  "name,description,permissions\n" +
  "auditor,Read-only auditor,dashboard:read;report:read;audit:read\n" +
  "compliance,Compliance reviewer,dashboard:read;report:read;report:export\n";

// ---------------------------------------------------------------- Roles

interface RoleDraft { id?: number; name: string; description: string; viewIds: number[]; dashboardIds: number[]; }

/** Create / edit a role and its view+dashboard access in one modal, saved together. */
function RoleModal({
  draft, resources, onClose, onSaved,
}: {
  draft: RoleDraft;
  resources: GrantableResources;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [viewIds, setViewIds] = useState<number[]>(draft.viewIds);
  const [dashboardIds, setDashboardIds] = useState<number[]>(draft.dashboardIds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const viewOpts: CheckOption[] = resources.views.map((v) => ({ id: v.id, label: v.name }));
  const dashOpts: CheckOption[] = resources.dashboards.map((d) => ({ id: d.id, label: d.name }));

  const save = async () => {
    if (!name.trim()) return setErr("Give the role a name.");
    setBusy(true); setErr(null);
    try {
      const id = draft.id
        ? (await api.admin.roles.update(draft.id, { name: name.trim(), description: description.trim() })).id
        : (await api.admin.roles.create({ name: name.trim(), description: description.trim() || undefined })).id;
      await api.admin.roles.setResources(id, { viewIds, dashboardIds });
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? "Save failed");
    } finally { setBusy(false); }
  };

  return (
    <Modal title={draft.id ? "Edit role" : "Create role"} onClose={onClose} wide>
      <div className="create-card in-modal">
        <div className="field-row">
          <label className="fld">Name
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Auditor" />
          </label>
          <label className="fld">Description
            <input value={description} onChange={(e) => setDescription(e.target.value)}
                   placeholder="what this role is for" />
          </label>
        </div>

        <p className="muted small">
          Pick the views and dashboards this role can <b>read</b>. That's the only access level roles grant.
        </p>

        <div className="grant-cols">
          <div>
            <div className="field-label">Views <span className="muted">({viewIds.length})</span></div>
            <CheckList options={viewOpts} selected={viewIds} onChange={setViewIds}
                       searchPlaceholder="Search views…" emptyText="No views exist yet." />
          </div>
          <div>
            <div className="field-label">Dashboards <span className="muted">({dashboardIds.length})</span></div>
            <CheckList options={dashOpts} selected={dashboardIds} onChange={setDashboardIds}
                       searchPlaceholder="Search dashboards…" emptyText="No dashboards exist yet." />
          </div>
        </div>

        {err && <div className="login-error">{err}</div>}
        <div className="builder-actions">
          <button className="primary" onClick={save} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : draft.id ? "Save role" : "Create role"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

function RolesPanel({
  roles, resources, reload,
}: {
  roles: Role[]; resources: GrantableResources; reload: () => void;
}) {
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nameOf = (kind: "views" | "dashboards", ids: number[]) =>
    resources[kind].filter((r) => ids.includes(r.id)).map((r) => r.name);

  const openCreate = () => setDraft({ name: "", description: "", viewIds: [], dashboardIds: [] });
  const openEdit = (r: Role) =>
    setDraft({ id: r.id, name: r.name, description: r.description ?? "", viewIds: r.view_ids ?? [], dashboardIds: r.dashboard_ids ?? [] });

  const remove = async (r: Role) => {
    if (!confirm(`Delete role "${r.name}"? Groups holding it simply lose it. This cannot be undone.`)) return;
    try { await api.admin.roles.remove(r.id); reload(); }
    catch (e: any) { setErr(e.message ?? "Failed to delete role"); }
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
          <button className="tb-btn primary" onClick={openCreate}>+ Create role</button>
        </div>
      </div>
      <p className="muted small">
        A role grants <b>read access</b> to the views and dashboards you pick. Roles reach people through
        <b> groups</b> — create a group, give it roles, and add users to it.
      </p>

      {err && <div className="login-error">{err}</div>}

      {roles.map((r) => {
        if (r.is_system) {
          return (
            <div key={r.id} className="role-card system">
              <div className="role-card-head">
                <h3>{r.name} <span className="access-level locked">🔒 Built-in</span></h3>
              </div>
              {r.description && <p className="muted">{r.description}</p>}
              <p className="muted small">
                Full access to every view, dashboard and admin screen. This role is permanent — it cannot be
                edited, deactivated or deleted. Grant it by adding people to a group that holds it.
              </p>
            </div>
          );
        }
        const grants = [
          ...nameOf("views", r.view_ids ?? []).map((n) => ({ kind: "View", n })),
          ...nameOf("dashboards", r.dashboard_ids ?? []).map((n) => ({ kind: "Dashboard", n })),
        ];
        return (
          <div key={r.id} className="role-card">
            <div className="role-card-head">
              <h3>{r.name} <span className="access-level" title="Read access is the only level issued today">Read access</span></h3>
              <div className="panel-actions">
                <button onClick={() => openEdit(r)}>Edit</button>
                <button className="danger" onClick={() => remove(r)}>Delete</button>
              </div>
            </div>
            {r.description && <p className="muted">{r.description}</p>}
            {grants.length > 0 ? (
              <div className="access-chips">
                {grants.map((g) => <span className="access-chip" key={`${g.kind}-${g.n}`}><b>{g.kind}:</b> {g.n}</span>)}
              </div>
            ) : (
              <p className="muted small">No views or dashboards granted yet — click Edit to add some.</p>
            )}
          </div>
        );
      })}

      {draft && (
        <RoleModal draft={draft} resources={resources}
                   onClose={() => setDraft(null)}
                   onSaved={() => { setDraft(null); reload(); }} />
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
    setDraft({ id: g.id, name: g.name, description: g.description ?? "", roleIds: g.role_ids ?? [], userIds: g.user_ids ?? [] });
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

  const roleOpts: CheckOption[] = roles.map((r) => ({ id: r.id, label: r.name, sub: r.description ?? undefined }));
  const userOpts: CheckOption[] = users.map((u) => ({ id: u.id, label: u.full_name || u.email, sub: u.email }));

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
                    <button className="danger" onClick={() => remove(g)}>Delete</button>
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

            <div className="grant-cols">
              <div>
                <div className="field-label">Roles this group grants <span className="muted">({draft.roleIds.length})</span></div>
                <CheckList options={roleOpts} selected={draft.roleIds}
                           onChange={(ids) => setDraft({ ...draft, roleIds: ids })}
                           searchPlaceholder="Search roles…" emptyText="No roles yet — create one first." />
              </div>
              <div>
                <div className="field-label">Users in this group <span className="muted">({draft.userIds.length})</span></div>
                <CheckList options={userOpts} selected={draft.userIds}
                           onChange={(ids) => setDraft({ ...draft, userIds: ids })}
                           searchPlaceholder="Search users…" emptyText="No users yet." />
              </div>
            </div>

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
  const [resources, setResources] = useState<GrantableResources>({ views: [], dashboards: [] });

  const load = () => {
    api.admin.roles.list().then(setRoles).catch(console.error);
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
        ? <RolesPanel roles={roles} resources={resources} reload={load} />
        : <GroupsPanel roles={roles} reload={load} />}
    </div>
  );
}
