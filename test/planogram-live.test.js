const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../lib/planogram-live");

test("normalizes and deduplicates live Planogram API rows", () => {
  const rules = _test.normalizePlanogramRows([
    { category: " Minuman ", zone: "sra1", aisle_from: "1", aisle_to: "8" },
    { category: "Minuman", zone: "SRA1", aisle_from: 1, aisle_to: 8 },
    { category: "Vitamin", zone: "SRC1", aisle_from: 13, aisle_to: 13 },
  ]);

  assert.deepEqual(rules, [
    {
      category: "Minuman",
      zone: "SRA1",
      aisle_from: 1,
      aisle_to: 8,
      aisle_label: "01-08",
      source: "GSHEET_LIVE",
    },
    {
      category: "Vitamin",
      zone: "SRC1",
      aisle_from: 13,
      aisle_to: 13,
      aisle_label: "13",
      source: "GSHEET_LIVE",
    },
  ]);
});

test("rejects malformed or empty live Planogram data", () => {
  assert.throws(
    () => _test.normalizePlanogramRows([
      { category: "Minuman", zone: "SRA1", aisle_from: 8, aisle_to: 1 },
    ]),
    /rack suggestion tidak valid/i,
  );
  assert.throws(() => _test.normalizePlanogramRows([]), /aturan aktif/i);
  assert.throws(() => _test.normalizePlanogramRows(null), /array rows/i);
});
