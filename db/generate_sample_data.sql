-- =====================================================================
--  Generate realistic sample Findings data — ANY size, ANY Postgres
--  (local, Azure, or anywhere the app's schema already exists).
--
--  USAGE — pick the row count with -v rows=N :
--    psql "<connection string>" -v rows=1000000 -f db/generate_sample_data.sql
--
--  Sizing guide (table + indexes):
--      100,000 rows  ~   0.25 GB   (fine on any tier)
--    1,000,000 rows  ~   2.1  GB   <- recommended for a hosted/Azure test
--   10,000,000 rows  ~  21    GB   (needs real CPU/RAM — not a Burstable tier)
--
--  Replaces the current contents of fact_findings. Idempotent: re-run any time.
-- =====================================================================
\if :{?rows}
\else
  \set rows 1000000
\endif
SELECT set_config('app.gen_rows', :'rows', false);
\echo Generating :rows rows into fact_findings ...

TRUNCATE fact_findings;
DROP INDEX IF EXISTS ix_ff_business_unit_gin;
DROP INDEX IF EXISTS ix_ff_app_owner_gin;
DROP INDEX IF EXISTS ix_ff_cve_lib_gin;
DROP INDEX IF EXISTS ix_ff_impacted_dev_gin;
DROP INDEX IF EXISTS ix_ff_device_name_trgm;
DROP INDEX IF EXISTS ix_ff_computer_trgm;
DROP INDEX IF EXISTS ix_ff_cve_trgm;
DROP INDEX IF EXISTS ix_ff_asset_trgm;
DROP INDEX IF EXISTS ix_ff_detection_trgm;
DROP INDEX IF EXISTS ix_ff_device_ip_trgm;
DROP INDEX IF EXISTS ix_ff_details_trgm;
DROP INDEX IF EXISTS ix_ff_comments_trgm;

-- 2) Helpers -----------------------------------------------------------

