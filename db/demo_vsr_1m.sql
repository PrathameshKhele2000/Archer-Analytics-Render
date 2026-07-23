-- =====================================================================================
-- Demo dataset: 1,000,000 Vulnerability Scan Result (VSR) findings.
--
-- Runs entirely inside PostgreSQL — no export/import, no client round-trips, so a
-- million rows land in roughly a minute rather than the hours a row-by-row INSERT
-- would take.
--
--   psql "<your-azure-connection-string>" -f demo_vsr_1m.sql
--
-- The data is generated to be internally CONSISTENT, not merely random, because a demo
-- falls apart the moment someone drills in and sees a Business Unit under the wrong
-- Strategic BU, or a "Closed" finding with no closed date:
--   * Business Unit is always one of its own Strategic BU's children.
--   * Closed / Verified findings have a Closed Date; open ones do not.
--   * Days Open is derived from the dates — it always reconciles.
--   * Age (RAG) is derived from Days Open, so ageing charts tell a true story.
--   * Severity skews the ageing, so Critical findings look attended to and Low ones rot.
--
-- Safe to re-run: it drops and rebuilds the table.
-- =====================================================================================

\timing on

DROP TABLE IF EXISTS vsr_findings;

CREATE TABLE vsr_findings (
    vsr_archer_id            BIGINT PRIMARY KEY,        -- 8-digit Archer record id
    vulnerability_severity   TEXT   NOT NULL,           -- Critical | High | Medium | Low
    vsr_overall_status       TEXT   NOT NULL,           -- Opened | Closed | Ignored | Reopened | Verified
    cve                      TEXT   NOT NULL,           -- CVE-YYYY-NNNNN
    days_open                INTEGER NOT NULL,
    first_found_date         DATE   NOT NULL,
    strategic_business_unit  TEXT   NOT NULL,           -- APAC | Canada | WSE
    business_unit            TEXT   NOT NULL,           -- child of the SBU above
    age                      TEXT   NOT NULL,           -- Green | Yellow | High | Red
    application_owner        TEXT,
    asset_id                 TEXT   NOT NULL,           -- 32-char hex
    closed_date              DATE,                      -- NULL while the finding is open
    computer_name            TEXT   NOT NULL,
    detection_id             TEXT   NOT NULL,           -- 32-char hex
    device_ip_address        TEXT   NOT NULL
);

-- Reproducible: the same seed yields the same million rows on any server.
SELECT setseed(0.42);

INSERT INTO vsr_findings (
    vsr_archer_id, vulnerability_severity, vsr_overall_status, cve, days_open,
    first_found_date, strategic_business_unit, business_unit, age, application_owner,
    asset_id, closed_date, computer_name, detection_id, device_ip_address
)
SELECT
    10000000 + i                                   AS vsr_archer_id,
    severity,
    status,
    cve,
    days_open,
    first_found,
    sbu,
    bu,
    -- RAG ageing band, derived so the Age chart agrees with the Days Open chart.
    CASE WHEN days_open <=  30 THEN 'Green'
         WHEN days_open <=  90 THEN 'Yellow'
         WHEN days_open <= 180 THEN 'High'
         ELSE 'Red' END                            AS age,
    owner,
    asset_id,
    closed_date,
    computer_name,
    detection_id,
    device_ip
FROM (
    SELECT
        i, severity, status, sbu, bu, first_found, owner, asset_id, detection_id,
        device_ip, computer_name, cve,
        -- A closed finding's clock stopped on its closed date; an open one is still running.
        CASE WHEN closed_date IS NOT NULL
             THEN GREATEST(closed_date - first_found, 0)
             ELSE GREATEST(CURRENT_DATE - first_found, 0) END AS days_open,
        closed_date
    FROM (
        SELECT
            i, severity, status, sbu, bu, first_found, owner, asset_id, detection_id,
            device_ip, computer_name, cve,
            -- Only a resolved finding carries a closed date, and never before it was found.
            CASE WHEN status IN ('Closed', 'Verified')
                 THEN first_found + (1 + floor(r_close * lifespan))::int
                 ELSE NULL END AS closed_date
        FROM (
            SELECT
                i, severity, status, sbu, first_found, r_close,
                -- Business Unit must belong to its Strategic BU — the hierarchy is the
                -- first thing a client drills into.
                CASE sbu
                  WHEN 'APAC'   THEN (ARRAY['APD_EVP','APD_Philippines'])[1 + (asset_idx / 7) % 2]
                  WHEN 'Canada' THEN (ARRAY['CAN_Atlantic','CAN_EVP','CAN_GTO'])[1 + (asset_idx / 7) % 3]
                  ELSE               (ARRAY['WSE_EVP','WSE_France','WSE_ICE'])[1 + (asset_idx / 7) % 3]
                END AS bu,
                -- Critical issues get worked quickly, Low ones linger: this is what makes
                -- the ageing and severity charts tell a believable story together.
                CASE severity WHEN 'Critical' THEN 45 WHEN 'High' THEN 120
                              WHEN 'Medium'   THEN 300 ELSE 600 END AS lifespan,
                'owner' || lpad((1 + floor(r_owner * 240))::text, 3, '0')
                    || '@groupinfa.com' AS owner,
                -- Asset identity is derived from the asset, not from the finding, so the
                -- same machine keeps one id, one name and one address across all of its
                -- findings. Drawing these per ROW gave a million single-finding assets,
                -- which makes "most vulnerable assets" a flat wall of 1s.
                md5('asset-' || asset_idx)       AS asset_id,
                upper(left(sbu, 3)) || '-' ||
                    (ARRAY['WKS','SRV','LTP','VDI'])[1 + asset_idx % 4] || '-' ||
                    lpad(asset_idx::text, 5, '0') AS computer_name,
                '100.64.' || ((asset_idx / 254) % 256)::text || '.' ||
                    (1 + asset_idx % 254)::text   AS device_ip,
                -- The detection is per finding, so this one stays unique.
                md5(random()::text)              AS detection_id,
                'CVE-' || (2019 + floor(random() * 8))::text || '-' ||
                    lpad(floor(random() * 60000)::text, 5, '0') AS cve
            FROM (
                SELECT
                    i,
                    -- Weighted so the mix looks like a real estate rather than a flat
                    -- four-way split: mostly Medium/Low, few Critical.
                    CASE WHEN r_sev < 0.08 THEN 'Critical'
                         WHEN r_sev < 0.30 THEN 'High'
                         WHEN r_sev < 0.70 THEN 'Medium'
                         ELSE 'Low' END AS severity,
                    CASE WHEN r_st  < 0.42 THEN 'Opened'
                         WHEN r_st  < 0.72 THEN 'Closed'
                         WHEN r_st  < 0.84 THEN 'Verified'
                         WHEN r_st  < 0.94 THEN 'Reopened'
                         ELSE 'Ignored' END AS status,
                    -- Derived from the ASSET, not the finding: a machine sits in one
                    -- business unit, and all of its findings inherit it.
                    CASE WHEN asset_idx % 100 < 45 THEN 'APAC'
                         WHEN asset_idx % 100 < 75 THEN 'Canada'
                         ELSE 'WSE' END AS sbu,
                    -- Found somewhere in the last three years.
                    CURRENT_DATE - (floor(r_date * 1095))::int AS first_found,
                    asset_idx, r_owner, r_close
                FROM (
                    -- The random draws MUST be in a select list over generate_series.
                    -- Putting them in an uncorrelated LATERAL lets the planner evaluate
                    -- them once and reuse that single draw for every row — which silently
                    -- produces a million identical records.
                    -- 25,000 assets across 1,000,000 findings ~ 40 findings per machine,
                    -- which is the shape a real scanned estate has.
                    SELECT i,
                           random() AS r_sev,  random() AS r_st,
                           random() AS r_date, random() AS r_owner, random() AS r_close,
                           floor(random() * 25000)::int AS asset_idx
                    FROM generate_series(1, 1000000) AS i
                ) rnd
            ) base
        ) withbu
    ) withclose
) final;

