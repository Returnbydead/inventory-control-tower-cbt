const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCalculator,
  normalizePostedTasks,
  normalizeSelectedTaskKeys,
  normalizeTaskKey,
  selectCurrentTasks,
} = require("../api/replenishment-calculator")._test;

function param(overrides = {}) {
  return {
    product_id: "P1",
    sku_number: "SKU1",
    product_name: "Produk 1",
    soh: 30,
    pickface: 2,
    storage: 28,
    order_per_day: 5,
    shelf_life: 10,
    max_pf: 10,
    final_qty: 10,
    doi: 1,
    task_qty: 8,
    ...overrides,
  };
}

function storage(rackName, stock, overrides = {}) {
  return {
    product_id: "P1",
    sku_number: "SKU1",
    product_name: "Produk 1",
    rack_name: rackName,
    zone: "SRA1",
    aisle: "01",
    rack_sequence: "01",
    rack_level: "L2",
    remarks_zone: "STORAGE",
    l1_category_name: "Kategori",
    stock,
    snapshot_at: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

test("uses GSheet Task Qty and allocates the smallest source rack first", () => {
  const result = buildCalculator({
    params: [param()],
    sohRows: [storage("RACK-B", 10), storage("RACK-A", 5)],
    existingKeys: [],
  });

  assert.equal(result.summary.required_qty, 8);
  assert.deepEqual(
    result.tasks.map((task) => [task.from_rack_name, task.allocated_qty]),
    [
      ["RACK-A", 5],
      ["RACK-B", 3],
    ],
  );
});

test("normalizes existing task keys and emits one candidate per source rack", () => {
  const result = buildCalculator({
    params: [param()],
    sohRows: [
      storage("RACK-A", 5),
      storage("rack-a", 5, { product_name: "Nama lama" }),
      storage("RACK-B", 10),
    ],
    existingKeys: ["SKU1|rack-a"],
  });

  assert.equal(result.summary.skipped_existing_source_count, 1);
  assert.deepEqual(result.tasks.map((task) => task.task_key), ["SKU1|RACK-B"]);
});

test("POST selection accepts task keys only and rejects stale candidates", () => {
  const keys = normalizeSelectedTaskKeys(["SKU1|rack-a", "SKU1|RACK-A"]);
  assert.deepEqual(keys, ["SKU1|RACK-A"]);
  assert.throws(
    () => selectCurrentTasks([], keys),
    /Kandidat task sudah berubah/,
  );
  assert.throws(
    () => normalizeSelectedTaskKeys(["INVALID"]),
    /SKU\|SOURCE_RACK/,
  );
});

test("server rejects allocations above source stock or replenish quantity", () => {
  const baseTask = {
    task_key: "SKU1|RACK-A",
    sku_number: "SKU1",
    from_rack_name: "RACK-A",
    source_stock: 5,
    allocated_qty: 6,
    replenish_qty: 8,
  };

  assert.throws(
    () => normalizePostedTasks([baseTask]),
    /tidak boleh melebihi source_stock/,
  );

  assert.throws(
    () =>
      normalizePostedTasks([
        { ...baseTask, source_stock: 10, replenish_qty: 4 },
      ]),
    /tidak boleh melebihi replenish_qty/,
  );
});

test("server-generated GAS payload preserves task and destination rack keys", () => {
  const [task] = normalizePostedTasks([
    {
      task_key: "SKU1|RACK-A",
      sku_number: "SKU1",
      from_rack_name: "rack-a",
      source_stock: 5,
      allocated_qty: 5,
      replenish_qty: 8,
      suggested_rack_name: "cbt-pf-01",
    },
  ]);

  assert.equal(task.task_key, "SKU1|RACK-A");
  assert.equal(task.suggested_rack_name, "CBT-PF-01");
});

test("selected allocations cannot exceed the latest Task Qty per SKU", () => {
  const tasks = [
    {
      ...param(),
      task_key: normalizeTaskKey("SKU1|RACK-A"),
      from_rack_name: "RACK-A",
      source_stock: 10,
      allocated_qty: 5,
    },
    {
      ...param(),
      task_key: normalizeTaskKey("SKU1|RACK-B"),
      from_rack_name: "RACK-B",
      source_stock: 10,
      allocated_qty: 5,
    },
  ];

  assert.throws(
    () => selectCurrentTasks(tasks, tasks.map((task) => task.task_key)),
    /melebihi Task Qty terbaru/,
  );
});

test("UI sends task keys and no longer exposes an ignored DOI control", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "preview", "replenishment-calculator.html"),
    "utf8",
  );

  assert.doesNotMatch(html, /id="doiInput"/);
  assert.match(html, /task_keys:\s*tasks\.map/);
  assert.match(html, /Task Qty resmi dari PARAM/);
});
