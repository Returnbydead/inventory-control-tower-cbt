const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(
  path.join(__dirname, "../public/preview/putaway-reporting-redesign.html"),
  "utf8",
);

test("renders overdue SLA with a minus sign instead of plus", () => {
  assert.match(html, /Missed · − \$\{fmtClock\(seconds\)\}/);
  assert.doesNotMatch(html, /Missed · \+\$\{fmtClock\(seconds\)\}/);
  assert.doesNotMatch(html, /seconds < 0 \? "\+"/);
});

test("shows the six requested Putaway monitoring totals", () => {
  for (const label of [
    "DONE GR qty",
    "Pending",
    "In progress",
    "Completed",
    "Total SKU",
    "Total PO",
  ]) {
    assert.ok(html.includes(`["${label}"`), `${label} KPI is missing`);
  }
});

test("labels Putaway PENDING fallback as DONE GRN", () => {
  assert.match(html, /doneGrSource === "PUTAWAY_PENDING"/);
  assert.match(html, /DONE GRN · dari task PENDING/);
});

test("opens as a self-contained read-only preview with clearly labelled demo data", () => {
  assert.match(html, /const previewMode = .*get\("live"\) !== "1"/);
  assert.match(html, /function buildPreviewPayload\(\)/);
  assert.match(html, /Demo data · preview only/);
  assert.match(html, /DEMO QUEUE \/ CBT/);
});
