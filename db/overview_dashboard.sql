-- =====================================================================
--  Shared "Vulnerability Findings Overview" dashboard (the landing page).
--  Created EMPTY and admin-owned so an admin can build it with the "+ Add
--  chart" option (charts you add on a dataset with no data yet simply show
--  zero until the sync loads data). Shared read-only with every role.
--  Idempotent.
-- =====================================================================
INSERT INTO dashboards (key, name, description, owner_user_id, is_active, sort_order)
SELECT 'vuln-overview', 'Vulnerability Findings Overview',
       'Program-wide view of Archer vulnerability findings',
       (SELECT id FROM users WHERE email = 'admin@example.com'), TRUE, 0
ON CONFLICT (key) DO UPDATE SET sort_order = 0, is_active = TRUE;

INSERT INTO dashboard_access (dashboard_id, role_id, user_id)
SELECT d.id, r.id, NULL FROM dashboards d CROSS JOIN roles r
WHERE d.key = 'vuln-overview'
  AND NOT EXISTS (SELECT 1 FROM dashboard_access a WHERE a.dashboard_id = d.id AND a.role_id = r.id);

-- No pre-seeded charts: the admin adds their own via "+ Add chart".
