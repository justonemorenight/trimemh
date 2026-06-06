export function renderViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>triMemh Viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f5;
      --ink: #1f2420;
      --muted: #66706a;
      --line: #d9ded5;
      --panel: #ffffff;
      --green: #1f7a58;
      --blue: #3266a8;
      --red: #b54848;
      --gold: #9a6a18;
      --shadow: 0 10px 30px rgba(31, 36, 32, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
    }
    aside {
      border-right: 1px solid var(--line);
      background: #fbfcf8;
      padding: 20px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow: auto;
    }
    main {
      padding: 22px;
      display: grid;
      gap: 18px;
      align-content: start;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 22px; line-height: 1.15; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 14px; margin-bottom: 6px; }
    .muted { color: var(--muted); }
    .stack { display: grid; gap: 12px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 16px;
    }
    .sidebar-panel {
      border-top: 1px solid var(--line);
      padding: 16px 0;
    }
    .sidebar-panel:first-of-type { border-top: 0; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fff;
    }
    .metric b {
      display: block;
      font-size: 22px;
      line-height: 1;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) 132px 92px;
      gap: 8px;
      align-items: center;
    }
    .impactbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(120px, 220px) 92px;
      gap: 8px;
      align-items: center;
    }
    input, select, button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 8px;
      font: inherit;
      background: #fff;
      color: var(--ink);
    }
    input, select { padding: 0 10px; min-width: 0; }
    button {
      cursor: pointer;
      background: #21352c;
      color: #fff;
      border-color: #21352c;
      font-weight: 650;
    }
    button.secondary {
      background: #fff;
      color: var(--ink);
      border-color: var(--line);
    }
    .tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tab {
      height: 34px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
    }
    .tab.active {
      background: #1f7a58;
      border-color: #1f7a58;
      color: #fff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fff;
      min-width: 0;
    }
    .item p {
      margin-top: 8px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: #edf4f0;
      color: var(--green);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .badge.blue { background: #edf3fb; color: var(--blue); }
    .badge.gold { background: #fff6df; color: var(--gold); }
    .badge.red { background: #fff0ee; color: var(--red); }
    .explain {
      margin-top: 10px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .factorbar {
      display: grid;
      gap: 5px;
      margin-top: 8px;
    }
    .factor {
      display: grid;
      grid-template-columns: 96px 1fr 42px;
      gap: 8px;
      align-items: center;
      font-size: 12px;
    }
    .track {
      height: 6px;
      border-radius: 999px;
      background: #eef0ec;
      overflow: hidden;
    }
    .fill {
      height: 100%;
      width: var(--w);
      background: var(--blue);
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 20px;
      color: var(--muted);
      text-align: center;
      background: rgba(255, 255, 255, 0.55);
    }
    @media (max-width: 800px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; height: auto; }
      .toolbar, .impactbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="stack">
        <div>
          <h1>triMemh Viewer</h1>
          <p class="muted" id="project">Loading project...</p>
        </div>
        <div class="sidebar-panel">
          <h2>Memory Stats</h2>
          <div class="metrics" id="metrics"></div>
        </div>
        <div class="sidebar-panel">
          <h2>Pending Proposals</h2>
          <div class="stack" id="proposals"></div>
        </div>
      </div>
    </aside>
    <main>
      <section class="panel stack">
        <div class="tabs">
          <button class="tab active" data-view="search">Search</button>
          <button class="tab" data-view="memories">Memories</button>
          <button class="tab" data-view="impact">Code Impact</button>
        </div>
        <div id="view-search" class="stack">
          <div class="toolbar">
            <input id="searchQuery" placeholder="Search memories">
            <select id="searchMode">
              <option value="hybrid">Hybrid</option>
              <option value="fts">FTS</option>
              <option value="vector">Vector</option>
            </select>
            <button id="searchBtn">Search</button>
          </div>
          <div id="searchResults" class="grid"></div>
        </div>
        <div id="view-memories" class="stack" hidden>
          <div class="toolbar">
            <input id="memoryFilter" placeholder="Filter visible memories">
            <select id="kindFilter"><option value="">All kinds</option></select>
            <button class="secondary" id="refreshBtn">Refresh</button>
          </div>
          <div id="memoryList" class="grid"></div>
        </div>
        <div id="view-impact" class="stack" hidden>
          <div class="impactbar">
            <input id="impactPath" placeholder="src/service.ts">
            <input id="impactSymbol" placeholder="Optional symbol">
            <button id="impactBtn">Trace</button>
          </div>
          <div id="impactResults" class="stack"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const state = { memories: [], status: null };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    async function api(path, options) {
      const res = await fetch(path, options);
      const body = await res.json();
      if (!body.success) throw new Error(body.error || "Request failed");
      return body;
    }
    function badge(kind) {
      const cls = kind === "security_rule" || kind === "trade_rule" ? "red" : kind === "decision" || kind === "procedure" ? "gold" : kind === "code_context" ? "blue" : "";
      return '<span class="badge ' + cls + '">' + esc(kind) + '</span>';
    }
    function factors(explanation) {
      if (!explanation) return "";
      const rows = Object.entries(explanation.factors).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
      return '<div class="factorbar">' + rows.map(([k, v]) => '<div class="factor"><span>' + esc(k) + '</span><span class="track"><span class="fill" style="--w:' + Math.round(v * 100) + '%"></span></span><span>' + Number(v).toFixed(2) + '</span></div>').join("") + '</div>';
    }
    function memoryItem(entry) {
      const item = entry.item || entry;
      const exp = entry.explanation || item.explanation;
      const score = exp ? '<span class="badge blue">score ' + esc(exp.composite_score) + '</span>' : "";
      return '<article class="item"><div class="row"><div>' + badge(item.kind) + '</div>' + score + '</div><p>' + esc(item.text) + '</p><div class="explain">' + esc(item.source || "") + ' · ' + esc((item.created_at || "").slice(0, 10)) + (exp ? '<br>' + esc(exp.why_selected.join(" ")) + factors(exp) : "") + '</div></article>';
    }
    function renderMetrics() {
      const stats = state.status?.stats || state.status || {};
      $("metrics").innerHTML = [
        ["Total", stats.total ?? 0],
        ["Pending", stats.pendingProposals ?? 0],
        ["Kinds", Object.keys(stats.byKind || {}).length],
        ["Active", (stats.byStatus || {}).active ?? 0],
      ].map(([label, value]) => '<div class="metric"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>').join("");
    }
    function renderMemories() {
      const text = $("memoryFilter").value.toLowerCase();
      const kind = $("kindFilter").value;
      const filtered = state.memories.filter((m) => (!kind || m.kind === kind) && (!text || m.text.toLowerCase().includes(text)));
      $("memoryList").innerHTML = filtered.length ? filtered.map(memoryItem).join("") : '<div class="empty">No memories match this filter.</div>';
    }
    async function loadBase() {
      const status = await api("/api/status");
      state.status = status.data;
      $("project").textContent = status.project_id;
      renderMetrics();
      const memories = await api("/api/memories");
      state.memories = memories.data;
      const kinds = [...new Set(state.memories.map((m) => m.kind))].sort();
      $("kindFilter").innerHTML = '<option value="">All kinds</option>' + kinds.map((k) => '<option value="' + esc(k) + '">' + esc(k) + '</option>').join("");
      renderMemories();
      const proposals = await api("/api/proposals?status=pending");
      $("proposals").innerHTML = proposals.data.length ? proposals.data.slice(0, 5).map((p) => '<div class="item"><div class="row">' + badge(p.proposed_kind) + '<span class="badge gold">' + esc(p.risk_level) + '</span></div><p>' + esc(p.proposed_text) + '</p></div>').join("") : '<div class="empty">No pending proposals.</div>';
    }
    async function search() {
      const query = $("searchQuery").value.trim();
      if (!query) return;
      $("searchResults").innerHTML = '<div class="empty">Searching...</div>';
      const body = await api("/api/memories/recall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, mode: $("searchMode").value, limit: 12 }) });
      $("searchResults").innerHTML = body.data.length ? body.data.map(memoryItem).join("") : '<div class="empty">No matching memories.</div>';
    }
    async function impact() {
      const path = $("impactPath").value.trim();
      const symbol = $("impactSymbol").value.trim();
      if (!path) return;
      $("impactResults").innerHTML = '<div class="empty">Tracing impact...</div>';
      const qs = new URLSearchParams({ path, depth: "2" });
      if (symbol) qs.set("symbol", symbol);
      const body = await api("/api/code/impact?" + qs.toString());
      const data = body.data;
      const linked = data.linked_memories.length ? '<div class="grid">' + data.linked_memories.map(memoryItem).join("") + '</div>' : '<div class="empty">No linked memories.</div>';
      const paths = data.affected_paths.length ? '<div class="grid">' + data.affected_paths.map((p) => '<div class="item"><h3>' + esc(p.entity.path) + (p.entity.symbol ? "#" + esc(p.entity.symbol) : "") + '</h3><p class="muted">via ' + esc(p.relation) + ' memory ' + esc(p.memory_id.slice(0, 8)) + '</p></div>').join("") + '</div>' : '<div class="empty">No affected paths.</div>';
      $("impactResults").innerHTML = '<div class="metrics"><div class="metric"><b>' + data.summary.entity_count + '</b><span>Entities</span></div><div class="metric"><b>' + data.summary.linked_memory_count + '</b><span>Linked memories</span></div><div class="metric"><b>' + data.summary.related_memory_count + '</b><span>Related memories</span></div><div class="metric"><b>' + data.summary.affected_path_count + '</b><span>Affected paths</span></div></div><section><h2>Linked Memories</h2>' + linked + '</section><section><h2>Affected Paths</h2>' + paths + '</section>';
    }
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      ["search", "memories", "impact"].forEach((name) => $("view-" + name).hidden = tab.dataset.view !== name);
    }));
    $("searchBtn").addEventListener("click", search);
    $("searchQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
    $("impactBtn").addEventListener("click", impact);
    $("refreshBtn").addEventListener("click", loadBase);
    $("memoryFilter").addEventListener("input", renderMemories);
    $("kindFilter").addEventListener("change", renderMemories);
    loadBase().catch((err) => {
      $("metrics").innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    });
  </script>
</body>
</html>`;
}
