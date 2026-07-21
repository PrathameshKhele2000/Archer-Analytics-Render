import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { RolesRepository } from "./roles.repository";
import { CreateRoleDto } from "./dto/create-role.dto";
import { ImportRoleDto } from "./dto/import-roles.dto";
import { ImportSummary } from "../users/users.service";

/** The one built-in role: every permission, and not editable or removable. */
export const SYSTEM_ADMIN_ROLE = "System Admin";

/**
 * What a newly created role can do. Permission codes gate which SCREENS a role can
 * open; the views/dashboards it may actually see are chosen per role in Access
 * Control. Without this baseline a new role would be granted views it then couldn't
 * open, which reads as "access control is broken".
 */
const NEW_ROLE_PERMISSIONS = ["dashboard:read", "report:read", "report:export"];

@Injectable()
export class RolesService {
  constructor(private readonly repo: RolesRepository) {}

  /** System roles are fixed: their permissions and grants are not editable. */
  private assertEditable(role: { is_system: boolean; name: string }) {
    if (role.is_system) {
      throw new BadRequestException(`'${role.name}' is a built-in role and cannot be changed.`);
    }
  }

  list() {
    return this.repo.listWithPermissions();
  }

  listPermissions() {
    return this.repo.listPermissions();
  }

  /** The views and dashboards a role can be granted read access to. */
  listGrantableResources() {
    return this.repo.listGrantableResources();
  }

  /** Replace the views/dashboards this role can read (read access only). */
  async setResources(roleId: number, viewIds?: number[], dashboardIds?: number[]) {
    // System Admin already reaches everything; narrowing it would be a lockout.
    this.assertEditable(await this.mustFind(roleId));
    await this.repo.setResourceGrants(roleId, viewIds, dashboardIds);
    return this.mustFind(roleId);
  }

  async create(dto: CreateRoleDto) {
    const existing = await this.repo.findAll();
    if (existing.some((r) => r.name === dto.name)) {
      throw new ConflictException("A role with this name already exists");
    }
    if (dto.name.trim().toLowerCase() === SYSTEM_ADMIN_ROLE.toLowerCase()) {
      throw new ConflictException(`'${SYSTEM_ADMIN_ROLE}' is reserved.`);
    }
    const role = await this.repo.create(dto.name, dto.description);
    // Permissions are no longer picked by hand when creating a role — every new role
    // starts read-only, and what it can read is chosen in Access Control. An explicit
    // permissionIds (used by CSV import) still wins.
    const permissionIds = dto.permissionIds?.length
      ? dto.permissionIds
      : await this.repo.permissionIdsForCodes(NEW_ROLE_PERMISSIONS);
    await this.repo.setPermissions(role.id, permissionIds);
    return this.mustFind(role.id);
  }

  async setPermissions(roleId: number, permissionIds: number[]) {
    this.assertEditable(await this.mustFind(roleId));
    await this.repo.setPermissions(roleId, permissionIds);
    return this.mustFind(roleId);
  }

  /** Delete a custom role. The built-in System Admin role cannot be deleted. */
  async remove(id: number) {
    const role = await this.repo.findById(id);
    if (!role) throw new NotFoundException("Role not found");
    if (role.is_system) throw new BadRequestException(`'${role.name}' is a built-in role and cannot be deleted.`);
    await this.repo.delete(id); // user_roles rows cascade — affected users simply lose this role
    return { ok: true };
  }

  /**
   * Bulk import: upsert each role by name. Permissions are referenced by code;
   * unknown codes are ignored with a note. System roles are updated in place.
   */
  async importRoles(rows: ImportRoleDto[]): Promise<ImportSummary> {
    const permByCode = await this.repo.permissionIdsByCode();
    const summary: ImportSummary = { total: rows.length, created: 0, updated: 0, failed: 0, results: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = row.name?.trim();
      try {
        const permIds: number[] = [];
        const unknown: string[] = [];
        for (const code of row.permissions ?? []) {
          const id = permByCode.get(code.trim().toLowerCase());
          if (id) permIds.push(id);
          else if (code.trim()) unknown.push(code.trim());
        }
        const note = unknown.length ? `unknown permissions ignored: ${unknown.join(", ")}` : undefined;
        const existing = await this.repo.findByName(name);

        if (existing) {
          if (row.description !== undefined) await this.repo.updateDescription(existing.id, row.description);
          if (row.permissions !== undefined) await this.repo.setPermissions(existing.id, permIds);
          summary.updated++;
          summary.results.push({ row: i + 1, key: name, status: "updated", message: note });
        } else {
          const role = await this.repo.create(name, row.description);
          if (permIds.length) await this.repo.setPermissions(role.id, permIds);
          summary.created++;
          summary.results.push({ row: i + 1, key: name, status: "created", message: note });
        }
      } catch (e: any) {
        summary.failed++;
        summary.results.push({ row: i + 1, key: name ?? "(no name)", status: "error", message: e?.message ?? "failed" });
      }
    }
    return summary;
  }

  private async mustFind(id: number) {
    const role = await this.repo.findByIdWithPermissions(id);
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }
}
