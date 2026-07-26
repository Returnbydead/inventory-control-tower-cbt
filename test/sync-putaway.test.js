const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mergeTask,
  normalizeItem,
  mapConcurrent,
} = require("../api/sync-putaway")._test;

test("merges list and detail task fields", () => {
  const task = mergeTask({
    id: 1015162,
    task_number: "ID1/PUT/1",
    purchase_order_number: "ID1/POR/1",
    package_label: "ATI/1",
    location_id: 819,
    location_name: "CBT - WH Cibitung",
    status: "PENDING",
  }, {
    data: {
      id: 1015162,
      task_number: "ID1/PUT/1",
      purchase_order_number: "ID1/POR/1",
      location_id: 819,
      location_name: "CBT - WH Cibitung",
      staff_name: "Dani",
      status: "COMPLETED",
      activities: [{
        activity_name: "COMPLETED",
        start_date: "2026-07-26T11:22:00+07:00",
      }],
    },
  });
  assert.equal(task.status, "COMPLETED");
  assert.equal(task.package_label, "ATI/1");
  assert.equal(task.staff_name, "Dani");
});

test("normalizes WIMS item rack and SKU fields", () => {
  const item = normalizeItem(1015162, {
    task_item_id: 1231683,
    product_id: 47718,
    product_sku: "8994680063764",
    product_name: "Hasston",
    qty: 18,
    base_uom: "PCS",
    from_rack_id: 2846898,
    from_rack_name: "CBT-STG1-IB-01-01-01",
    to_rack_id: 3422269,
    to_rack_name: "CBT-SRC1-18-03-L2-02",
  });
  assert.equal(item.task_id, 1015162);
  assert.equal(item.product_sku, "8994680063764");
  assert.equal(item.to_rack_name, "CBT-SRC1-18-03-L2-02");
});

test("bounded concurrency preserves result order", async () => {
  const result = await mapConcurrent([3, 1, 2], 2, async (value) => value * 2);
  assert.deepEqual(result, [6, 2, 4]);
});
