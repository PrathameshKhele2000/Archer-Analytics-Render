export interface FieldMappingRow {
  id: number;
  source: string;
  archer_field_id: number | null;
  archer_field_name: string;
  archer_field_type: string | null;
  target_column: string | null;
  transform: string;
  is_enabled: boolean;
  updated_at: string;
}

/** How a raw Archer value is converted before it lands in the column. */
export const TRANSFORMS = [
  "direct", // store as-is (text)
  "values_list", // single-select pick-list -> text
  "users_list", // Users/Groups List -> JSON array of emails
  "xref_display", // Cross-Reference -> JSON array of display values
  "xref_ids", // Cross-Reference -> JSON array of Content IDs
  "date", // -> DATE / TIMESTAMP
  "number", // -> numeric
  "json", // keep the raw structure as JSON
] as const;
export type Transform = (typeof TRANSFORMS)[number];

/** Sensible default transform for an Archer field type. */
export function transformForArcherType(type?: string | null): Transform {
  const t = (type ?? "").toLowerCase();
  if (t.includes("users") || t.includes("groups") || t.includes("permission")) return "users_list";
  if (t.includes("cross-reference") || t.includes("related record")) return "xref_display";
  if (t.includes("values list")) return "values_list";
  if (t.includes("date")) return "date";
  if (t.includes("numeric") || t.includes("number")) return "number";
  return "direct";
}

/** "First Found Date" -> "first_found_date" */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = [...cur];
  }
  return prev[n];
}

/** Dice coefficient over "_"-separated tokens — catches extra/missing words. */
function tokenDice(a: string, b: string): number {
  const A = new Set(a.split("_").filter(Boolean));
  const B = new Set(b.split("_").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((t) => { if (B.has(t)) hit++; });
  return (2 * hit) / (A.size + B.size);
}

/**
 * 0..1 closeness of two normalized names. Uses the better of edit-distance
 * (catches typos: "coordinatior" ~ "coordinator") and token overlap
 * (catches extra words: "findings_vulnerability_scan_results" ~ "findings_scan_results").
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(lev, tokenDice(a, b));
}
