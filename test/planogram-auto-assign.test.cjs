const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  fetchPlanogramAssignmentPreview,
  postPlanogramAutoAssign,
} = require("../lib/planogram-tasks");

const gasSource = fs.readFileSync(
  path.join(__dirname, "../apps-script/planogram-auto-assign.gs"),
  "utf8",
);

test("auto assign reads PLANOGRAM_TASK and raw mp from Inventory Movement Task-CBT", () => {
  assert.match(gasSource, /SPREADSHEET_ID: '1sXemJ-p4DRXJ18BTtZo8pjvJeVJJhgJJMYnOlooOqps'/);
  assert.match(gasSource, /TASK_SHEET: 'PLANOGRAM_TASK'/);
  assert.match(gasSource, /MANPOWER_SHEET: 'raw mp'/);
});

function loadAllocator() {
  const source = fs.readFileSync(
    path.join(__dirname, "../apps-script/planogram-auto-assign.gs"),
    "utf8",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.allocate = buildPlanogramQtyAssignment_;`, context);
  return context.allocate;
}

test("planogram PIC assignment balances total move qty, not row count", () => {
  const allocate = loadAllocator();
  const result = allocate(
    [
      { task_key: "T10", status: "GENERATED", move_qty: 10, pic: "" },
      { task_key: "T09", status: "GENERATED", move_qty: 9, pic: "" },
      { task_key: "T08", status: "GENERATED", move_qty: 8, pic: "" },
      { task_key: "T07", status: "GENERATED", move_qty: 7, pic: "" },
      { task_key: "T06", status: "GENERATED", move_qty: 6, pic: "" },
      { task_key: "T05", status: "GENERATED", move_qty: 5, pic: "" },
    ],
    [
      { name: "MP A", shift: "MASUK" },
      { name: "MP B", shift: "MASUK" },
      { name: "MP C", shift: "MASUK" },
    ],
  );

  assert.deepEqual(
    Array.from(result.assignments, ({ task_key, pic }) => ({ task_key, pic })),
    [
      { task_key: "T10", pic: "MP A" },
      { task_key: "T09", pic: "MP B" },
      { task_key: "T08", pic: "MP C" },
      { task_key: "T07", pic: "MP C" },
      { task_key: "T06", pic: "MP B" },
      { task_key: "T05", pic: "MP A" },
    ],
  );
  assert.deepEqual(Array.from(result.workloads, ({ name, total_qty }) => ({ name, total_qty })), [
    { name: "MP A", total_qty: 15 },
    { name: "MP B", total_qty: 15 },
    { name: "MP C", total_qty: 15 },
  ]);
});

test("existing PIC load is preserved and OFF manpower is excluded", () => {
  const allocate = loadAllocator();
  const result = allocate(
    [
      { task_key: "EXISTING", status: "GENERATED", move_qty: 10, pic: "MP A" },
      { task_key: "T08", status: "GENERATED", move_qty: 8, pic: "" },
      { task_key: "T02", status: "GENERATED", move_qty: 2, pic: "" },
      { task_key: "DRAFT", status: "DRAFT", move_qty: 99, pic: "" },
    ],
    [
      { name: "MP A", shift: "MASUK" },
      { name: "MP B", shift: "MASUK" },
      { name: "MP C", shift: "OFF" },
      { name: "mp b", shift: "MASUK" },
    ],
  );

  assert.deepEqual(
    Array.from(result.assignments, ({ task_key, pic }) => ({ task_key, pic })),
    [
      { task_key: "T08", pic: "MP B" },
      { task_key: "T02", pic: "MP B" },
    ],
  );
  assert.deepEqual(Array.from(result.workloads, ({ name, existing_qty, assigned_qty, total_qty }) => ({
    name,
    existing_qty,
    assigned_qty,
    total_qty,
  })), [
    { name: "MP A", existing_qty: 10, assigned_qty: 0, total_qty: 10 },
    { name: "MP B", existing_qty: 0, assigned_qty: 10, total_qty: 10 },
  ]);
});

test("planogram assignment proxy uses dedicated GAS actions", { concurrency: false }, async () => {
  const previousUrl = process.env.REPLENISHMENT_GAS_URL;
  const previousFetch = global.fetch;
  process.env.REPLENISHMENT_GAS_URL = "https://example.test/gas";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        status: options.method === "GET" ? "PREVIEW" : "SUCCESS",
        manpower_count: 2,
        eligible_task_count: 3,
        eligible_qty: 30,
        workloads: [],
      }),
    };
  };

  try {
    const preview = await fetchPlanogramAssignmentPreview();
    const assigned = await postPlanogramAutoAssign();
    assert.equal(preview.status, "PREVIEW");
    assert.equal(assigned.status, "SUCCESS");
    assert.match(calls[0].url, /action=planogram_assignment_preview/);
    assert.equal(calls[0].options.method, "GET");
    assert.deepEqual(JSON.parse(calls[1].options.body), { kind: "planogram_auto_assign" });
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.REPLENISHMENT_GAS_URL;
    else process.env.REPLENISHMENT_GAS_URL = previousUrl;
  }
});

test("planogram assignment API exposes preview and auto-assign", { concurrency: false }, async () => {
  const handler = require("../api/planogram-assignment");
  const previousUrl = process.env.REPLENISHMENT_GAS_URL;
  const previousFetch = global.fetch;
  process.env.REPLENISHMENT_GAS_URL = "https://example.test/gas";
  const gasCalls = [];
  global.fetch = async (url, options) => {
    gasCalls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "PREVIEW", workloads: [] }),
    };
  };

  function response() {
    return {
      statusCode: 0,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }

  try {
    const getRes = response();
    await handler({ method: "GET" }, getRes);
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.headers["Cache-Control"], "no-store");
    assert.equal(getRes.body.status, "PREVIEW");

    const postRes = response();
    await handler({ method: "POST" }, postRes);
    assert.equal(postRes.statusCode, 200);
    assert.deepEqual(JSON.parse(gasCalls[1].options.body), { kind: "planogram_auto_assign" });
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.REPLENISHMENT_GAS_URL;
    else process.env.REPLENISHMENT_GAS_URL = previousUrl;
  }
});
