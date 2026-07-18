-- =====================================================================
--  Sample data for fact_findings — 5,000 synthetic vulnerability findings.
--  Safe to run against the archer_findings_schema.sql tables. Re-running adds
--  another 5,000 (record_ids are offset by the current max), so run once.
-- =====================================================================
INSERT INTO fact_findings (
    record_id, age, priority, device_status, cve_type, record_status,
    business_unit, application_owner, bu_leaders, os_patching_owner,
    days_open, first_found_date, first_published, closed_date, last_updated,
    device_name, computer_name, cve, asset_id, detection_id, device_ip_address,
    crowdstrike_device_os, reassign_vulnerability, details
)
SELECT
    (COALESCE((SELECT max(record_id) FROM fact_findings), 3000000)) + g AS record_id,
    (ARRAY['Red','High','Yellow','Green'])[(1 + floor(random()*4))::int],
    (ARRAY['1','2','3','4','5','6','7','Client Restricted','Data Missing'])[(1 + floor(random()*9))::int],
    (ARRAY['Active','Installed','Removed','Purchased','Ignored','Archived','Awaiting Inventory','Retired'])[(1 + floor(random()*8))::int],
    (ARRAY['Application','OS Engineering','OS Patching','Tier 1A - OS Patching','Tier 1B - OS Patching (App Impact)'])[(1 + floor(random()*5))::int],
    (ARRAY['Active','Closed','In Review','Exception Requested'])[(1 + floor(random()*4))::int],
    to_jsonb(ARRAY[(ARRAY['Retail Banking','Corporate IT','Payments','Treasury','Operations','Wealth Management'])[(1 + floor(random()*6))::int]]),
    to_jsonb(ARRAY['owner' || (1 + floor(random()*40))::int || '@corp.com']),
    to_jsonb(ARRAY['lead' || (1 + floor(random()*12))::int || '@corp.com']),
    to_jsonb(ARRAY['ospatch' || (1 + floor(random()*15))::int || '@corp.com']),
    floor(random()*400)::int,
    (CURRENT_DATE - (floor(random()*540))::int),
    (CURRENT_DATE - (floor(random()*560))::int),
    CASE WHEN random() < 0.4 THEN (CURRENT_DATE - (floor(random()*90))::int) ELSE NULL END,
    now() - ((floor(random()*72))::int || ' hours')::interval,
    'HOST-' || lpad(g::text, 5, '0'),
    'PC-' || lpad((floor(random()*9999))::int::text, 4, '0'),
    'CVE-' || (2020 + floor(random()*5))::int || '-' || lpad((1 + floor(random()*9999))::int::text, 4, '0'),
    'ASSET-' || lpad(g::text, 6, '0'),
    'DET-' || lpad(g::text, 7, '0'),
    (1 + floor(random()*254))::int || '.' || floor(random()*255)::int || '.' || floor(random()*255)::int || '.' || (1 + floor(random()*254))::int,
    (ARRAY['Windows Server 2019','Windows Server 2022','Windows 10','RHEL 8','Ubuntu 22.04','CentOS 7'])[(1 + floor(random()*6))::int],
    CASE WHEN random() < 0.1 THEN 'Yes' ELSE NULL END,
    'Vulnerability finding auto-generated for demonstration.'
FROM generate_series(1, 5000) g;
