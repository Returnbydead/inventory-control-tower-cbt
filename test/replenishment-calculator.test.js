const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCalculator,
  calculationForParam,
  generationEnabled,
  normalizeDoiOverride,
  normalizeExistingTasks,
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
  assert.equal(result.doi_source, "GSHEET");
  assert.deepEqual(
    result.tasks.map((task) => [task.from_rack_name, task.allocated_qty]),
    [
      ["RACK-A", 5],
      ["RACK-B", 3],
    ],
  );
});

test("accepts replenishment source racks through level L7", () => {
  const result = buildCalculator({
    params: [param()],
    sohRows: [
      storage("RACK-L7", 5, { rack_level: "L7" }),
      storage("RACK-L8", 10, { rack_level: "L8" }),
    ],
    existingKeys: [],
  });

  assert.deepEqual(
    result.tasks.map((task) => [task.from_rack_name, task.allocated_qty]),
    [["RACK-L7", 5]],
  );
  assert.equal(result.summary.allocated_qty, 5);
  assert.equal(result.summary.shortage_qty, 3);
});

test("Replenishment suggestion always follows the GSheet planogram range", () => {
  const result = buildCalculator({
    params: [param()],
    sohRows: [
      storage("CBT-SRC1-20-01-L1-01", 10, {
        remarks_zone: "PICKFACE",
        zone: "SRC1",
        aisle: "20",
        rack_level: "L1",
        l1_category_name: "Minuman",
      }),
      storage("CBT-SRA1-01-01-L2-01", 8, {
        zone: "SRA1",
        aisle: "01",
        l1_category_name: "Minuman",
      }),
    ],
    existingKeys: [],
  });

  assert.equal(result.tasks[0].suggested_zone, "SRA1");
  assert.equal(result.tasks[0].suggested_aisle, "01-08");
  assert.equal(result.tasks[0].suggested_rack_name, "");
  assert.equal(result.tasks[0].suggestion_basis, "PLANOGRAM_GSHEET");
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

test("UI sends task keys with the active DOI override", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "preview", "replenishment-calculator.html"),
    "utf8",
  );

  assert.match(html, /id="doiInput"/);
  assert.match(html, /id="resetDoiButton"/);
  assert.match(html, /url\.searchParams\.set\("doi"/);
  assert.match(html, /task_keys:\s*tasks\.map/);
  assert.match(html, /doi_override: loadedDoiOverride/);
  assert.match(html, /Gunakan DOI PARAM atau override/);
});

test("subtracts active generated quantity per SKU before using another source rack", () => {
  const result = buildCalculator({
    params: [param()],
    sohRows: [storage("RACK-A", 5), storage("RACK-B", 10)],
    existingKeys: [],
    existingTasks: [
      {
        task_key: "SKU1|RACK-A",
        sku_number: "SKU1",
        from_rack_name: "RACK-A",
        allocated_qty: 5,
        status: "READY",
      },
    ],
    ledgerMode: "TASKS",
  });

  assert.equal(result.ledger_ready, true);
  assert.equal(result.summary.required_qty, 8);
  assert.equal(result.summary.existing_allocated_qty, 5);
  assert.equal(result.summary.remaining_required_qty, 3);
  assert.deepEqual(
    result.tasks.map((task) => [task.task_key, task.allocated_qty]),
    [["SKU1|RACK-B", 3]],
  );
});

test("a fully generated SKU has no second-run candidates", () => {
  const existingTasks = [
    {
      task_key: "SKU1|RACK-A",
      sku_number: "SKU1",
      allocated_qty: 5,
      status: "READY",
    },
    {
      task_key: "SKU1|RACK-B",
      sku_number: "SKU1",
      allocated_qty: 3,
      status: "PARTIAL",
    },
  ];
  const result = buildCalculator({
    params: [param()],
    sohRows: [storage("RACK-A", 5), storage("RACK-B", 10)],
    existingTasks,
    ledgerMode: "TASKS",
  });

  assert.equal(result.summary.task_count, 0);
  assert.equal(result.summary.existing_allocated_qty, 8);
  assert.equal(result.summary.remaining_required_qty, 0);
  assert.equal(result.sku_rows[0].status, "ALREADY_GENERATED");
});

test("duplicate active rows are surfaced as overgenerated and never create more candidates", () => {
  const previous = process.env.REPLENISHMENT_GENERATION_ENABLED;
  process.env.REPLENISHMENT_GENERATION_ENABLED = "true";
  const result = buildCalculator({
    params: [param()],
    sohRows: [storage("RACK-A", 5), storage("RACK-B", 10)],
    existingTasks: [
      { task_key: "SKU1|RACK-A", allocated_qty: 8, status: "READY" },
      { task_key: "SKU1|RACK-B", allocated_qty: 5, status: "READY" },
    ],
    ledgerMode: "TASKS",
  });

  assert.equal(result.summary.existing_generated_qty, 13);
  assert.equal(result.summary.existing_allocated_qty, 8);
  assert.equal(result.summary.overgenerated_qty, 5);
  assert.equal(result.summary.remaining_required_qty, 0);
  assert.equal(result.summary.task_count, 0);
  assert.equal(result.ledger_safe, false);
  assert.equal(result.generation_enabled, false);
  assert.equal(result.generation_block_reason, "OVERGENERATED");

  if (previous === undefined) {
    delete process.env.REPLENISHMENT_GENERATION_ENABLED;
  } else {
    process.env.REPLENISHMENT_GENERATION_ENABLED = previous;
  }
});

