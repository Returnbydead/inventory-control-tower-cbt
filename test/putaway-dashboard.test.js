const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDashboard } = require("../api/putaway-dashboard")._test;

test("builds SLA summary and prioritizes breached tasks", () => {
  const tasks = [
    {
      task_id: 1,
      status: "IN_PROGRESS",
      received_at: "2026-07-26T00:00:00.000Z",
      in_progress_at: "2026-07-26T05:30:00.000Z",
      synced_at: "2026-07-26T07:00:00.000Z",
    },
    {
      task_id: 2,
      status: "IN_PROGRESS",
      received_at: "2026-07-26T03:00:00.000Z",
      in_progress_at: "2026-07-26T06:20:00.000Z",
      synced_at: "2026-07-26T07:00:00.000Z",
    },
  ];
  const dashboard = buildDashboard(tasks, [], {
    now: new Date("2026-07-26T07:00:00.000Z"),
  });
  assert.equal(dashboard.summary.breached, 1);
  assert.equal(dashboard.summary.at_risk, 1);
  assert.equal(dashboard.tasks[0].task_id, 1);
  assert.equal(dashboard.tasks[0].sla_deadline_at, "2026-07-26T06:30:00.000Z");
  assert.equal(dashboard.tasks[0].sla_outcome, null);
});

test("keeps PENDING outside SLA and starts the clock at IN_PROGRESS", () => {
  const dashboard = buildDashboard([
    {
      task_id: 11,
      status: "PENDING",
      pending_at: "2026-08-20T00:00:00.000Z",
      received_at: "2026-08-19T23:00:00.000Z",
    },
    {
      task_id: 12,
      status: "IN_PROGRESS",
      pending_at: "2026-08-20T00:00:00.000Z",
      received_at: "2026-08-19T23:00:00.000Z",
      in_progress_at: "2026-08-20T06:30:00.000Z",
    },
  ], [], { now: new Date("2026-08-20T07:20:00.000Z") });

  const pending = dashboard.tasks.find((task) => task.task_id === 11);
  const inProgress = dashboard.tasks.find((task) => task.task_id === 12);
  assert.equal(pending.sla_state, "NOT_STARTED");
  assert.equal(pending.elapsed_minutes, null);
  assert.equal(inProgress.elapsed_minutes, 50);
  assert.equal(inProgress.remaining_minutes, 10);
  assert.equal(inProgress.sla_deadline_at, "2026-08-20T07:30:00.000Z");
  assert.equal(dashboard.official_sla_minutes, 60);
  assert.equal(dashboard.scope.sla_start_basis, "WMS_IN_PROGRESS_ACTIVITY");
});

