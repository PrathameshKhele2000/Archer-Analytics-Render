import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { GroupsController } from "./groups.controller";
import { GroupsRepository } from "./groups.repository";
import { GroupsService } from "./groups.service";

@Module({
  imports: [DatabaseModule],
  controllers: [GroupsController],
  providers: [GroupsService, GroupsRepository],
})
export class GroupsModule {}
