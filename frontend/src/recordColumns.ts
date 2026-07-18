/**
 * Selectable record columns for a Table (records list) chart. Keys/labels mirror the
 * backend RECORD_FIELDS catalog; the backend validates keys, so this stays a display map.
 */
export interface RecCol { key: string; label: string; numeric?: boolean; }

export const RECORD_COLUMNS: RecCol[] = [
  { key: "record_id", label: "Record ID", numeric: true },
  { key: "age", label: "Age" },
  { key: "application_owner", label: "Application Owner" },
  { key: "approved_exception", label: "Approved Exception" },
  { key: "asset_id", label: "Asset ID" },
  { key: "bu_leaders", label: "BU Leaders" },
  { key: "bu_vulnerability_coordinator", label: "BU Vulnerability Coordinator" },
  { key: "business_unit", label: "Business Unit" },
  { key: "client_engagement_manager", label: "Client Engagement Manager" },
  { key: "closed_date", label: "Closed Date" },
  { key: "comments", label: "Comments" },
  { key: "computer_name", label: "Computer Name" },
  { key: "criteria", label: "Criteria" },
  { key: "crowdstrike_device_os", label: "CrowdStrike Device OS" },
  { key: "cve", label: "CVE" },
  { key: "cve_vulnerability_library", label: "CVE - Vulnerability Library" },
  { key: "cve_type", label: "CVE Type" },
  { key: "days_open", label: "Days Open", numeric: true },
  { key: "default_record_permission", label: "Default Record Permission" },
  { key: "details", label: "Details" },
  { key: "detection_id", label: "Detection ID" },
  { key: "device_ip_address", label: "Device IP Address" },
  { key: "device_name", label: "Device Name" },
  { key: "device_status", label: "Device Status" },
  { key: "evidence", label: "Evidence" },
  { key: "exception_request", label: "Exception Request" },
  { key: "false_positive_approved", label: "False Positive - Approved" },
  { key: "false_positive_rejected", label: "False Positive - Rejected" },
  { key: "false_positive_requested", label: "False Positive - Requested" },
  { key: "findings_scan_results", label: "Findings (Scan Results)" },
  { key: "first_found_date", label: "First Found Date" },
  { key: "first_published", label: "First Published" },
  { key: "history_log", label: "History Log" },
  { key: "impacted_device", label: "Impacted Device" },
  { key: "impacted_solution", label: "Impacted Solution" },
  { key: "inquiry_ticket", label: "Inquiry Ticket" },
  { key: "last_updated", label: "Last Updated" },
  { key: "os_engineering_owner", label: "OS Engineering Owner" },
  { key: "os_patching_owner", label: "OS Patching Owner" },
  { key: "priority", label: "Priority" },
  { key: "rationale", label: "Rationale" },
  { key: "reassign_vulnerability", label: "Reassign Vulnerability" },
  { key: "record_status", label: "Record Status" },
  { key: "rejected_exception", label: "Rejected Exception" },
  { key: "remediation_overview", label: "Remediation Overview" },
  { key: "sbp", label: "SBP" },
  { key: "sbu_cid", label: "SBU CID" },
  { key: "sbu_president", label: "SBU President" },
  { key: "sbu_vulnerability_coordinator", label: "SBU Vulnerability Coordinator" },
];

export const DEFAULT_RECORD_COLS = [
  "record_id", "device_name", "cve", "priority", "age", "device_status", "first_found_date", "days_open",
];

/** Resolve a table-chart spec's column selection to concrete columns (validated, or the default set). */
export function resolveRecordCols(selection?: string[] | null): RecCol[] {
  const picked = (selection?.length ? selection : DEFAULT_RECORD_COLS).filter((k) =>
    RECORD_COLUMNS.some((c) => c.key === k),
  );
  const keys = picked.length ? picked : DEFAULT_RECORD_COLS;
  return keys.map((k) => RECORD_COLUMNS.find((c) => c.key === k)!);
}

/** Display a raw record cell value (JSON lists become comma-separated text). */
export function formatCell(value: unknown, _col?: RecCol): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    return value.map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