-- Indexes for the columns a dashboard groups, filters and drills on.
CREATE INDEX idx_vsr_severity   ON vsr_findings (vulnerability_severity);
CREATE INDEX idx_vsr_status     ON vsr_findings (vsr_overall_status);
CREATE INDEX idx_vsr_sbu        ON vsr_findings (strategic_business_unit);
CREATE INDEX idx_vsr_bu         ON vsr_findings (business_unit);
CREATE INDEX idx_vsr_age        ON vsr_findings (age);
CREATE INDEX idx_vsr_first_found ON vsr_findings (first_found_date);
CREATE INDEX idx_vsr_cve        ON vsr_findings (cve);

ANALYZE vsr_findings;

-- ---- Sanity report: every line below must hold, or the demo will not survive a drill ----
SELECT 'rows' AS check, count(*)::text AS value FROM vsr_findings
UNION ALL SELECT 'distinct archer ids', count(DISTINCT vsr_archer_id)::text FROM vsr_findings
UNION ALL SELECT 'BU under wrong SBU (must be 0)', count(*)::text FROM vsr_findings
   WHERE (strategic_business_unit = 'APAC'   AND business_unit NOT IN ('APD_EVP','APD_Philippines'))
      OR (strategic_business_unit = 'Canada' AND business_unit NOT IN ('CAN_Atlantic','CAN_EVP','CAN_GTO'))
      OR (strategic_business_unit = 'WSE'    AND business_unit NOT IN ('WSE_EVP','WSE_France','WSE_ICE'))
UNION ALL SELECT 'closed w/o date (must be 0)', count(*)::text FROM vsr_findings
   WHERE vsr_overall_status IN ('Closed','Verified') AND closed_date IS NULL
UNION ALL SELECT 'open with date (must be 0)', count(*)::text FROM vsr_findings
   WHERE vsr_overall_status NOT IN ('Closed','Verified') AND closed_date IS NOT NULL
UNION ALL SELECT 'closed before found (must be 0)', count(*)::text FROM vsr_findings
   WHERE closed_date < first_found_date
UNION ALL SELECT 'days_open mismatch (must be 0)', count(*)::text FROM vsr_findings
   WHERE days_open <> COALESCE(closed_date, CURRENT_DATE) - first_found_date
UNION ALL SELECT 'age band mismatch (must be 0)', count(*)::text FROM vsr_findings
   WHERE age <> CASE WHEN days_open <= 30 THEN 'Green' WHEN days_open <= 90 THEN 'Yellow'
                     WHEN days_open <= 180 THEN 'High' ELSE 'Red' END
UNION ALL SELECT 'bad CVE format (must be 0)', count(*)::text FROM vsr_findings
   WHERE cve !~ '^CVE-[0-9]{4}-[0-9]{5}$'
UNION ALL SELECT 'bad asset id (must be 0)', count(*)::text FROM vsr_findings
   WHERE asset_id !~ '^[0-9a-f]{32}$'
UNION ALL SELECT 'bad ip (must be 0)', count(*)::text FROM vsr_findings
   WHERE device_ip_address !~ '^100\.64\.[0-9]{1,3}\.[0-9]{1,3}$'
UNION ALL SELECT 'archer id not 8 digits (must be 0)', count(*)::text FROM vsr_findings
   WHERE vsr_archer_id < 10000000 OR vsr_archer_id > 99999999;
