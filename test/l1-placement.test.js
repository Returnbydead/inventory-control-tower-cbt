const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addressParts,
  evaluateCategory,
  placementAreasForCategory,
  placementRangesForCategory,
  targetFor,
} = require("../lib/l1-placement");
const { aggregateRows, summarize, summarizeByZone, activateReadDatabase } = require("../api/rack-status")._test;

test("read-only rack status only selects the existing database", async () => {
  const calls = [];
  await activateReadDatabase({ query: async sql => calls.push(sql) }, "inventory_cbt");
  assert.deepEqual(calls, ["USE inventory_cbt"]);
});

test("all-zone summary groups locations without returning the detail payload", () => {
  const grouped = summarizeByZone([
    { zone: "SRA1", status: "COMPLIANT", qty: 10, wrong_qty: 0, stock_value: 100, wrong_value: 0 },
    { zone: "SRA1", status: "WRONG_L1", qty: 5, wrong_qty: 5, stock_value: 50, wrong_value: 50 },
    { zone: "MZA1", status: "NO_TARGET", qty: 2, wrong_qty: 0, stock_value: 20, wrong_value: 0 },
  ]);
  assert.equal(grouped.SRA1.compliant, 1);
  assert.equal(grouped.SRA1.wrong_l1, 1);
  assert.equal(grouped.MZA1.no_target, 1);
});

test("uses first rack number as aisle and second as sequence", () => {
  assert.deepEqual(addressParts("STL-SRA1-33-07-L2-C1"), {
    zone: "SRA1",
    aisle: 33,
    sequence: 7,
    rackLevel: 2,
    position: "C1",
  });
});

test("uses the GSheet mapping for Tata Rumah at SRC1 aisle 07", () => {
  assert.equal(
    evaluateCategory("CBT-SRC1-07-13-L2-01", "Tata Rumah").result,
    "COMPLIANT",
  );
  assert.equal(
    evaluateCategory("CBT-SRC1-18-13-L2-01", "Tata Rumah").result,
    "WRONG_L1",
  );
});

test("maps SRC1 aisles 04-06 to Kebutuhan Cuci Baju and keeps non-halal outside accuracy", () => {
  for (const aisle of ["04", "05", "06"]) {
    assert.equal(
      evaluateCategory(`CBT-SRC1-${aisle}-03-L1-01`, "Kebutuhan Cuci Baju").result,
      "COMPLIANT",
    );
  }
  assert.equal(
    evaluateCategory("CBT-SRC1-04-03-L1-01", "Kebutuhan Ibu & Bayi").result,
    "WRONG_L1",
  );
  const excluded = Object.entries(
    require("../public/data/l1-placement-rules.json").rules,
  ).find(([, rule]) => rule.excluded);
  assert.ok(excluded);
  const [zone, rackSequence] = excluded[0].split(":");
  assert.equal(targetFor(`CBT-${zone}-${rackSequence}-01-L1-01`).status, "EXCLUDED");
});

test("GSheet screenshot is the only source for SPR placement suggestions", () => {
  assert.equal(
    require("../public/data/planogram-gsheet-rules.json").rules.length,
    37,
  );
  assert.equal(
    evaluateCategory("CBT-SRA1-12-01-L1-01", "Makanan & Susu Bayi").result,
    "COMPLIANT",
  );
  assert.equal(
    evaluateCategory("CBT-SRA1-12-01-L1-01", "Cokelat").result,
    "WRONG_L1",
  );
  const labels = placementAreasForCategory("Minuman")
    .map((area) => `${area.zone}:${area.aisle}`);
  assert.deepEqual(labels, [
    "SRA1:1", "SRA1:2", "SRA1:3", "SRA1:4",
    "SRA1:5", "SRA1:6", "SRA1:7", "SRA1:8",
  ]);
  assert.deepEqual(placementAreasForCategory("Cokelat"), []);
  assert.deepEqual(placementRangesForCategory("Kebutuhan Pokok"), [
    {
      zone: "SRB1",
      aisle_from: 7,
      aisle_to: 20,
      aisle_label: "07-20",
      source: "Inventory Support Outbound GSheet - PLANOGRAM screenshot supplied 2026-08-05",
    },
  ]);
});

test("live Planogram rules override the bundled snapshot", () => {
  const liveRules = [{
    category: "Minuman",
    zone: "SRB1",
    aisle_from: 19,
    aisle_to: 20,
    source: "GSHEET_LIVE",
  }];

  assert.equal(
    evaluateCategory("CBT-SRB1-19-01-L1-01", "Minuman", liveRules).result,
    "COMPLIANT",
  );
  assert.equal(
    evaluateCategory("CBT-SRA1-01-01-L1-01", "Minuman", liveRules).result,
    "NO_TARGET",
  );
  assert.deepEqual(placementRangesForCategory("Minuman", liveRules), [{
    zone: "SRB1",
    aisle_from: 19,
    aisle_to: 20,
    aisle_label: "19-20",
    source: "GSHEET_LIVE",
  }]);
});

test("aggregates occupied SLOC and marks any wrong category as WRONG_L1", () => {
  const rows = [
    {
      rack_name: "CBT-SRC1-18-13-L2-01",
      zone: "SRC1",
      rack_sequence: "18",
      aisle: "13",
      rack_level: "L2",
      sku_number: "A",
      l1_category_name: "Perawatan Rumah",
      l2_category_name: "L2-A",
      stock: 2,
      stock_value: 100,
    },
    {
      rack_name: "CBT-SRC1-18-13-L2-01",
      zone: "SRC1",
      rack_sequence: "18",
      aisle: "13",
      rack_level: "L2",
      sku_number: "B",
      l1_category_name: "Produk Segar",
      l2_category_name: "L2-B",
      stock: 3,
      stock_value: 200,
    },
  ];
  const locations = aggregateRows(rows);
  assert.equal(locations.length, 1);
  assert.equal(locations[0].status, "WRONG_L1");
  assert.equal(locations[0].qty, 5);
  assert.equal(locations[0].wrong_qty, 3);
  assert.equal(locations[0].sku_count, 2);
  assert.equal(summarize(locations).wrong_l1, 1);
});
