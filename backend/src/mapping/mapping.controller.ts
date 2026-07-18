import { Body, Controller, Get, Post, Put, Query } from "@nestjs/common";
import { Permissions } from "../common/decorators/permissions.decorator";
import { MappingService } from "./mapping.service";
import { SaveMappingDto } from "./dto/mapping.dto";

const DEFAULT_SOURCE = "archer-findings";

@Controller("api/admin/mapping")
export class MappingController {
  constructor(private readonly mapping: MappingService) {}

  /** Current mapping + the available target columns + suggestions for unmapped fields. */
  @Get()
  @Permissions("admin:mapping:manage")
  list(@Query("source") source?: string) {
    return this.mapping.list(source || DEFAULT_SOURCE);
  }

  /** Map every unmapped Archer field whose name exactly matches a free column. */
  @Post("auto-map")
  @Permissions("admin:mapping:manage")
  autoMap(@Query("source") source?: string) {
    return this.mapping.autoMap(source || DEFAULT_SOURCE);
  }

  @Put()
  @Permissions("admin:mapping:manage")
  save(@Body() dto: SaveMappingDto) {
    return this.mapping.save(dto);
  }
}
