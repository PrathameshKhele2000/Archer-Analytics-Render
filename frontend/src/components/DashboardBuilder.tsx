import { useState } from "react";
import { api } from "../api";

/** Create a new (initially empty) dashboard; charts are added inside it via the chart editor. */
export default function DashboardBuilder({
  onSaved,
  onCancel,
}: {
  onSaved: (key: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) return setError("Give the dashboard a name.");
    setSaving(true);
    setError(null);
    try {
      const created = await api.dashboards.create({ name, description });
      onSaved(created.key);
    } catch (e: any) {
      setError(e.message ?? "Failed to create dashboard");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel builder">
      <h2>New dashboard</h2>
      <div className="builder-body">
        <label className="builder-field">
          Name
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)}
                 placeholder="e.g. My risk overview" />
        </label>
        <label className="builder-field">
          Description (optional)
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <div className="login-error">{error}</div>}
        <div className="builder-actions">
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "Creating…" : "Create & add charts"}
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </section>
  );
}
