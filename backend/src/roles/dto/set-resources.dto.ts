import { IsArray, IsInt, IsOptional } from "class-validator";

/**
 * Which views and dashboards a role can read. Omitting a list leaves that resource
 * type untouched, so the Access Control tab can save one dropdown at a time; sending
 * an empty array clears it.
 *
 * There is no permission level here on purpose: a grant means READ, and nothing else,
 * until the product needs more.
 */
export class SetResourcesDto {
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  viewIds?: number[];

  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  dashboardIds?: number[];
}
