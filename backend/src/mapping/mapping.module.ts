import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { MappingController } from "./mapping.controller";
import { MappingService } from "./mapping.service";

@Module({
  imports: [DatabaseModule],
  controllers: [MappingController],
  providers: [MappingService],
  exports: [MappingService], // the Archer sync reads the mapping from here
})
export class MappingModule {}
