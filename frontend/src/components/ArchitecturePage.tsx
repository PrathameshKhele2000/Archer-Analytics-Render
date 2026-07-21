/**
 * Client-facing architecture, ETL & data-flow page. Reachable from the login screen
 * and from the top nav after login. Pure presentational — no data fetching.
 */

const HIGHLIGHTS = [
  { k: "Read-only", v: "never writes back to Archer" },
  { k: "Incremental ETL", v: "only changed rows are synced" },
  { k: "Millions of rows", v: "stays fast at scale" },
  { k: "Sub-second", v: "search, filters & dashboards" },
  { k: "Role-based", v: "admin · analyst · viewer" },
];

const CAPABILITIES = [
  {
    icon: "🔒", title: "Security & access",
    points: [
      ["Read-only source", "the Archer database is never modified."],
      ["Least-privilege login", "a db_datareader account — it physically cannot write."],
      ["Authenticated", "JWT sessions, optional SSO (OIDC)."],
      ["Permission-gated", "every screen and action checks the user's role."],
    ],
  },
  {
    icon: "⚡", title: "Performance",
    points: [
      ["Materialized views", "chart totals are pre-aggregated per chart."],
      ["Trigram indexes", "instant text search across millions of rows."],
      ["Redis cache", "repeated dashboard queries are served from memory."],
      ["Batched sync", "data moves in efficient 1,000-row batches."],
    ],
  },
  {
    icon: "🔁", title: "Sync & reliability",
    points: [
      ["Watermark tracking", "remembers the last row it read, resumes from there."],
      ["Idempotent", "re-running never creates duplicates (upsert on record id)."],
      ["Independent pipes", "one dataset failing can't affect the others."],
      ["Scheduled", "runs on a timer — no manual button to press."],
    ],
  },
  {
    icon: "🗂️", title: "Flexible data model",
    points: [
      ["Any dataset", "point it at a table name — findings, devices, anything."],
      ["Auto-discovery", "it reads the table's columns for you."],
      ["Dynamic catalog", "dashboards & filters adapt to each dataset's fields."],
      ["Multi-value aware", "list fields become proper JSON arrays."],
    ],
  },
  {
    icon: "🧩", title: "Technology",
    points: [
      ["Backend", "NestJS (Node / TypeScript)."],
      ["Database", "PostgreSQL — JSONB, trigram search, materialized views."],
      ["Cache", "Redis."],
      ["Frontend", "React + TypeScript with ECharts."],
    ],
  },
  {
    icon: "🖥️", title: "Deployment",
    points: [
      ["Runs beside Archer", "hosted on the internal DEV / UAT / PROD server."],
      ["Isolated copy", "heavy reporting never slows the live Archer system."],
      ["Config, not code", "credentials live in environment variables."],
      ["Portable", "ships as containers; one-command install."],
    ],
  },
];