test("completed or cancelled ledger rows no longer reduce current demand", () => {
  const tasks = normalizeExistingTasks([
    { task_key: "SKU1|RACK-A", allocated_qty: 5, status: "COMPLETED" },
    { task_key: "SKU1|RACK-B", allocated_qty: 3, status: "CANCELLED" },
    { task_key: "SKU1|RACK-C", allocated_qty: 2, status: "READY" },
  ]);

  assert.deepEqual(
    tasks.map((task) => [task.task_key, task.allocated_qty]),
    [["SKU1|RACK-C", 2]],
  );
});

test("uses task_key SKU when Google Sheets drops a leading zero", () => {
  const tasks = normalizeExistingTasks([
    {
      task_key: "089686010947|CBT-SRB1-01-10-L2-01",
      sku_number: "89686010947",
      allocated_qty: 2855,
      status: "READY",
    },
  ]);

  assert.deepEqual(
    tasks.map((task) => [task.sku_number, task.allocated_qty]),
    [["089686010947", 2855]],
  );
});

test("leading-zero SKU ledger rows stop a second allocation run", () => {
  const skuNumber = "089686010947";
  const result = buildCalculator({
    params: [param({ sku_number: skuNumber })],
    sohRows: [storage("RACK-A", 8, { sku_number: skuNumber })],
    existingTasks: [
      {
        task_key: `${skuNumber}|RACK-A`,
        sku_number: "89686010947",
        allocated_qty: 8,
        status: "READY",
      },
    ],
    ledgerMode: "TASKS",
  });

  assert.equal(result.summary.existing_generated_qty, 8);
  assert.equal(result.summary.remaining_required_qty, 0);
  assert.equal(result.summary.task_count, 0);
});

test("DOI override recalculates Target PF, Need, and Task Qty on the server", () => {
  const result = buildCalculator({
    params: [param()],
    sohRows: [storage("RACK-A", 5), storage("RACK-B", 30)],
    existingKeys: [],
    doiOverride: 3,
  });

  assert.equal(result.doi, 3);
  assert.equal(result.doi_source, "WEB_OVERRIDE");
  assert.equal(result.summary.required_qty, 28);
  assert.equal(result.sku_rows[0].target_pf, 30);
  assert.equal(result.sku_rows[0].need_qty, 28);
  assert.equal(result.sku_rows[0].task_qty, 28);
  assert.deepEqual(
    result.tasks.map((task) => task.allocated_qty),
    [5, 23],
  );
});

test("DOI override caps Task Qty at GSheet Storage and rejects invalid DOI", () => {
  const calculation = calculationForParam(param({ storage: 7 }), 3);

  assert.deepEqual(calculation, {
    doi: 3,
    targetPf: 30,
    needQty: 28,
    taskQty: 7,
  });
  assert.equal(normalizeDoiOverride("2.5"), 2.5);
  assert.equal(normalizeDoiOverride(""), null);
  assert.throws(() => normalizeDoiOverride(0), /lebih dari 0/);
});

test("rounds operational task quantities per SKU before ledger reconciliation", () => {
  const result = buildCalculator({
    params: [
      param({
        max_pf: 100.25,
        pickface: 50,
        storage: 500,
      }),
    ],
    sohRows: [storage("RACK-A", 251)],
    existingTasks: [
      {
        task_key: "SKU1|RACK-A",
        allocated_qty: 251,
        status: "READY",
      },
    ],
    ledgerMode: "TASKS",
    doiOverride: 3,
  });

  assert.equal(result.sku_rows[0].target_pf, 301);
  assert.equal(result.sku_rows[0].task_qty, 251);
  assert.equal(result.summary.required_qty, 251);
  assert.equal(result.summary.existing_generated_qty, 251);
  assert.equal(result.summary.overgenerated_qty, 0);
  assert.equal(result.summary.task_count, 0);
  assert.equal(result.ledger_safe, true);
});

test("task generation stays locked unless explicitly enabled", () => {
  const previous = process.env.REPLENISHMENT_GENERATION_ENABLED;

  delete process.env.REPLENISHMENT_GENERATION_ENABLED;
  assert.equal(generationEnabled(), false);

  process.env.REPLENISHMENT_GENERATION_ENABLED = "true";
  assert.equal(generationEnabled(), true);

  if (previous === undefined) {
    delete process.env.REPLENISHMENT_GENERATION_ENABLED;
  } else {
    process.env.REPLENISHMENT_GENERATION_ENABLED = previous;
  }
});

test("UI renders replenishment quantities as whole Indonesian numbers", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "public", "preview", "replenishment-calculator.html"),
    "utf8",
  );

  assert.match(
    html,
    /new Intl\.NumberFormat\("id-ID", \{\s*maximumFractionDigits: 0,/,
  );
  assert.equal(
    new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(
      46061.709,
    ),
    "46.062",
  );
});

test("MZC2 sidebar keeps the Replenishment navigation link", () => {
  const html = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "public",
      "preview",
      "mzc2-sku-rebalancing-prototype.html",
    ),
    "utf8",
  );

  assert.match(
    html,
    /href="\/replenishment"><span class="side-icon">R<\/span>Replenishment Calculator<\/a>/,
  );
});
