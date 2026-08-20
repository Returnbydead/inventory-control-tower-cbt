const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(
  path.join(__dirname, "../public/preview/putaway-superset-ledger.html"),
  "utf8",
);

test("keeps the dashboard focused on Putaway", () => {
  assert.match(html, /Putaway Operational Ledger/);
  assert.match(html, /SLA 1 jam sejak IN PROGRESS/);
  assert.doesNotMatch(html, /Inbound Forecast &amp; Actual/);
  assert.doesNotMatch(html, /Inbound PO-Today/);
});

test("uses one fixed Superset ledger layout without the large masthead or layout editor", () => {
  assert.doesNotMatch(html, /<header class="masthead">/);
  assert.doesNotMatch(html, /READ-ONLY PROTOTYPE/);
  assert.doesNotMatch(html, /id="layoutMode"/);
  assert.doesNotMatch(html, /id="resetLayout"/);
  assert.doesNotMatch(html, /prototype-switcher/);
  assert.doesNotMatch(html, /const variants =/);
  assert.doesNotMatch(html, /localStorage\.setItem/);
  assert.doesNotMatch(html, /width-toggle/);
  assert.doesNotMatch(html, /drag-handle/);
});

test("preserves the Superset Putaway reporting sections", () => {
  for (const label of [
    "Putaway Progress",
    "Putaway Completed",
    "Putaway In Progress",
    "Putaway Progress by vendor_name",
    "Putaway SLA by Asset ID &amp; Task Number",
    "Putaway SLA Detail (Not Completed)",
  ]) {
    assert.ok(html.includes(label), `${label} is missing`);
  }
});

test("stacks the operational reporting tables at full reading width", () => {
  assert.match(html, /class="split-row queue-vendor-stack"/);
  assert.match(html, /class="split-row manpower-stack"/);
  assert.match(html, /\.queue-vendor-stack,\s*\.manpower-stack\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(html, /\.queue-vendor-stack \.queue-section \{\s*order: -1;/);
});

test("covers the operational reporting areas without the retired exception board", () => {
  for (const label of [
    "Task, Quantity, SKU, PO &amp; Asset",
    "Output &amp; SLA",
    "Selisih Qty Inbound vs Task",
    "Manpower Workload",
    "Filter Operasional",
  ]) {
    assert.ok(html.includes(label), `${label} is missing`);
  }
  assert.doesNotMatch(html, /Exception Board/);
  assert.doesNotMatch(html, /Destination Rack &amp; Zone/);
});

test("uses explicit quantity-reconciliation labels instead of ambiguous variance wording", () => {
  assert.match(html, /Qty inbound actual dikurangi total qty seluruh Putaway task/);
  assert.match(html, /Selisih \(Inbound − Task\)/);
  assert.doesNotMatch(html, />Variance</);
});

test("keeps retired summary sections hidden so the SLA queue has more TV space", () => {
  assert.match(html, /class="vertical-stack"/);
  assert.match(html, /id="slaBar"/);
  assert.match(html, /id="completedTaskCount"/);
  assert.match(html, /SLA tercapai/);
  assert.match(html, /class="section sla-section" hidden aria-hidden="true"/);
  assert.doesNotMatch(html, /id="slaDonut"/);
  assert.match(html, /class="section reconciliation-section" hidden/);
  assert.doesNotMatch(html, /id="exceptionGrid"/);
});

test("maps server-side aggregates into the live dashboard", () => {
  assert.match(html, /function applyLiveLedger\(payload\)/);
  assert.match(html, /payload\.status_breakdown/);
  assert.match(html, /payload\.sla_breakdown/);
  assert.match(html, /payload\.vendor_breakdown/);
  assert.match(html, /payload\.manpower_breakdown/);
  assert.match(html, /payload\.reconciliation/);
  assert.doesNotMatch(html, /payload\.exceptions/);
});

test("uses server-backed filters and separates used time from SLA deficit", () => {
  for (const id of ["filterStatus", "filterSla", "filterVendor", "filterStaff", "filterZone", "filterSearch"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /const params = new URLSearchParams\(\)/);
  assert.match(html, /fetch\(`\/api\/putaway-dashboard\?\$\{params\}`/);
  assert.match(html, /<th>Used Lead Time<\/th><th>Minus SLA<\/th>/);
  assert.match(html, /formatDuration\(row\.elapsed_minutes\)/);
  assert.match(html, /formatDuration\(row\.remaining_minutes\)/);
  assert.match(html, /remaining_minutes/);
});

test("expands the raw SLA table for TV viewing and restores it with Escape", () => {
  assert.match(html, /id="queueExpand"/);
  assert.match(html, /aria-controls="queueTableShell"/);
  assert.match(html, /\.queue-section\.is-expanded/);
  assert.match(html, /\.queue-section\.is-expanded \.table-shell\.tall \{[\s\S]*?max-height: none;/);
  assert.match(html, /function setQueueExpanded\(active\)/);
  assert.match(html, /event\.key === "Escape"/);
  assert.match(html, /setQueueExpanded\(false\)/);
});

test("refreshes live data for TV use and has an explicit demo fallback", () => {
  assert.match(html, /get\("live"\) === "1"/);
  assert.match(html, /location\.hostname\.endsWith\("\.vercel\.app"\)/);
  assert.match(html, /if \(!document\.hidden\) loadLedgerData\(\)/);
  assert.match(html, /30_000/);
  assert.match(html, /Demo fallback · live unavailable/);
});

test("restores navigation when fullscreen TV mode exits outside the TV button", () => {
  assert.match(html, /function setTvMode\(active\)/);
  assert.match(html, /document\.addEventListener\("fullscreenchange", \(\) => \{/);
  assert.match(html, /setTvMode\(Boolean\(document\.fullscreenElement\)\)/);
  assert.match(html, /await document\.documentElement\.requestFullscreen\(\)/);
  assert.match(html, /await document\.exitFullscreen\(\)/);
});

test("uses real routes for cross-dashboard sidebar navigation", () => {
  assert.match(html, /href="\/preview\/planogram-l1-monitoring-prototype\.html\?zone=SRC1"/);
  assert.match(html, /href="\/sra1-spatial-prototype\.html"/);
  assert.doesNotMatch(html, /<a class="side-link" href="#"><span class="side-icon">[SAL]<\/span>/);
});
