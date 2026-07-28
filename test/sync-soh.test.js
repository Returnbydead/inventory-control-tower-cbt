const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveRack,
  remarksZone,
  normalizeRow,
  supersetPayload,
} = require("../api/sync-soh")._test;

test("parses STL rack structure using aisle 33 and sequence 07", () => {
  assert.deepEqual(deriveRack("STL-SRA1-33-07-L2-C1"), {
    zone: "SRA1",
    aisle: "33",
    rack_sequence: "07",
    level: "L2",
  });
});

test("parses CBT mezzanine location", () => {
  assert.deepEqual(deriveRack("CBT-MZE1-03-05-L2-05"), {
    zone: "MZE1",
    aisle: "03",
    rack_sequence: "05",
    level: "L2",
  });
});

test("classifies storage and pickface", () => {
  assert.equal(remarksZone("STL-SRA1-33-07-L1-C1", "L1"), "PICKFACE");
  assert.equal(remarksZone("STL-SRA1-33-07-L2-C1", "L2"), "STORAGE");
  assert.equal(remarksZone("CBT-MZE1-03-05-L2-05", "L2"), "PICKFACE");
});

test("normalizes numeric inventory values", () => {
  const row = normalizeRow({
    location_name: "Cibitung",
    product_id: "123",
    sku_number: "SKU-1",
    rack_name: "STL-SRA1-33-07-L2-C1",
    stock: "12",
    stock_value: "45000",
  });
  assert.equal(row.stock, 12);
  assert.equal(row.stock_value, 45000);
  assert.equal(row.aisle, "33");
});

test("requests up to 100000 rows from Superset", () => {
  const payload = supersetPayload();
  assert.equal(payload.queries[0].row_limit, 100000);
  assert.equal(payload.form_data.row_limit, 100000);
});
