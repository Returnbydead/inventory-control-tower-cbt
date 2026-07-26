const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDashboard } = require("../api/putaway-dashboard")._test;

test("builds SLA summary and prioritizes breached tasks", () => {
  const tasks = [
    {
      task_id: 1,
      status: "PENDING",
      received_at: "2026-07-26T00:00:00.000Z",
      synced_at: "2026-07-26T07:00:00.000Z",
    },
    {
      task_id: 2,
      status: "IN_PROGRESS",
      received_at: "2026-07-26T03:00:00.000Z",
      synced_at: "2026-07-26T07:00:00.000Z",
    },
  ];
  const dashboard = buildDashboard(tasks, [], {
    now: new Date("2026-07-26T07:00:00.000Z"),
  });
  assert.equal(dashboard.summary.breached, 1);
  assert.equal(dashboard.summary.at_risk, 1);
  assert.equal(dashboard.tasks[0].task_id, 1);
  assert.equal(dashboard.tasks[0].sla_deadline_at, "2026-07-26T06:00:00.000Z");
  assert.equal(dashboard.tasks[0].sla_outcome, null);
});

test("freezes completed SLA at completion and exposes achieved outcome", () => {
  const dashboard = buildDashboard([{
    task_id: 7,
    status: "COMPLETED",
    received_at: "2026-07-26T00:00:00.000Z",
    completed_at: "2026-07-26T05:30:00.000Z",
    synced_at: "2026-07-27T07:00:00.000Z",
  }], [], {
    now: new Date("2026-07-27T07:00:00.000Z"),
  });
  assert.equal(dashboard.tasks[0].elapsed_minutes, 330);
  assert.equal(dashboard.tasks[0].remaining_minutes, 30);
  assert.equal(dashboard.tasks[0].sla_outcome, "ACHIEVED");
});

test("includes task item SKU, quantity, and racks", () => {
  const dashboard = buildDashboard([{
    task_id: 1,
    status: "PENDING",
    synced_at: "2026-07-26T07:00:00.000Z",
  }], [{
    task_item_id: 10,
    task_id: 1,
    product_sku: "SKU-1",
    product_name: "Product",
    qty: 18,
    base_uom: "PCS",
    from_rack_name: "CBT-STG1",
    to_rack_name: "CBT-SRC1-18-03-L2-02",
  }]);
  assert.equal(dashboard.tasks[0].sku_count, 1);
  assert.equal(dashboard.tasks[0].total_qty, 18);
  assert.equal(dashboard.tasks[0].items[0].to_rack_name, "CBT-SRC1-18-03-L2-02");
});
