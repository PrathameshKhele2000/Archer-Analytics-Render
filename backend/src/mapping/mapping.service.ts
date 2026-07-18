import { BadRequestException, Injectable } from "@nestjs/common";
import { DbService } from "../database/db.service";
import {
  FieldMappingRow,
  normalizeName,
  similarity,
  transformForArcherType,
  TRANSFORMS,
} from "./mapping.entity";
import { SaveMappingDto } from "./dto/mapping.dto";

const SUGGEST_THRESHOLD = 0.6;
/** Columns the mapping must never target (set by the sync, not by Archer). */
const RESERVED_COLUMNS = new Set(["synced_at"]);

export interface TargetColumn {
  column: string;
  dataType: string;
}

@Injectable()
export class MappingService {
  constructor(private readonly db: DbService) {}

  /** The fact_findings columns an Archer field can be mapped onto. */
  async targetColumns(): Promise<TargetColumn[]> {
    const { rows } = await this.db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'fact_findings' ORDER BY ordinal_position`,
    );
    return rows
      .filter((r) => !RESERVED_COLUMNS.has(r.column_name))
      .map((r) => ({ column: r.column_name, dataType: r.data_type }));
  }

  private async rowsFor(source: string): Promise<FieldMappingRow[]> {
    const { rows } = await this.db.query<FieldMappingRow>(
      `SELECT * FROM field_mapping WHERE source = $1 ORDER BY archer_field_name`,
      [source],
    );
    return rows;
  }

  /**
   * The mapping table plus, for each still-unmapped field, the closest free
   * column as a suggestion (so typo'd Archer names are one click to fix).
   */
  async list(source: string) {
    const [rows, targets] = await Promise.all([this.rowsFor(source), this.targetColumns()]);
    const taken = new Set(rows.map((r) => r.target_column).filter(Boolean) as string[]);

    const withSuggestions = rows.map((r) => {
      if (r.target_column) return { ...r, suggestion: null };
      const norm = normalizeName(r.archer_field_name);
      let best: { column: string; score: number } | null = null;
      for (const t of targets) {
        if (taken.has(t.column)) continue;
        const score = similarity(norm, t.column);
        if (!best || score > best.score) best = { column: t.column, score: Number(score.toFixed(3)) };
      }
      return { ...r, suggestion: best && best.score >= SUGGEST_THRESHOLD ? best : null };
    });

    return {
      source,
      targets,
      rows: withSuggestions,
      mapped: rows.filter((r) => r.target_column).length,
      unmapped: rows.filter((r) => !r.target_column).length,
    };
  }

  /**
   * Map every unmapped field whose normalized Archer name exactly equals a free
   * column, and set a transform from its Archer type. Near-misses are left for
   * the admin (they appear as suggestions) — we never guess silently.
   */
  async autoMap(source: string) {
    const [rows, targets] = await Promise.all([this.rowsFor(source), this.targetColumns()]);
    const free = new Set(targets.map((t) => t.column));
    for (const r of rows) if (r.target_column) free.delete(r.target_column);

    let applied = 0;
    for (const r of rows) {
      if (r.target_column) continue;
      const norm = normalizeName(r.archer_field_name);
      if (!free.has(norm)) continue;
      await this.db.query(
        `UPDATE field_mapping SET target_column=$1, transform=$2, updated_at=now() WHERE id=$3`,
        [norm, transformForArcherType(r.archer_field_type), r.id],
      );
      free.delete(norm);
      applied++;
    }
    const after = await this.list(source);
    return { applied, mapped: after.mapped, unmapped: after.unmapped };
  }

  /** Save admin edits. Validates columns/transforms and rejects duplicate targets. */
  async save(dto: SaveMappingDto) {
    const targets = new Set((await this.targetColumns()).map((t) => t.column));
    const seen = new Map<string, string>();

    for (const r of dto.rows) {
      if (r.target_column) {
        if (!targets.has(r.target_column)) {
          throw new BadRequestException(`Unknown target column '${r.target_column}'`);
        }
        if (seen.has(r.target_column)) {
          throw new BadRequestException(
            `Column '${r.target_column}' is mapped twice (each column can take only one Archer field)`,
          );
        }
        seen.set(r.target_column, r.target_column);
      }
      if (r.transform && !TRANSFORMS.includes(r.transform as any)) {
        throw new BadRequestException(`Unknown transform '${r.transform}'`);
      }
    }

    for (const r of dto.rows) {
      await this.db.query(
        `UPDATE field_mapping
         SET target_column=$1, transform=COALESCE($2, transform), is_enabled=COALESCE($3, is_enabled), updated_at=now()
         WHERE id=$4`,
        [r.target_column ?? null, r.transform ?? null, r.is_enabled ?? null, r.id],
      );
    }
    return this.list(dto.source ?? "archer-findings");
  }
}
