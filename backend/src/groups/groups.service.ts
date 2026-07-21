import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { SaveGroupDto } from "./dto/group.dto";
import { GroupsRepository } from "./groups.repository";

/**
 * User groups. A group holds roles and members; a member's effective roles are their
 * own roles plus every group's roles (resolved in UsersRepository), so putting someone
 * in a group immediately gives them whatever that group's roles can read.
 */
@Injectable()
export class GroupsService {
  constructor(private readonly repo: GroupsRepository) {}

  list() {
    return this.repo.listAll();
  }

  async create(dto: SaveGroupDto) {
    if (await this.repo.findByName(dto.name.trim())) {
      throw new ConflictException("A group with this name already exists");
    }
    const { id } = await this.repo.insert(dto.name.trim(), dto.description?.trim() || null);
    await this.repo.setMembership(id, dto.roleIds ?? [], dto.userIds ?? []);
    return this.mustFind(id);
  }

  async update(id: number, dto: SaveGroupDto) {
    await this.mustFind(id);
    const clash = await this.repo.findByName(dto.name.trim());
    if (clash && clash.id !== id) throw new ConflictException("A group with this name already exists");
    await this.repo.updateDetails(id, dto.name.trim(), dto.description?.trim() || null);
    await this.repo.setMembership(id, dto.roleIds, dto.userIds);
    return this.mustFind(id);
  }

  async remove(id: number) {
    await this.mustFind(id);
    // Members keep their directly-assigned roles; they only lose what the group gave them.
    await this.repo.remove(id);
    return { ok: true };
  }

  private async mustFind(id: number) {
    const group = await this.repo.findByIdFull(id);
    if (!group) throw new NotFoundException("Group not found");
    return group;
  }
}
