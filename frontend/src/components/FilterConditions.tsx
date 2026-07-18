import { FieldsCatalog, FilterCondition } from "../api";
import ConditionRow from "./ConditionRow";

/**
 * Numbered condition list + a manual logic expression (Archer-style). Each condition
 * gets a number (1, 2, 3…); when there's more than one, a logic box lets the user
 * combine them by number — e.g. "1 AND 2 OR 3" or "(1 OR 2) AND NOT 3". Blank = AND all.
 */
export default function FilterConditions({
  conditions, logic, catalog, onChange,
}: {
  conditions: FilterCondition[];
  logic: string;
  catalog: FieldsCatalog;
  onChange: (conditions: FilterCondition[], logic: string) => void;
}) {
  const setCond = (i: number, next: FilterCondition) =>
    onChange(conditions.map((c, idx) => (idx === i ? next : c)), logic);
  const removeCond = (i: number) =>
    onChange(conditions.filter((_, idx) => idx !== i), logic);
  const addCond = () => {
    const f = catalog.fields[0];
    const op = (catalog.operators[f.type] ?? [])[0]?.op ?? "eq";
    onChange([...conditions, { field: f.key, operator: op, value: "" }], logic);
  };

  return (
    <div className="cond-list">
      {conditions.map((c, i) => (
        <div className="cond-numbered" key={i}>
          <span className="cond-no">{i + 1}</span>
          <ConditionRow cond={c} catalog={catalog} onChange={(n) => setCond(i, n)} onRemove={() => removeCond(i)} />
        </div>
      ))}

      <button className="fb-add" onClick={addCond}>+ Add condition</button>

      {conditions.length > 1 && (
        <div className="logic-box">
          <label className="logic-field">
            Condition logic
            <input value={logic} onChange={(e) => onChange(conditions, e.target.value)}
                   placeholder="e.g. 1 AND (2 OR 3) AND NOT 4" />
          </label>
          <span className="muted small">
            Combine conditions by number using <b>AND</b>, <b>OR</b>, <b>NOT</b> and parentheses.
            Leave blank to match all ({conditions.map((_, i) => i + 1).join(" AND ")}).
          </span>
        </div>
      )}
    </div>
  );
}
