const test = require("node:test");
const assert = require("node:assert/strict");
const { capacityKey, summarizeOccupancy } = require("../lib/occupancy");

const master = {
  schema: { location_fields: ["rack_name", "zone_id", "level_id"] },
  dictionaries: { zone: [null, "MZA1"], level: [null, "L1", "L2"] },
  locations: [
    ["CBT-MZA1-01-01-L1-01", 1, 1],
    ["CBT-MZA1-01-01-L2-01", 1, 2],
  ],
};

test("capacity key maps zone family and level", () => {
  assert.equal(capacityKey("MZA1", "L2"), "MZAL2");
  assert.equal(capacityKey("SRA1", "L6"), "SRAL6");
});

test("occupancy totals use every configured master location and expose one L1 row per storage area", () => {
  const live = new Map([["CBT-MZA1-01-01-L1-01", {
    qty: 15,
    wrong_qty: 4,
    qty_by_l1: new Map([["Kebutuhan Cuci Baju", 15]]),
    wrong_qty_by_l1: new Map([["Kebutuhan Cuci Baju", 4]]),
  }]]);
  const result = summarizeOccupancy(master, live, { MZAL1: 12, MZAL2: 24 });
  assert.equal(result.total.space_qty, 36);
  assert.equal(result.total.used_qty, 15);
  assert.equal(result.total.available_qty, 21);
  assert.equal(result.total.utilization_pct, 41.67);
  assert.equal(result.zones[0].location_count, 2);
  assert.equal(result.l1.reduce((sum, row) => sum + row.space_qty, 0), 36);
  assert.deepEqual(result.l1_by_storage, [{
    target_l1: "Kebutuhan Cuci Baju",
    shared: false,
    mezzanine: {
      space_qty: 36,
      used_qty: 15,
      wrong_qty: 4,
      available_qty: 21,
      utilization_pct: 41.67,
      location_count: 2,
    },
    spr: null,
    high_risk: null,
  }]);
  assert.deepEqual(result.l1_category_by_storage, [{
    target_l1: "Kebutuhan Cuci Baju",
    shared: false,
    mezzanine: {
      space_qty: 36,
      used_qty: 15,
      wrong_qty: 4,
      available_qty: 21,
      utilization_pct: 41.67,
      location_count: 2,
    },
    spr: null,
    high_risk: null,
  }]);
});
