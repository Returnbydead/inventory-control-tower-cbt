const test = require("node:test");
const assert = require("node:assert/strict");

const {
  annotatePlanogramRows,
  buildPlanogramTaskKey,
  normalizeSelectedTaskKeys,
  selectCurrentTasks,
  toPostedPlanogramTask,
} = require("../lib/planogram-tasks");

function wrongRow(overrides = {}) {
  return {
    sku_number: "089900000001",
    product_name: "Produk Uji",
    rack_name: "CBT-SRC1-24-11-L1-01",
    zone: "SRC1",
    aisle: 24,
    rack_sequence: 11,
    rack_level: "L1",
    l1_category_name: "Perawatan Diri",
    allowed_l1: ["Astro Kitchen"],
    status: "WRONG_L1",
    wrong_qty: 12,
    suggestions: [
      {
        zone: "SRC1",
        aisle: 23,
        aisle_from: 23,
        aisle_to: 24,
        aisle_label: "23-24",
      },
      {
        zone: "MZB2",
        aisle: 1,
        aisle_from: 1,
        aisle_to: 36,
        aisle_label: "01-36",
      },
    ],
    ...overrides,
  };
}

test("planogram task key preserves leading-zero SKU and source rack", () => {
  assert.equal(
    buildPlanogramTaskKey("089900000001", "cbt-src1-24-11-l1-01"),
    "PLANOGRAM|089900000001|CBT-SRC1-24-11-L1-01",
  );
});

test("existing Planogram key disables the same candidate", () => {
  const key = buildPlanogramTaskKey("089900000001", "CBT-SRC1-24-11-L1-01");
  const [row] = annotatePlanogramRows([wrongRow()], [key]);
  assert.equal(row.task_eligible, false);
  assert.equal(row.task_status, "GENERATED");
});

test("posted Planogram task keeps the exact GSheet range options", () => {
  const [row] = annotatePlanogramRows([wrongRow()], []);
  const selected = selectCurrentTasks([row], normalizeSelectedTaskKeys([row.task_key]));
  const task = toPostedPlanogramTask(selected[0]);
  assert.equal(task.move_qty, 12);
  assert.equal(task.suggested_zone, "SRC1");
  assert.equal(task.suggested_aisle, 23);
  assert.equal(task.suggestion_options, "SRC1 - aisle 23-24 | MZB2 - aisle 01-36");
  assert.equal(task.suggested_rack_name, "");
});

test("stale or generated selection is rejected before posting", () => {
  const [row] = annotatePlanogramRows([wrongRow()], [
    "PLANOGRAM|089900000001|CBT-SRC1-24-11-L1-01",
  ]);
  assert.throws(
    () => selectCurrentTasks([row], [row.task_key]),
    /sudah berubah atau sudah tergenerate/,
  );
});
