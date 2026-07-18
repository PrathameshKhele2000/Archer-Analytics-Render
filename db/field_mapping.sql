-- =====================================================================
--  Archer -> reporting field mapping
--
--  Archer field IDs differ per environment (DEV / UAT / PROD), and field
--  names drift over time. Keeping the mapping in a TABLE (not in code)
--  means the same build runs against every environment — an admin just
--  re-maps in the UI instead of a redeploy.
--
--  Idempotent: safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS field_mapping (
    id                SERIAL PRIMARY KEY,
    source            TEXT NOT NULL DEFAULT 'archer-findings', -- which feed
    archer_field_id   INTEGER,          -- Archer's numeric field id (per environment)
    archer_field_name TEXT NOT NULL,    -- exactly as Archer reports it
    archer_field_type TEXT,             -- Text / Values List / Cross-Reference / ...
    target_column     TEXT,             -- our fact_findings column (NULL = ignore this field)
    transform         TEXT NOT NULL DEFAULT 'direct',
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, archer_field_name)
);

CREATE INDEX IF NOT EXISTS ix_field_mapping_source ON field_mapping (source);

-- Permission for the Admin Panel -> Field Mapping tab
INSERT INTO permissions (code, description)
VALUES ('admin:mapping:manage', 'View and edit Archer field mapping')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'admin' AND p.code = 'admin:mapping:manage'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Seed the Archer field list for the findings feed (names exactly as they
-- appear in Archer). Once the live Archer connection is configured, the
-- sync refreshes this list automatically; target_column is left NULL so
-- "Auto-map" (or the admin) decides where each field lands.
-- ---------------------------------------------------------------------
INSERT INTO field_mapping (source, archer_field_name, archer_field_type) VALUES
    ('archer-findings', 'Age',                              'Values List'),
    ('archer-findings', 'Application Owner',                'Users/Groups List'),
    ('archer-findings', 'Approved Exception',               'Text'),
    ('archer-findings', 'Asset ID',                         'Text'),
    ('archer-findings', 'BU Leaders',                       'Users/Groups List'),
    ('archer-findings', 'BU Vulnerability Coordinatior',    'Users/Groups List'),
    ('archer-findings', 'Business Unit',                    'Values List'),
    ('archer-findings', 'Client Enagagement Manager(CEM)',  'Users/Groups List'),
    ('archer-findings', 'Closed Date',                      'Date'),
    ('archer-findings', 'Comments',                         'Text'),
    ('archer-findings', 'Computer Name',                    'Text'),
    ('archer-findings', 'Criteria',                         'Text'),
    ('archer-findings', 'CrowdStrike Device OS',            'Text'),
    ('archer-findings', 'CVE',                              'Text'),
    ('archer-findings', 'CVE - Vulnerability Library',      'Cross-Reference'),
    ('archer-findings', 'CVE Type',                         'Values List'),
    ('archer-findings', 'Days Open',                        'Numeric'),
    ('archer-findings', 'Default Record Permission',        'Record Permissions'),
    ('archer-findings', 'Details',                          'Text'),
    ('archer-findings', 'Detection ID',                     'Text'),
    ('archer-findings', 'Device IP Address',                'Text'),
    ('archer-findings', 'Device Name',                      'Text'),
    ('archer-findings', 'Device Status',                    'Values List'),
    ('archer-findings', 'Evidence',                         'Text'),
    ('archer-findings', 'Exception Request',                'Cross-Reference'),
    ('archer-findings', 'False Positive - Approved',        'Text'),
    ('archer-findings', 'False Positive - Rejected',        'Text'),
    ('archer-findings', 'False Positive - Requested',       'Text'),
    ('archer-findings', 'Findings(Vulnerability Scan Results)', 'Text'),
    ('archer-findings', 'First Found Date',                 'Date'),
    ('archer-findings', 'First Published',                  'Date'),
    ('archer-findings', 'History Log',                      'History Log'),
    ('archer-findings', 'Impacted Device',                  'Cross-Reference'),
    ('archer-findings', 'Impacted Solution',                'Cross-Reference'),
    ('archer-findings', 'Inquiry Ticket',                   'Cross-Reference'),
    ('archer-findings', 'Last Updated',                     'Date'),
    ('archer-findings', 'OS Engineering Owner',             'Users/Groups List'),
    ('archer-findings', 'OS Patching Owner',                'Users/Groups List'),
    ('archer-findings', 'Priority',                         'Values List'),
    ('archer-findings', 'Rationale',                        'Text'),
    ('archer-findings', 'Reassign Vulnerability',           'Values List'),
    ('archer-findings', 'Record Status',                    'Text'),
    ('archer-findings', 'Rejected Exception',               'Text'),
    ('archer-findings', 'Remediation Overview',             'Text'),
    ('archer-findings', 'SBP',                              'Users/Groups List'),
    ('archer-findings', 'SBU CID',                          'Text'),
    ('archer-findings', 'SBU President',                    'Users/Groups List'),
    ('archer-findings', 'SBU Vulnerability Coordinator',    'Users/Groups List')
ON CONFLICT (source, archer_field_name) DO UPDATE
    SET archer_field_type = EXCLUDED.archer_field_type;
