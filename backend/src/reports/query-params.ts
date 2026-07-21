import { BadRequestException } from "@nestjs/common";
import { FilterCondition } from "./filterable-fields";

/** Parse the `filters` query param (URL-encoded JSON array of numbered conditions). */
export function parseConditions(filtersJson?: string): FilterCondition[] {
  if (!filtersJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(filtersJson);
  } catch {
    throw new BadRequestException("Invalid 'filters' JSON");
  }
  if (!Array.isArray(parsed)) throw new BadRequestException("'filters' must be a JSON array of conditions");
  return parsed as FilterCondition[];
}

/** Parse the per-column search param (`cols`) — a JSON object of {columnKey: term}. */
export function parseColFilters(colsJson?: string): Record<string, string> {
  if (!colsJson) return {};
  try {
    const parsed = JSON.parse(colsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new BadRequestException("Invalid 'cols' JSON");
  }
}
