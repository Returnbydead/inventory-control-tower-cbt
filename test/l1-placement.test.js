const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addressParts,
  evaluateCategory,
  targetFor,
} = require("../lib/l1-placement");
const { aggregateRows, summarize } = require("../api/rack-status")._test;

test("uses rack sequence as bay and 07 as aisle", () => {
  assert.deepEqual(addressParts("STL-SRA1-33-07-L2-C1"), {
    zone: "SRA1",
    rackSequence: 33,
    aisle: 7,
    rackLevel: 2,
    position: "C1",
  });
});

test("applies SRC aisle 18 Tata Rumah only to rack sequence 13-17", () => {
  assert.equal(
    evaluateCategory("CBT-SRC1-13-18-L2-01", "Tata Rumah").result,
    "COMPLIANT",
  );
  assert.equal(
    evaluateCategory("CBT-SRC1-12-18-L2-01", "Tata Rumah").result,
    "WRONG_L1",
  );
});

test("keeps blank targets and non-halal outside accuracy", () => {
  assert.equal(targetFor("CBT-SRC1-01-04-L1-01").status, "NO_TARGET");
  const excluded = Object.entries(
    require("../public/data/l1-placement-rules.json").rules,
  ).find(([, rule]) => rule.excluded);
  assert.ok(excluded);
  const [zone, aisle] = excluded[0].split(":");
  assert.equal(targetFor(`CBT-${zone}-01-${aisle}-L1-01`).status, "EXCLUDED");
});

test("aggregates occupied SLOC and marks any wrong category as WRONG_L1", () => {
  const rows = [
    {
      rack_name: "CBT-SRC1-13-18-L2-01",
      zone: "SRC1",
      rack_sequence: "13",
      aisle: "18",
      rack_level: "L2",
      sku_number: "A",
      l1_category_name: "Tata Rumah",
      l2_category_name: "L2-A",
      stock: 2,
      stock_value: 100,
    },
    {
      rack_name: "CBT-SRC1-13-18-L2-01",
      zone: "SRC1",
      rack_sequence: "13",
      aisle: "18",
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