test("freezes completed SLA at completion and exposes achieved outcome", () => {
  const dashboard = buildDashboard([{
    task_id: 7,
    status: "COMPLETED",
    received_at: "2026-07-26T00:00:00.000Z",
    in_progress_at: "2026-07-26T04:45:00.000Z",
    completed_at: "2026-07-26T05:30:00.000Z",
    synced_at: "2026-07-27T07:00:00.000Z",
  }], [], {
    now: new Date("2026-07-26T07:00:00.000Z"),
  });
  assert.equal(dashboard.tasks[0].elapsed_minutes, 45);
  assert.equal(dashboard.tasks[0].remaining_minutes, 15);
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

test("summarizes DONE GR quantity, distinct SKU, and distinct PO", () => {
  const dashboard = buildDashboard([
    {
      task_id: 1,
      status: "PENDING",
      purchase_order_number: "ID1/POR/1",
      received_at: "2026-07-26T00:00:00.000Z",
    },
    {
      task_id: 2,
      status: "IN_PROGRESS",
      purchase_order_number: "ID1/POR/1",
      received_at: "2026-07-26T00:30:00.000Z",
    },
    {
      task_id: 3,
      status: "COMPLETED",
      purchase_order_number: "ID1/POR/2",
      received_at: null,
      completed_at: "2026-07-26T00:45:00.000Z",
    },
  ], [
    { task_item_id: 11, task_id: 1, product_sku: "SKU-A", qty: 10 },
    { task_item_id: 12, task_id: 2, product_sku: "SKU-A", qty: 5 },
    { task_item_id: 13, task_id: 2, product_sku: "SKU-B", qty: 7 },
    { task_item_id: 14, task_id: 3, product_sku: "SKU-C", qty: 99 },
  ], { now: new Date("2026-07-26T01:00:00.000Z") });

  assert.equal(dashboard.summary.done_gr_qty, 22);
  assert.equal(dashboard.summary.total_sku, 3);
  assert.equal(dashboard.summary.total_po, 2);
  assert.equal(dashboard.summary.done_gr_tasks, 2);
});

test("keeps Putaway PENDING as inbound context without starting SLA", () => {
  const dashboard = buildDashboard([{
    task_id: 9,
    status: "PENDING",
    pending_at: "2026-07-26T00:02:00.000Z",
    received_at: null,
  }], [], { now: new Date("2026-07-26T01:02:00.000Z") });

  assert.equal(dashboard.tasks[0].received_at, "2026-07-26T00:02:00.000Z");
  assert.equal(dashboard.tasks[0].done_gr_source, "PUTAWAY_PENDING");
  assert.equal(dashboard.tasks[0].elapsed_minutes, null);
  assert.equal(dashboard.tasks[0].sla_state, "NOT_STARTED");
});

test("keeps only POR tasks and limits completed reporting to Jakarta today", () => {
  const dashboard = buildDashboard([
    {
      task_id: 1,
      status: "PENDING",
      purchase_order_number: "ID1/POR/ACTIVE",
      pending_at: "2026-07-28T15:00:00.000Z",
    },
    {
      task_id: 2,
      status: "IN_PROGRESS",
      purchase_order_number: "INV/SO/20260729/819/1",
      pending_at: "2026-07-28T15:00:00.000Z",
    },
    {
      task_id: 3,
      status: "COMPLETED",
      purchase_order_number: "ID1/POR/TODAY",
      pending_at: "2026-07-28T14:00:00.000Z",
      completed_at: "2026-07-28T17:30:00.000Z",
    },
    {
      task_id: 4,
      status: "COMPLETED",
      purchase_order_number: "ID1/POR/YESTERDAY",
      pending_at: "2026-07-27T14:00:00.000Z",
      completed_at: "2026-07-27T17:30:00.000Z",
    },
  ], [], { now: new Date("2026-07-28T18:00:00.000Z") });

  assert.equal(dashboard.summary.total_tasks, 2);
  assert.equal(dashboard.summary.pending, 1);
  assert.equal(dashboard.summary.in_progress, 0);
  assert.equal(dashboard.summary.completed, 1);
  assert.equal(dashboard.active_task_count, 1);
  assert.equal(dashboard.tasks.find((task) => task.task_id === 1).done_gr_source, "PUTAWAY_PENDING");
  assert.equal(dashboard.scope.included_po_prefix, "ID1/POR/");
});

test("builds complete operational aggregates before applying the task row limit", () => {
  const tasks = [
    {
      task_id: 1,
      task_number: "PUT-1",
      package_label: "ASSET-1",
      purchase_order_number: "PO-1",
      vendor_name: "Vendor A",
      staff_name: "Operator A",
      status: "COMPLETED",
      received_at: "2026-07-26T00:00:00.000Z",
      in_progress_at: "2026-07-26T04:30:00.000Z",
      completed_at: "2026-07-26T05:00:00.000Z",
      actual_qty: 30,
    },
    {
      task_id: 2,
      task_number: "PUT-2",
      package_label: "ASSET-2",
      purchase_order_number: "PO-1",
      vendor_name: "Vendor A",
      staff_name: "Operator A",
      status: "IN_PROGRESS",
      received_at: "2026-07-26T00:00:00.000Z",
      in_progress_at: "2026-07-26T05:00:00.000Z",
      actual_qty: 30,
    },
    {
      task_id: 3,
      task_number: "PUT-3",
      package_label: "ASSET-3",
      purchase_order_number: "PO-2",
      vendor_name: "Vendor B",
      status: "PENDING",
      received_at: "2026-07-26T06:00:00.000Z",
      actual_qty: 12,
    },
  ];
  const items = [
    { task_item_id: 1, task_id: 1, product_sku: "SKU-A", qty: 10, to_rack_name: "CBT-SRA1-01-01-L1-01" },
    { task_item_id: 2, task_id: 2, product_sku: "SKU-B", qty: 20, to_rack_name: "CBT-SRA1-01-01-L1-02" },
    { task_item_id: 3, task_id: 3, product_sku: "SKU-C", qty: 12, to_rack_name: "CBT-MZE1-03-05-L2-05" },
  ];

  const dashboard = buildDashboard(tasks, items, {
    now: new Date("2026-07-26T07:00:00.000Z"),
    limit: 1,
  });

  assert.equal(dashboard.tasks.length, 1);
  assert.equal(dashboard.total_filtered, 3);
  assert.equal(dashboard.active_task_count, 2);
  assert.deepEqual(dashboard.priority_queue.map((task) => task.task_id), [2, 3]);
  assert.equal(dashboard.summary.total_tasks, 3);
  assert.equal(dashboard.summary.total_qty, 42);
  assert.equal(dashboard.status_breakdown.completed.qty, 10);
  assert.equal(dashboard.status_breakdown.in_progress.qty, 20);
  assert.equal(dashboard.status_breakdown.pending.qty, 12);
  assert.equal(dashboard.vendor_breakdown[0].vendor_name, "Vendor A");
  assert.equal(dashboard.manpower_breakdown.find((row) => row.staff_name === "Operator A").active_qty, 20);
  assert.equal(dashboard.rack_breakdown.find((row) => row.zone === "SRA").active_qty, 20);
  assert.equal(dashboard.reconciliation.inbound_actual_qty, 42);
  assert.equal(dashboard.reconciliation.putaway_task_qty, 42);
});

test("filters every aggregate consistently and exposes filter options", () => {
  const dashboard = buildDashboard([
    {
      task_id: 1,
      task_number: "PUT-1",
      package_label: "ASSET-1",
      purchase_order_number: "PO-1",
      vendor_name: "Vendor A",
      staff_name: "Operator A",
      status: "IN_PROGRESS",
      received_at: "2026-07-26T00:00:00.000Z",
    },
    {
      task_id: 2,
      task_number: "PUT-2",
      package_label: "ASSET-2",
      purchase_order_number: "PO-2",
      vendor_name: "Vendor B",
      staff_name: "Operator B",
      status: "PENDING",
      received_at: "2026-07-26T06:30:00.000Z",
    },
  ], [
    { task_item_id: 1, task_id: 1, product_sku: "SKU-A", qty: 5, to_rack_name: "CBT-SRA1-01-01-L1-01" },
    { task_item_id: 2, task_id: 2, product_sku: "SKU-B", qty: 7, to_rack_name: "CBT-MZE1-03-05-L2-05" },
  ], {
    now: new Date("2026-07-26T07:00:00.000Z"),
    vendor: "Vendor B",
  });

  assert.equal(dashboard.total_filtered, 1);
  assert.equal(dashboard.summary.total_qty, 7);
  assert.deepEqual(dashboard.filters.vendors, ["Vendor A", "Vendor B"]);
  assert.deepEqual(dashboard.filters.staff, ["Operator A", "Operator B"]);
  assert.deepEqual(dashboard.filters.zones, ["MZE", "SRA"]);
});

test("reports missing links and inbound GR rows without a Putaway task", () => {
  const dashboard = buildDashboard([{
    task_id: 1,
    status: "PENDING",
    purchase_order_number: "",
    package_label: "",
    vendor_name: "",
    staff_name: "",
    received_at: null,
  }], [], {
    orphanGrnRows: [{
      purchase_order_number: "PO-X",
      grn_number: "GRN-X",
      vendor_name: "Vendor X",
      received_at: "2026-07-26T00:00:00.000Z",
      actual_qty: 99,
    }],
  });

  assert.equal(dashboard.exceptions.summary.grn_without_task, 1);
  assert.equal(dashboard.exceptions.summary.task_without_gr, 1);
  assert.equal(dashboard.exceptions.summary.missing_po, 1);
  assert.equal(dashboard.exceptions.summary.missing_asset, 1);
  assert.equal(dashboard.exceptions.summary.missing_vendor, 1);
  assert.equal(dashboard.exceptions.summary.unassigned_manpower, 1);
  assert.equal(dashboard.exceptions.grn_without_task[0].grn_number, "GRN-X");
});