-- A JSONB array of 1..mx random distinct values from `pool` (with optional suffix,
-- e.g. an email domain). This is what makes "multi-value comma-separated" fields.
CREATE OR REPLACE FUNCTION _rand_arr(pool text[], mn int, mx int, suffix text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE n int; i int; acc text[] := '{}'; v text; len int := array_length(pool,1);
BEGIN
  n := mn + floor(random()*(mx-mn+1))::int;
  FOR i IN 1..n LOOP
    v := pool[1+floor(random()*len)::int] || suffix;
    IF NOT (v = ANY(acc)) THEN acc := acc || v; END IF;
  END LOOP;
  RETURN to_jsonb(acc);
END $$;

-- A JSONB array of mn..mx generated ids like 'INC-004213' (cross-reference lists).
CREATE OR REPLACE FUNCTION _rand_ids(prefix text, width int, mn int, mx int)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE n int := mn + floor(random()*(mx-mn+1))::int; i int; acc text[] := '{}';
BEGIN
  FOR i IN 1..n LOOP
    acc := acc || (prefix || lpad(floor(random()*power(10,width))::bigint::text, width, '0'));
  END LOOP;
  RETURN to_jsonb(acc);
END $$;

-- Build one complete finding row.
CREATE OR REPLACE FUNCTION _gen_finding(rid bigint) RETURNS fact_findings
LANGUAGE plpgsql AS $$
DECLARE
  f fact_findings;
  ages     text[] := ARRAY['Red','High','Yellow','Green'];
  prios    text[] := ARRAY['1','1','2','2','2','3','3','3','4','4','5','6','7','Client Restricted','Data Missing'];
  cvetypes text[] := ARRAY['Application','OS Engineering','OS Patching','Tier 1A - OS Patching','Tier 1B - OS Patching (App Impact)'];
  devstat  text[] := ARRAY['Active','Active','Active','Installed','Removed','Purchased','groupinfa.com','Ignored','Archived','Awaiting Inventory','Retired'];
  recstat  text[] := ARRAY['Open','Open','In Remediation','Risk Accepted','Closed','Closed','False Positive'];
  oses     text[] := ARRAY['Windows Server 2019','Windows Server 2022','Windows 10','Windows 11','Ubuntu 20.04','Ubuntu 22.04','RHEL 8','RHEL 9','CentOS 7','macOS 13'];
  bus      text[] := ARRAY['Retail Banking','Payments','Treasury','Wealth Management','Corporate Banking','Insurance','Cards','Digital Channels','Infrastructure','Compliance'];
  people   text[] := ARRAY['alex.morgan','priya.shah','chen.wei','sara.khan','john.doe','maria.garcia','tom.evans','li.na','raj.patel','emma.brown','omar.ali','kate.lee','david.kim','nina.roy','sam.olsen','ivy.zhang'];
  hostpfx  text[] := ARRAY['SRV','WKS','DB','APP','WEB','VDI'];
  dom      text := '@groupinfa.com';
  a text; d int; ff date; rs text; dn text; cvestr text;
BEGIN
  a  := ages[1+floor(random()*4)::int];
  d  := CASE a
          WHEN 'Green'  THEN floor(random()*30)::int
          WHEN 'Yellow' THEN 30 + floor(random()*150)::int
          WHEN 'High'   THEN 90 + floor(random()*90)::int
          ELSE               180 + floor(random()*550)::int
        END;
  ff := current_date - d;
  rs := recstat[1+floor(random()*array_length(recstat,1))::int];
  dn := hostpfx[1+floor(random()*array_length(hostpfx,1))::int] || '-' || lpad((floor(random()*90000)+10000)::text,5,'0');
  cvestr := 'CVE-' || (2018+floor(random()*7))::text || '-' || lpad((floor(random()*24000)+100)::text,4,'0');

  f.record_id                     := rid;
  f.age                           := a;
  f.application_owner             := _rand_arr(people,1,2,dom);
  f.approved_exception            := CASE WHEN random()<0.08 THEN 'Yes' END;
  f.asset_id                      := 'AST-' || lpad((floor(random()*900000)+100000)::text,6,'0');
  f.bu_leaders                    := _rand_arr(people,1,2,dom);
  f.bu_vulnerability_coordinator  := _rand_arr(people,1,1,dom);
  f.business_unit                 := _rand_arr(bus,1,2,'');
  f.client_engagement_manager     := _rand_arr(people,1,1,dom);
  f.closed_date                   := CASE WHEN rs IN ('Closed','False Positive') THEN current_date - floor(random()*20)::int END;
  f.comments                      := CASE WHEN random()<0.35 THEN 'Reviewed by ' || people[1+floor(random()*16)::int] || '.' END;
  f.computer_name                 := dn;
  f.criteria                      := 'Baseline ' || (ARRAY['CIS','NIST','PCI-DSS','Internal'])[1+floor(random()*4)::int];
  f.crowdstrike_device_os         := oses[1+floor(random()*array_length(oses,1))::int];
  f.cve                           := cvestr;
  f.cve_vulnerability_library     := _rand_ids('CVE-2024-',4,0,2);
  f.cve_type                      := cvetypes[1+floor(random()*array_length(cvetypes,1))::int];
  f.days_open                     := d;
  f.default_record_permission     := _rand_arr(people,1,3,dom);
  f.details                       := 'Vulnerability ' || cvestr || ' detected on ' || dn || '.';
  f.detection_id                  := 'DET-' || lpad(floor(random()*power(10,8))::bigint::text,8,'0');
  f.device_ip_address             := (floor(random()*223)+1)::text||'.'||floor(random()*256)::text||'.'||floor(random()*256)::text||'.'||(floor(random()*254)+1)::text;
  f.device_name                   := dn;
  f.device_status                 := devstat[1+floor(random()*array_length(devstat,1))::int];
  f.evidence                      := CASE WHEN random()<0.3 THEN 'scan-' || lpad(floor(random()*power(10,7))::bigint::text,7,'0') END;
  f.exception_request             := _rand_ids('EXC-',4,0,1);
  f.false_positive_approved       := CASE WHEN random()<0.05 THEN 'Yes' END;
  f.false_positive_rejected       := CASE WHEN random()<0.05 THEN 'Yes' END;
  f.false_positive_requested      := CASE WHEN random()<0.08 THEN 'Yes' END;
  f.findings_scan_results         := 'Port ' || (floor(random()*65535))::text || ' — ' || cvestr;
  f.first_found_date              := ff;
  f.first_published               := ff - floor(random()*45)::int;
  f.history_log                   := CASE WHEN random()<0.2 THEN 'Status set to ' || rs END;
  f.impacted_device               := _rand_ids('SRV-',5,0,2);
  f.impacted_solution             := _rand_ids('SOL-',4,0,2);
  f.inquiry_ticket                := _rand_ids('INC-',6,0,1);
  f.last_updated                  := now() - make_interval(days => floor(random()*90)::int, hours => floor(random()*24)::int, mins => floor(random()*60)::int);
  f.os_engineering_owner          := _rand_arr(people,1,2,dom);
  f.os_patching_owner             := _rand_arr(people,1,2,dom);
  f.priority                      := prios[1+floor(random()*array_length(prios,1))::int];
  f.rationale                     := CASE WHEN random()<0.15 THEN 'Compensating control in place.' END;
  f.reassign_vulnerability        := CASE WHEN random()<0.15 THEN 'Yes' END;
  f.record_status                 := rs;
  f.rejected_exception            := CASE WHEN random()<0.05 THEN 'Yes' END;
  f.remediation_overview          := 'Apply vendor patch for ' || cvestr || '.';
  f.sbp                           := _rand_arr(people,1,1,dom);
  f.sbu_cid                       := 'CID' || lpad((floor(random()*9000)+1000)::text,4,'0');
  f.sbu_president                 := _rand_arr(people,1,1,dom);
  f.sbu_vulnerability_coordinator := _rand_arr(people,1,2,dom);
  f.synced_at                     := now();
  RETURN f;
END $$;

-- 3) Load the requested number of rows, 100k per batch.
DO $$
DECLARE base bigint; b int; total bigint; batches int;
BEGIN
  SELECT coalesce(max(record_id),0) INTO base FROM fact_findings;
  total := current_setting('app.gen_rows')::bigint;
  batches := greatest(1, (total + 99999) / 100000);   -- 100k per batch
  FOR b IN 0..(batches-1) LOOP
    INSERT INTO fact_findings
    SELECT r.*
    FROM generate_series(base + b*100000 + 1, base + least((b+1)*100000, total)) AS g,
         LATERAL _gen_finding(g) AS r;
    RAISE NOTICE 'batch %/% — % rows', b+1, batches, least((b+1)*100000, total);
  END LOOP;
