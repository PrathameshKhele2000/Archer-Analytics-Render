import { Global, Module } from "@nestjs/common";
import { DbService } from "./db.service";
import { SchemaBootstrapService } from "./schema-bootstrap.service";

@Global()
@Module({
  providers: [DbService, SchemaBootstrapService],
  exports: [DbService],
})
export class DatabaseModule {}
