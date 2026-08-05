const test = require("node:test");
const assert = require("node:assert/strict");
const {
  exportRow,
  buildCsv,
  PLANOGRAM_EXPORT_HEADERS,
  planogramExportRow,
  selectedZones,
} = require("../api/occupancy-export")._test;
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

test("planogram detail export mirrors the simple table without values or suggestion basis", () => {
  const row = planogramExportRow({
    sku_number: "899000000002",
    product_name: "Cokelat Test",
    l1_category_name: "Cokelat",
    l2_category_name: "Cokelat Batang",
    rack_name: "CBT-SRA1-09-01-L1-01",
    zone: "SRA1",
    aisle: 9,
    rack_sequence: 1,
    rack_level: "L1",
    stock: 24,
    stock_value: 100000,
    allowed_l1: ["Minuman"],
    status: "WRONG_L1",
    wrong_qty: 24,
    wrong_value: 100000,
    suggestions: [
      { label: "SRA1 - aisle 12", reason: "Teman SKU 40 qty" },
      { label: "MZC2 - aisle 10", reason: "Cluster L1 200 qty" },
    ],
  });

  assert.deepEqual(PLANOGRAM_EXPORT_HEADERS, [
    "SKU / Produk", "Current Rack", "Zone", "Aisle", "Sequence", "Level",
    "Current L1", "Quantity", "Wrong Qty", "Target di Lokasi Saat Ini",
    "Saran Placement", "Status",
  ]);
  assert.equal(row.length, PLANOGRAM_EXPORT_HEADERS.length);
  assert.equal(row[0], "899000000002 - Cokelat Test");
  assert.equal(row[7], 24);
  assert.equal(row[8], 24);
  assert.equal(row[9], "Minuman");
  assert.equal(row[10], "SRA1 - aisle 12 | MZC2 - aisle 10");
  assert.equal(row[11], "WRONG_L1");
  assert.ok(!row.includes(100000));
  assert.ok(!row.join(" ").includes("Teman SKU"));
  assert.ok(!row.join(" ").includes("Cluster L1"));
});

test("planogram CSV opens in regional Excel with separate columns and one row per record", () => {
  const csv = buildCsv([
    PLANOGRAM_EXPORT_HEADERS,
    ["899 - Produk", "CBT-SRA1-01-01-L1-01", "SRA1"],
  ], { delimiter: ";", excelSeparator: true });

  assert.ok(csv.startsWith("\uFEFFsep=;\r\n"));
  assert.match(csv, /"SKU \/ Produk";"Current Rack";"Zone"/);
  assert.match(csv, /\r\n"899 - Produk";"CBT-SRA1-01-01-L1-01";"SRA1"$/);
  assert.equal(csv.split("\r\n").length, 3);
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
