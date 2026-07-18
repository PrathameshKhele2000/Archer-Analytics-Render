import { useRef, useState } from "react";
import { ImportSummary } from "../api";
import { downloadText, parseCsvObjects } from "../csv";

interface Props<T> {
  title: string;
  hint: string;
  templateName: string;
  templateContent: string;
  columns: string[];
  parse: (rows: Record<string, string>[]) => T[];
  toCells: (row: T) => string[];
  onImport: (rows: T[]) => Promise<ImportSummary>;
  onDone?: () => void;
}

/** Generic CSV import: pick a file → preview parsed rows → import → per-row result. */
export default function ImportPanel<T>(p: Props<T>) {
  const [rows, setRows] = useState<T[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    setError(null); setResult(null);
    try {
      const text = await file.text();
      const parsed = p.parse(parseCsvObjects(text));
      if (!parsed.length) throw new Error("No data rows found. Check the header row and format.");
      setRows(parsed);
      setFileName(file.name);
    } catch (e: any) {
      setRows([]); setFileName("");
      setError(e.message ?? "Could not read file");
    }
  };

  const doImport = async () => {
    setBusy(true); setError(null);
    try {
      const summary = await p.onImport(rows);
      setResult(summary);
      setRows([]); setFileName("");
      if (fileRef.current) fileRef.current.value = "";
      p.onDone?.();
    } catch (e: any) {
      setError(e.message ?? "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-panel">
      <div className="import-head">
        <h3>{p.title}</h3>
        <button className="link-btn" onClick={() => downloadText(p.templateName, p.templateContent)}>
          ⬇ Download CSV template
        </button>
      </div>
      <p className="muted small">{p.hint}</p>

      <div className="import-drop"
           onDragOver={(e) => e.preventDefault()}
           onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}>
        <input ref={fileRef} type="file" accept=".csv,text/csv"
               onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <span className="muted small">or drag a .csv file here</span>
      </div>

      {error && <div className="login-error">{error}</div>}

      {rows.length > 0 && (
        <>
          <div className="import-preview-head">
            <span><b>{fileName}</b> — {rows.length} row{rows.length > 1 ? "s" : ""} ready</span>
            <button className="primary" onClick={doImport} disabled={busy}>
              {busy ? "Importing…" : `Import ${rows.length}`}
            </button>
          </div>
          <div className="import-table-wrap">
            <table className="findings">
              <thead><tr>{p.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 20).map((r, i) => (
                  <tr key={i}>{p.toCells(r).map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {rows.length > 20 && <p className="muted small">…and {rows.length - 20} more</p>}
          </div>
        </>
      )}

      {result && (
        <div className="import-result">
          <div className="result-badges">
            <span className="badge ok">{result.created} created</span>
            <span className="badge upd">{result.updated} updated</span>
            <span className={`badge${result.failed ? " err" : ""}`}>{result.failed} failed</span>
          </div>
          <div className="import-table-wrap">
            <table className="findings">
              <thead><tr><th>#</th><th>Key</th><th>Status</th><th>Details</th><th>Temp password</th></tr></thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.row}>
                    <td className="num">{r.row}</td>
                    <td>{r.key}</td>
                    <td><span className={`tag ${r.status}`}>{r.status}</span></td>
                    <td className="muted small">{r.message ?? ""}</td>
                    <td>{r.tempPassword ? <code>{r.tempPassword}</code> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.results.some((r) => r.tempPassword) && (
            <p className="muted small">
              ⚠ Temp passwords are shown once — copy and share them securely, users should reset on first login.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
