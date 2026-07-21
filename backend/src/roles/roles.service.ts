import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { RolesRepository } from "./roles.repository";
import { CreateRoleDto } from "./dto/create-role.dto";
import { ImportRoleDto } from "./dto/import-roles.dto";
import { ImportSummary } from "../users/users.service";

@Injectable()
export class RolesService {
  constructor(private readonly repo: RolesRepository) {}

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
    await this.mustFind(roleId);
    await this.repo.setResourceGrants(roleId, viewIds, dashboardIds);
    return this.mustFind(roleId);
  }

  async create(dto: CreateRoleDto) {
    const existing = await this.repo.findAll();
    if (existing.some((r) => r.name === dto.name)) {
      throw new ConflictException("A role with this name already exists");
    }
    const role = await this.repo.create(dto.name, dto.description);
    if (dto.permissionIds?.length) await this.repo.setPermissions(role.id, dto.permissionIds);
    return this.mustFind(role.id);
  }

  async setPermissions(roleId: number, permissionIds: number[]) {
    await this.mustFind(roleId);
    await this.repo.setPermissions(roleId, permissionIds);
    return this.mustFind(roleId);
  }

  /** Delete a custom role. The three built-in (system) roles cannot be deleted. */
  async remove(id: number) {
    const role = await this.repo.findById(id);
    if (!role) throw new NotFoundException("Role not found");
    if (role.is_system) throw new BadRequestException("Built-in roles cannot be deleted.");
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
