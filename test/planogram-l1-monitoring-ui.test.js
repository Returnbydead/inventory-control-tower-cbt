const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(
  path.join(__dirname, "../public/preview/planogram-l1-monitoring-prototype.html"),
  "utf8",
);

test("planogram uses the same operational navigation routes as Putaway", () => {
  for (const href of [
    "/putaway",
    "/sra1-spatial-prototype.html",
    "/preview/planogram-l1-monitoring-prototype.html?zone=SRC1",
  ]) assert.ok(html.includes(`href="${href}"`), `${href} is missing`);
  assert.match(html, /id="navToggle"/);
});

test("planogram report keeps the all-zone compliance table from the approved reference", () => {
  assert.match(html, /Accuracy Planogram Warehouse · CBT/);
  for (const label of ["Zone", "Status", "% SLOC", "Quantity", "% Quantity", "SESUAI", "TIDAK SESUAI"]) {
    assert.ok(html.includes(label), `${label} is missing`);
  }
  assert.match(html, /Sesuai · SLOC/);
  assert.match(html, /Tidak Sesuai · Quantity/);
});

test("planogram report splits the one CBT report into two compact columns", () => {
  for (const marker of [
    "planogram-sheet-grid",
    "planogram-sheet-table",
    "zoneAccuracyBodyRight",
    "zoneAccuracyTotal",
    "zoneAccuracyRightPanel",
    "single-column",
    'value="ALL">Semua zona',
    "Sloc",
    "% Sloc",
    "QTY",
    "% QTY",
  ]) assert.ok(html.includes(marker), `${marker} is missing`);
  assert.ok(!html.includes("SKU DCC/MINI STO"), "retired DCC/Mini STO report is still present");
});

test("planogram supports checkbox selection for multiple zones", () => {
  for (const marker of [
    "zonePickerSummary",
    "zoneOptions",
    "selectAllZones",
    "clearZones",
    "selectedZoneValues",
    "searchParams.set('zones'",
  ]) assert.ok(html.includes(marker), `${marker} is missing`);
  assert.match(html, /#planogram-filter \{[^}]*overflow: visible/);
  assert.match(html, /reportZones = selected\.includes\('ALL'\) \? Object\.keys\(summaries\) : selected/);
  assert.ok(!html.includes("border-block-start-width: var(--space-md)"), "zone spacer still breaks the table grid");
  assert.match(html, /splitAt = allZoneSummaries\.length > 8/);
});

test("planogram renders all-zone operational details without the retired priority panel", () => {
  for (const marker of [
    'id="aisle-accuracy"',
    "L1 Detail per SKU &amp; Lokasi",
    "planogramDetailUrl",
    "Saran Placement",
    "Dasar Saran",
    'id="downloadDetail"',
    "planogram-sku-location",
    "1 SKU × occupied location",
    "generatePlanogramTasks",
    "selectAllPlanogramTasks",
    "PLANOGRAM TASK",
    "task_keys: taskKeys",
  ]) assert.ok(html.includes(marker), `${marker} is missing`);
  assert.ok(!html.includes('id="priority-rack"'), "retired priority rack panel is still present");
  assert.ok(!html.includes("compatibleRackIndex"), "retired rack-only suggestion engine is still present");
});

test("planogram distinguishes the product category from the current rack target", () => {
  assert.ok(html.includes("Current L1 Produk"), "product L1 header is ambiguous");
  assert.ok(html.includes("Kategori Target Rak Saat Ini"), "current rack target header is ambiguous");
});

test("planogram exposes qty-balanced PIC auto assignment", () => {
  for (const marker of [
    'id="autoAssignPlanogramPic"',
    'id="assignmentSummary"',
    'id="assignmentWorkloads"',
    "/api/planogram-assignment",
    "loadPlanogramAssignmentPreview",
    "autoAssignPlanogramPics",
    "Beban dibagi berdasarkan total qty",
  ]) assert.ok(html.includes(marker), `${marker} is missing`);
  assert.match(html, /confirm\(`Assign .*total qty.*PIC/);
});

test("planogram keeps read-only data visible but locks generation while live rules are stale", () => {
  assert.match(html, /data\.planogram_stale \? `\$\{snapshotLabel\}.*rule cache`/);
  assert.match(html, /!generationAvailable \|\| selectedCount === 0/);
  assert.match(html, /Aturan GSheet live sedang terganggu/);
  assert.match(html, /Ledger task GSheet sedang lambat/);
  assert.match(html, /rule dan ledger diverifikasi ulang saat Generate/);
  assert.match(html, /VERIFY_ON_GENERATE/);
  assert.match(html, /document\.querySelectorAll\('\.dashboard > \.error'\)/);
});
