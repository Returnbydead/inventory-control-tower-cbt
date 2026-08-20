const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPlanogramDetailRows,
  filterPlanogramDetailRows,
} = require("../lib/planogram-detail");
const {
  limitValue,
  prepareGeneration,
  selectedZones,
  sortRows,
  STRICT_PLANOGRAM_FETCH_OPTIONS,
} = require("../api/planogram-detail")._test;

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

test("wrong Minuman SKU receives the exact live GSheet ranges in sheet order", () => {
  const liveRules = [
    {
      category: "Minuman",
      zone: "SRA1",
      aisle_from: 1,
      aisle_to: 8,
      aisle_label: "01-08",
      source: "GSHEET_LIVE",
    },
    {
      category: "Minuman",
      zone: "MZD1",
      aisle_from: 1,
      aisle_to: 36,
      aisle_label: "01-36",
      source: "GSHEET_LIVE",
    },
    {
      category: "Snack",
      zone: "SRA1",
      aisle_from: 9,
      aisle_to: 10,
      aisle_label: "09-10",
      source: "GSHEET_LIVE",
    },
  ];
  const rows = buildPlanogramDetailRows([
    row(),
    row({ rack_name: "CBT-SRA1-02-01-L1-01", aisle: "02", stock: 40 }),
    row({ sku_number: "899000000100", rack_name: "CBT-SRA1-04-01-L1-01", aisle: "04", stock: 200 }),
  ], liveRules);
  const wrong = rows.find((item) => item.status === "WRONG_L1");
  assert.ok(wrong);
  assert.deepEqual(
    wrong.suggestions.map(({ zone, aisle_from, aisle_to, label, reason }) => ({
      zone,
      aisle_from,
      aisle_to,
      label,
      reason,
    })),
    [
      {
        zone: "SRA1",
        aisle_from: 1,
        aisle_to: 8,
        label: "SRA1 · aisle 01-08",
        reason: "Rule GSheet",
      },
      {
        zone: "MZD1",
        aisle_from: 1,
        aisle_to: 36,
        label: "MZD1 · aisle 01-36",
        reason: "Rule GSheet",
      },
    ],
  );
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

test("a slow read-only ledger keeps candidates selectable for strict verification on POST", () => {
  const state = prepareGeneration(
    buildPlanogramDetailRows([row()]),
    { available: false, ledger: { tasks: [], keys: [] } },
    false,
  );

  assert.equal(state.generationAvailable, true);
  assert.equal(state.verificationRequired, true);
  assert.equal(state.rows[0].task_eligible, true);
  assert.equal(state.rows[0].task_status, "VERIFY_ON_GENERATE");
});

test("stale Planogram rules keep provisional candidates for strict verification on POST", () => {
  const state = prepareGeneration(
    buildPlanogramDetailRows([row()]),
    { available: true, ledger: { tasks: [], keys: [] } },
    true,
  );

  assert.equal(state.generationAvailable, true);
  assert.equal(state.verificationRequired, true);
  assert.equal(state.rows[0].task_eligible, true);
  assert.equal(state.rows[0].task_status, "VERIFY_ON_GENERATE");
  assert.deepEqual(STRICT_PLANOGRAM_FETCH_OPTIONS, {
    allowFallback: false,
    retries: 2,
    retryDelayMs: 1000,
    timeoutMs: 30000,
  });
});