END $$;

-- 4) Rebuild the heavy indexes now that the data is in.
CREATE INDEX ix_ff_business_unit_gin ON fact_findings USING GIN (business_unit);
CREATE INDEX ix_ff_app_owner_gin     ON fact_findings USING GIN (application_owner);
CREATE INDEX ix_ff_cve_lib_gin       ON fact_findings USING GIN (cve_vulnerability_library);
CREATE INDEX ix_ff_impacted_dev_gin  ON fact_findings USING GIN (impacted_device);
CREATE INDEX ix_ff_device_name_trgm  ON fact_findings USING GIN (device_name gin_trgm_ops);
CREATE INDEX ix_ff_computer_trgm     ON fact_findings USING GIN (computer_name gin_trgm_ops);
CREATE INDEX ix_ff_cve_trgm          ON fact_findings USING GIN (cve gin_trgm_ops);
CREATE INDEX ix_ff_asset_trgm        ON fact_findings USING GIN (asset_id gin_trgm_ops);
CREATE INDEX ix_ff_detection_trgm    ON fact_findings USING GIN (detection_id gin_trgm_ops);
CREATE INDEX ix_ff_device_ip_trgm    ON fact_findings USING GIN (device_ip_address gin_trgm_ops);
CREATE INDEX ix_ff_details_trgm      ON fact_findings USING GIN (details gin_trgm_ops);
CREATE INDEX ix_ff_comments_trgm     ON fact_findings USING GIN (comments gin_trgm_ops);

-- 5) Fresh planner stats + tidy up the generator functions.
ANALYZE fact_findings;

-- ---------------------------------------------------------------------
-- Chart materialized views are PRE-AGGREGATED copies of this table. The app reads
-- them without a staleness check, so after replacing the data they MUST be refreshed
-- or every dashboard keeps showing the OLD numbers (or nothing at all).
-- ---------------------------------------------------------------------
DO $refresh$
DECLARE mv record;
BEGIN
  FOR mv IN SELECT schemaname, matviewname FROM pg_matviews LOOP
    BEGIN
      EXECUTE format('REFRESH MATERIALIZED VIEW %I.%I', mv.schemaname, mv.matviewname);
      RAISE NOTICE 'refreshed %', mv.matviewname;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'could not refresh % (%)', mv.matviewname, SQLERRM;
    END;
  END LOOP;
END $refresh$;
DROP FUNCTION _gen_finding(bigint);
DROP FUNCTION _rand_arr(text[], int, int, text);
DROP FUNCTION _rand_ids(text, int, int, int);

SELECT count(*) AS total_findings FROM fact_findings;
