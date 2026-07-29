const test = require("node:test");
const assert = require("node:assert/strict");
const { exportRow, selectedZones } = require("../api/occupancy-export")._test;
const { isExcludedOccupancyRack } = require("../lib/occupancy-exclusions");

test("occupancy export keeps SKU x SLOC detail and L1 compliance", () => {
  const row = exportRow({
    zone: "SRC1",
    rack_name: "CBT-SRC1-10-01-L1-01",
    aisle: "10",
    rack_sequence: "01",
    rack_level: "L1",
    sku_number: "899000000001",
    product_name: "SKU Bayi",
    l1_category_name: "Kebutuhan Ibu & Bayi",
    l2_category_name: "Popok",
    stock: 12,
    stock_value: 50000,
    source_rows: 1,
  }, "ALL", "2026-07-29T00:00:00.000Z");
  assert.equal(row[8], "899000000001");
  assert.equal(row[12], "Kebutuhan Ibu & Bayi");
  assert.equal(row[13], "BENAR");
  assert.equal(row[15], 12);
});

test("occupancy export accepts multiple zones", () => {
  assert.deepEqual(selectedZones("MZA1,SRC1"), ["MZA1", "SRC1"]);
});

test("occupancy export recognises every excluded non-storage location", () => {
  assert.equal(isExcludedOccupancyRack("rack - consumable"), true);
  assert.equal(isExcludedOccupancyRack("CBT-ADJ-01-01-01"), true);
  assert.equal(isExcludedOccupancyRack("SUPPLIES-CBT-01"), true);
  assert.equal(isExcludedOccupancyRack("PARKIR-WTW-CBT"), true);
  assert.equal(isExcludedOccupancyRack("CBT-STG1-GL-01-01-01"), true);
  assert.equal(isExcludedOccupancyRack("CBT-STG1-IB-01-01-01"), true);
  assert.equal(isExcludedOccupancyRack("CBT-STG1-LB-01-01-01"), true);
  assert.equal(isExcludedOccupancyRack("CBT-STG1-LB-01-01-02"), true);
  assert.equal(isExcludedOccupancyRack("CBT-STG1-RL-01-01-01"), true);
  assert.equal(isExcludedOccupancyRack("CBT-QRT1-AD-01-01-01"), true);
  assert.equal(isExcludedOccupancyRack("CBT-QRT1-OM-01-01-01"), true);
  assert.equal(isExcludedOccupancyRack("CBT-QRT1-UO-01-01-01"), true);
});
