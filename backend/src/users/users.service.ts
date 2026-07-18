import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import * as bcrypt from "bcryptjs";
import { UsersRepository } from "./users.repository";
import { CreateUserDto } from "./dto/create-user.dto";
import { ImportUserDto } from "./dto/import-users.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { toSafeUser, UserRow } from "./user.entity";

export interface ImportRowResult {
  row: number;
  key: string;
  status: "created" | "updated" | "error";
  message?: string;
  tempPassword?: string;
}
export interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  failed: number;
  results: ImportRowResult[];
}

/** URL-safe-ish temporary password for imported users who arrive without one. */
function genTempPassword(): string {
  return randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12) + "1!";
}

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  async list() {
    return (await this.repo.listEnriched()).map(toSafeUser);
  }

  async getById(id: number) {
    const user = await this.mustFind(id);
    return toSafeUser(user);
  }

  async findByEmailForAuth(email: string): Promise<UserRow | null> {
    return this.repo.findByEmail(email);
  }

  async create(dto: CreateUserDto) {
    const existing = await this.repo.findByEmail(dto.email);
    if (existing) throw new ConflictException("Email already registered");
    const hash = await bcrypt.hash(dto.password, 10);
    const created = await this.repo.create(dto.email, hash, dto.fullName);
    if (dto.roleIds?.length) await this.repo.setRoles(created.id, dto.roleIds);
    return toSafeUser(await this.mustFind(created.id));
  }

  async update(id: number, dto: UpdateUserDto) {
    await this.mustFind(id);
    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      const clash = await this.repo.findByEmail(email);
      if (clash && clash.id !== id) throw new ConflictException("Email already registered");
    }
    await this.repo.updateProfile(id, {
      fullName: dto.fullName,
      email: dto.email?.trim().toLowerCase(),
      isActive: dto.isActive,
    });
    if (dto.password) await this.repo.updatePassword(id, await bcrypt.hash(dto.password, 10));
    if (dto.roleIds !== undefined) await this.repo.setRoles(id, dto.roleIds);
    return toSafeUser(await this.mustFind(id));
  }

  /** Delete a user. Guards against deleting yourself or the last active admin (lockout). */
  async remove(id: number, currentUserId: number) {
    const user = await this.mustFind(id);
    if (id === currentUserId) throw new BadRequestException("You cannot delete your own account.");
    if (user.roles.includes("admin") && user.is_active && (await this.repo.countActiveAdmins()) <= 1) {
      throw new BadRequestException("Cannot delete the last active administrator.");
    }
    await this.repo.delete(id);
    return { ok: true };
  }

  /**
   * Bulk import: for each row, update the user if the email exists, else create it.
   * Roles are referenced by name; unknown role names are ignored with a note. New
   * users without a password get a generated temp password (returned in the result).
   */
  async importUsers(rows: ImportUserDto[]): Promise<ImportSummary> {
    const roleByName = await this.repo.roleIdsByName();
    const summary: ImportSummary = { total: rows.length, created: 0, updated: 0, failed: 0, results: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const email = row.email?.trim().toLowerCase();
      try {
        const roleIds: number[] = [];
        const unknown: string[] = [];
        for (const name of row.roles ?? []) {
          const id = roleByName.get(name.trim().toLowerCase());
          if (id) roleIds.push(id);
          else if (name.trim()) unknown.push(name.trim());
        }
        const note = unknown.length ? `unknown roles ignored: ${unknown.join(", ")}` : undefined;
        const existing = await this.repo.findByEmail(email);

        if (existing) {
          await this.repo.updateProfile(existing.id, { fullName: row.fullName });
          if (row.roles !== undefined) await this.repo.setRoles(existing.id, roleIds);
          summary.updated++;
          summary.results.push({ row: i + 1, key: email, status: "updated", message: note });
        } else {
          let tempPassword: string | undefined;
          let password = row.password?.trim();
          if (!password) {
            password = genTempPassword();
            tempPassword = password;
          }
          const hash = await bcrypt.hash(password, 10);
          const created = await this.repo.create(email, hash, row.fullName);
          if (roleIds.length) await this.repo.setRoles(created.id, roleIds);
          summary.created++;
          summary.results.push({ row: i + 1, key: email, status: "created", message: note, tempPassword });
        }
      } catch (e: any) {
        summary.failed++;
        summary.results.push({ row: i + 1, key: email ?? "(no email)", status: "error", message: e?.message ?? "failed" });
      }
    }
    return summary;
  }

  async touchLastLogin(id: number) {
    await this.repo.touchLastLogin(id);
  }

  /** Find an existing user by email, or provision a new SSO user with the default role. */
  async findOrProvisionSsoUser(email: string, fullName: string, defaultRole: string): Promise<UserRow> {
    const existing = await this.repo.findByEmail(email);
    if (existing) return existing;
    return this.repo.createSsoUser(email, fullName, defaultRole);
  }

  private async mustFind(id: number): Promise<UserRow> {
    const user = await this.repo.findByIdEnriched(id);
    if (!user) throw new NotFoundException("User not found");
    return user;
  }
}