export default function ArchitecturePage({ onBack, authed }: { onBack: () => void; authed: boolean }) {
  const back = authed ? "← Back to app" : "← Back to sign in";
  return (
    <div className="arch-shell">
      <div className="arch-topbar">
        <h1>Archer Analytics — System Architecture</h1>
        <button className="arch-back" onClick={onBack}>{back}</button>
      </div>

      <p className="arch-lead">
        A fast reporting layer that <b>copies</b> vulnerability-findings data out of RSA Archer into its
        own optimised database, then serves interactive dashboards, records and exports — <b>without ever
        writing back to, or slowing down, the source Archer system</b>. Data moves through a classic
        <b> ETL pipeline</b> (Extract → Transform → Load).
      </p>

      {/* ---- At a glance ---- */}
      <div className="arch-highlights">
        {HIGHLIGHTS.map((h) => (
          <div className="arch-stat" key={h.k}>
            <div className="arch-stat-k">{h.k}</div>
            <div className="arch-stat-v">{h.v}</div>
          </div>
        ))}
      </div>

      {/* ---- Diagram ---- */}
      <div className="arch-diagram">
        <svg viewBox="0 0 900 680" role="img" aria-label="Architecture diagram" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arw" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L7,3 L0,6 Z" fill="var(--muted)" />
            </marker>
          </defs>

          {/* Zone backdrops */}
          <rect className="zone" x="24" y="70" width="272" height="330" rx="10" />
          <text className="zone-label" x="40" y="94">① INGEST — ETL pipeline (read-only)</text>

          <rect className="zone" x="604" y="70" width="272" height="330" rx="10" />
          <text className="zone-label" x="620" y="94">② SERVE — live user requests</text>

          <rect className="zone" x="220" y="452" width="460" height="176" rx="10" />
          <text className="zone-label" x="240" y="476">③ SHARED STORE</text>

          {/* ---- Left column: ingest pipeline ---- */}
          <g className="node src">
            <rect x="60" y="110" width="200" height="58" rx="7" />
            <text className="n-title" x="160" y="134">RSA Archer</text>
            <text className="n-sub" x="160" y="152">company GRC system</text>
          </g>
          <g className="node">
            <rect x="60" y="222" width="200" height="58" rx="7" />
            <text className="n-title" x="160" y="246">MS SQL flat feed</text>
            <text className="n-sub" x="160" y="264">read-only reporting table</text>
          </g>
          <g className="node plat">
            <rect x="60" y="322" width="200" height="60" rx="7" />
            <text className="n-title" x="160" y="346">Sync Service</text>
            <text className="n-sub" x="160" y="364">NestJS · incremental · JSONB</text>
          </g>

          {/* ETL badges */}
          <g className="etl-badge"><circle cx="286" cy="251" r="13" /><text x="286" y="255">E</text></g>
          <g className="etl-badge"><circle cx="286" cy="352" r="13" /><text x="286" y="356">T</text></g>
          <g className="etl-badge"><circle cx="120" cy="430" r="13" /><text x="120" y="434">L</text></g>

          {/* ---- Right column: serving ---- */}
          <g className="node user">
            <rect x="640" y="110" width="200" height="58" rx="7" />
            <text className="n-title" x="740" y="134">Users</text>
            <text className="n-sub" x="740" y="152">admin · analyst · viewer</text>
          </g>
          <g className="node">
            <rect x="640" y="222" width="200" height="58" rx="7" />
            <text className="n-title" x="740" y="246">React SPA</text>
            <text className="n-sub" x="740" y="264">Dashboards · DataSets · Views · Admin</text>
          </g>
          <g className="node plat">
            <rect x="640" y="322" width="200" height="60" rx="7" />
            <text className="n-title" x="740" y="346">NestJS API</text>
            <text className="n-sub" x="740" y="364">JWT auth · catalog · exports</text>
          </g>

          {/* ---- Shared store ---- */}
          <g className="node store">
            <rect x="250" y="500" width="230" height="84" rx="7" />
            <text className="n-title" x="365" y="530">PostgreSQL</text>
            <text className="n-sub" x="365" y="550">datasets · indexes</text>
            <text className="n-sub" x="365" y="566">materialized views</text>
          </g>
          <g className="node cache">
            <rect x="520" y="512" width="140" height="60" rx="7" />
            <text className="n-title" x="590" y="536">Redis</text>
            <text className="n-sub" x="590" y="554">query cache</text>
          </g>

          {/* ---- Arrows: ingest ---- */}
          <line className="edge" x1="160" y1="168" x2="160" y2="220" markerEnd="url(#arw)" />
          <text className="e-label" x="168" y="198">export</text>
          <line className="edge" x1="160" y1="280" x2="160" y2="320" markerEnd="url(#arw)" />
          <text className="e-label" x="168" y="306">extract (read-only)</text>
          <path className="edge" d="M160,382 L160,430 Q160,500 300,500" fill="none" markerEnd="url(#arw)" />
          <text className="e-label" x="150" y="470">load / upsert</text>

          {/* ---- Arrows: serving ---- */}
          <line className="edge" x1="740" y1="168" x2="740" y2="220" markerEnd="url(#arw)" />
          <text className="e-label" x="748" y="198">browser (HTTPS)</text>
          <line className="edge" x1="740" y1="280" x2="740" y2="320" markerEnd="url(#arw)" />
          <text className="e-label" x="748" y="306">/api (JWT)</text>
          <path className="edge" d="M740,382 L740,430 Q740,500 480,500" fill="none" markerEnd="url(#arw)" />
          <text className="e-label" x="600" y="470">query</text>
          <path className="edge" d="M700,382 Q640,460 610,510" fill="none" markerEnd="url(#arw)" />
          <text className="e-label" x="628" y="452">cache</text>
        </svg>

        {/* Legend */}
        <div className="arch-legend">
          <span><i className="lg src" /> Source (Archer)</span>
          <span><i className="lg plat" /> Platform (NestJS)</span>
          <span><i className="lg store" /> Store (PostgreSQL)</span>
          <span><i className="lg cache" /> Cache (Redis)</span>
          <span><i className="lg user" /> Client (users / app)</span>
          <span><i className="lg etl" /> E·T·L step</span>
        </div>
      </div>

      {/* ---- ETL breakdown ---- */}
      <section className="arch-section">
        <h2>The ETL pipeline, in plain terms</h2>
        <p className="arch-muted">
          ETL just means the three things that happen to the data on its way in. You configure it once by
          giving a <b>table name</b> — the app writes all the queries itself.
        </p>
        <div className="etl-cards">
          <div className="arch-card etl e">
            <div className="etl-tag">E</div>
            <h3>Extract</h3>
            <p>Connect to Archer's read-only MS SQL feed and pull <b>only the rows that changed</b> since
              the last run (tracked by a "last updated" timestamp). No full re-copy every time.</p>
          </div>
          <div className="arch-card etl t">
            <div className="etl-tag">T</div>
            <h3>Transform</h3>
            <p>Clean each row on the way in: multi-value fields (owners, business units, cross-references)
              become proper <b>JSON arrays</b>, and dates &amp; numbers are given the correct types.</p>
          </div>
          <div className="arch-card etl l">
            <div className="etl-tag">L</div>
            <h3>Load</h3>
            <p>Write the rows into PostgreSQL, matched on the Archer <b>record id</b>. Existing rows are
              updated, new ones added — so re-running is safe and <b>never duplicates</b>.</p>
          </div>
        </div>
      </section>

      {/* ---- Data flow steps ---- */}
      <section className="arch-section">
        <h2>End-to-end, step by step</h2>
        <ol className="arch-steps">
          <li><b>Archer exports a flat feed.</b> Findings land in a single, flat MS SQL reporting table — a read-only view. The platform never writes to Archer.</li>
          <li><b>The Sync Service extracts incrementally.</b> A scheduled job reads only rows changed since the last run (a timestamp watermark), so syncing is cheap and never duplicates.</li>
          <li><b>Values are transformed.</b> Multi-value fields become JSON arrays; dates and numbers are typed correctly; fields are mapped to reporting columns.</li>
          <li><b>Everything loads into PostgreSQL.</b> One table per dataset, upserted on the record id. Indexes and per-chart materialized views keep it fast at millions of rows.</li>
          <li><b>The API serves dashboards &amp; records.</b> It builds SQL from a dynamic catalog, checks the user's permissions, aggregates results, and caches hot queries in Redis.</li>
          <li><b>The React app renders it.</b> Users build charts, search and filter records instantly, and export to CSV / Excel / PDF — all over HTTPS.</li>
        </ol>
      </section>

      {/* ---- Capability cards ---- */}
      <section className="arch-section">
        <h2>What powers it</h2>
        <div className="arch-cards">
          {CAPABILITIES.map((c) => (
            <div className="arch-card cap" key={c.title}>
              <div className="cap-head"><span className="cap-icon">{c.icon}</span><h3>{c.title}</h3></div>
              <ul>
                {c.points.map(([b, rest]) => (
                  <li key={b}><b>{b}:</b> {rest}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <div className="arch-footer">
        <button className="arch-back" onClick={onBack}>{back}</button>
      </div>
    </div>
  );
}
