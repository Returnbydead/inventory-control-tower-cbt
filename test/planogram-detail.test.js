const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPlanogramDetailRows,
  filterPlanogramDetailRows,
} = require("../lib/planogram-detail");
const { limitValue, selectedZones, sortRows } = require("../api/planogram-detail")._test;

function row(overrides = {}) {
  return {
    sku_number: "899000000099",
    product_name: "Minuman Uji",
    rack_name: "CBT-SRA1-09-01-L1-01",
    zone: "SRA1",
    aisle: "09",
    rack_sequence: "01",
    rack_level: "L1",
    l1_category_name: "Minuman",
    l2_category_name: "Air Mineral",
    stock: 10,
    stock_value: 1000,
    source_rows: 1,
    ...overrides,
  };
}

test("planogram detail keeps one row per SKU and occupied location", () => {
  const rows = buildPlanogramDetailRows([
    row({ stock: 10 }),
    row({ stock: 5, stock_value: 500 }),
    row({ rack_name: "CBT-SRA1-02-01-L1-01", aisle: "02", stock: 20 }),
  ]);
  assert.equal(rows.length, 2);
  const wrong = rows.find((item) => item.rack_name.includes("-09-"));
  assert.equal(wrong.stock, 15);
  assert.equal(wrong.status, "WRONG_L1");
});

test("wrong Minuman SKU receives suggestions only from the GSheet range", () => {
  const rows = buildPlanogramDetailRows([
    row(),
    row({ rack_name: "CBT-SRA1-02-01-L1-01", aisle: "02", stock: 40 }),
    row({ sku_number: "899000000100", rack_name: "CBT-SRA1-04-01-L1-01", aisle: "04", stock: 200 }),
  ]);
  const wrong = rows.find((item) => item.status === "WRONG_L1");
  assert.ok(wrong);
  const labels = wrong.suggestions.map((item) => item.label);
  assert.ok(labels.includes("SRA1 · aisle 02"));
  assert.ok(labels.every((label) => label.startsWith("SRA1 · aisle 0")));
  assert.match(wrong.suggestions.find((item) => item.label === "SRA1 · aisle 02").reason, /Teman SKU/);
});

test("planogram detail API parameters and client filters stay bounded", () => {
  assert.deepEqual(selectedZones("SRA1,MZC2"), ["SRA1", "MZC2"]);
  assert.equal(limitValue("900"), 500);
  const filtered = filterPlanogramDetailRows(buildPlanogramDetailRows([row()]), { query: "Minuman Uji", status: "WRONG_L1" });
  assert.equal(filtered.length, 1);
});

test("ready Planogram tasks stay above generated rows across 500-row batches", () => {
  const sorted = sortRows([
    { task_eligible: false, status: "WRONG_L1", wrong_value: 999, stock: 10, rack_name: "A", sku_number: "1" },
    { task_eligible: true, status: "WRONG_L1", wrong_value: 1, stock: 1, rack_name: "B", sku_number: "2" },
  ]);
  assert.equal(sorted[0].task_eligible, true);
});
