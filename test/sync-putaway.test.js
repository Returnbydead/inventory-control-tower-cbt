const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mergeTask,
  normalizeItem,
  mapConcurrent,
  selectDetailRows,
  selectSnapshotRows,
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

test("first sync details every active task but caps completed backfill", () => {
  const rows = [
    { id: 1, status: "PENDING" },
    { id: 2, status: "IN_PROGRESS" },
    { id: 3, status: "COMPLETED" },
    { id: 4, status: "COMPLETED" },
  ];
  const selected = selectDetailRows(rows, new Map(), 1);
  assert.deepEqual(selected.map((row) => row.id), [1, 2, 3]);
});

test("details a task whenever its stored status changes", () => {
  const selected = selectDetailRows(
    [{ id: 1, status: "COMPLETED" }],
    new Map([[1, "IN_PROGRESS"]]),
    0,
  );
  assert.equal(selected.length, 1);
});

test("backfills a stored completed task that still has no detail", () => {
  const selected = selectDetailRows(
    [
      { id: 1, status: "COMPLETED" },
      { id: 2, status: "COMPLETED" },
    ],
    new Map([
      [1, { status: "COMPLETED", has_detail: false }],
      [2, { status: "COMPLETED", has_detail: true }],
    ]),
    1,
    10,
  );
  assert.deepEqual(selected.map((row) => row.id), [1]);
});

test("keeps every active task beyond the recent snapshot window", () => {
  const rows = [
    { id: 1, status: "COMPLETED" },
    { id: 2, status: "COMPLETED" },
    { id: 3, status: "IN_PROGRESS" },
    { id: 4, status: "PENDING" },
  ];
  assert.deepEqual(
    selectSnapshotRows(rows, 1).map((row) => row.id),
    [1, 3, 4],
  );
});

test("reserves detail capacity for active and completed backfill", () => {
  const rows = [
    { id: 1, status: "PENDING" },
    { id: 2, status: "PENDING" },
    { id: 3, status: "COMPLETED" },
    { id: 4, status: "COMPLETED" },
  ];
  const selected = selectDetailRows(rows, new Map(), 2, 4);
  assert.deepEqual(selected.map((row) => row.id), [1, 2, 3, 4]);
});
