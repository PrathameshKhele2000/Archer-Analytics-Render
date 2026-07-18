import { FieldsCatalog, FilterCondition, FilterFieldDef, OperatorDef } from "../api";

const INPUT_TYPE: Record<string, string> = {
  text: "text", number: "number", date: "date", datetime: "datetime-local", time: "time",
};

/** A single field → operator → value(s) condition row, typed to the field. */
export default function ConditionRow({
  cond, catalog, onChange, onRemove,
}: {
  cond: FilterCondition;
  catalog: FieldsCatalog;
  onChange: (next: FilterCondition) => void;
  onRemove: () => void;
}) {
  const fieldsByKey = Object.fromEntries(catalog.fields.map((f) => [f.key, f])) as Record<string, FilterFieldDef>;
  const field = fieldsByKey[cond.field] ?? catalog.fields[0];
  const ops: OperatorDef[] = catalog.operators[field.type] ?? [];
  const arity = ops.find((o) => o.op === cond.operator)?.arity ?? 1;

  const set = (patch: Partial<FilterCondition>) => onChange({ ...cond, ...patch });

  const changeField = (key: string) => {
    const f = fieldsByKey[key];
    const firstOp = (catalog.operators[f.type] ?? [])[0]?.op ?? "eq";
    onChange({ field: key, operator: firstOp, value: "", value2: "", values: [] });
  };
  const changeOp = (op: string) => set({ operator: op, value: "", value2: "", values: [] });

  const value = () => {
    if (arity === 0) return <span className="no-value">—</span>;
    if (field.type === "enum") {
      if (arity === -1) {
        return (
          <select multiple className="multi" value={cond.values ?? []}
                  onChange={(e) => set({ values: Array.from(e.target.selectedOptions, (o) => o.value) })}>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        );
      }
      return (
        <select value={cond.value ?? ""} onChange={(e) => set({ value: e.target.value })}>
          <option value="">— select —</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    const t = INPUT_TYPE[field.type] ?? "text";
    if (arity === 2) {
      return (
        <span className="range">
          <input type={t} value={cond.value ?? ""} onChange={(e) => set({ value: e.target.value })} />
          <span className="and">and</span>
          <input type={t} value={cond.value2 ?? ""} onChange={(e) => set({ value2: e.target.value })} />
        </span>
      );
    }
    return <input type={t} value={cond.value ?? ""} onChange={(e) => set({ value: e.target.value })} />;
  };

  return (
    <div className="fb-row">
      <select value={field.key} onChange={(e) => changeField(e.target.value)}>
        {catalog.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
      <select value={cond.operator} onChange={(e) => changeOp(e.target.value)}>
        {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      <span className="fb-value">{value()}</span>
      <button className="fb-x" onClick={onRemove} title="Remove condition">✕</button>
    </div>
  );
}
