const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SLA_MINUTES,
  calculateSla,
  classifyElapsed,
  normalizePutawayDetail,
  normalizePurchaseOrderDetail,
  priorityRank,
} = require("../lib/putaway-sla");

test("uses the official six-hour SLA across 24 calendar hours", () => {
  assert.equal(SLA_MINUTES, 360);
  assert.equal(classifyElapsed(239), "SAFE");
  assert.equal(classifyElapsed(240), "AT_RISK");
  assert.equal(classifyElapsed(300), "URGENT");
  assert.equal(classifyElapsed(360), "BREACHED");
  assert.equal(classifyElapsed(2880), "BREACHED");
});

test("calculates active SLA from GRN until now", () => {
  assert.deepEqual(calculateSla({
    grnAt: "2026-07-26T00:00:00+07:00",
    now: new Date("2026-07-26T05:30:00+07:00"),
  }), {
    elapsed_minutes: 330,
    remaining_minutes: 30,
    sla_state: "URGENT",
    within_sla: null,
    sla_deadline_at: "2026-07-25T23:00:00.000Z",
    sla_outcome: null,
  });
});

test("calculates completed task compliance", () => {
  const result = calculateSla({
    grnAt: "2026-07-26T00:00:00+07:00",
    completedAt: "2026-07-26T06:01:00+07:00",
  });
  assert.equal(result.within_sla, false);
  assert.equal(result.sla_outcome, "MISSED");
  assert.equal(result.remaining_minutes, -1);
});

test("does not fabricate an SLA result for completed task without completion time", () => {
  const result = calculateSla({
    grnAt: "2026-07-26T00:00:00+07:00",
    isCompleted: true,
    now: new Date("2026-07-27T00:00:00+07:00"),
  });
  assert.equal(result.elapsed_minutes, null);
  assert.equal(result.sla_state, "NOT_STARTED");
  assert.equal(result.sla_outcome, null);
  assert.equal(result.sla_deadline_at, "2026-07-25T23:00:00.000Z");
});

test("normalizes WIMS task activities", () => {
  const task = normalizePutawayDetail({
    data: {
      id: 1015161,
      status: "COMPLETED",
      task_number: "ID1/PUT/1",
      purchase_order_number: "ID1/POR/1",
      location_id: 819,
      activities: [
        { activity_name: "PENDING", start_date: "2026-07-26T00:03:00+07:00" },
        { activity_name: "IN_PROGRESS", start_date: "2026-07-26T11:00:00+07:00" },
        { activity_name: "COMPLETED", start_date: "2026-07-26T11:22:00+07:00" },
      ],
    },
  });
  assert.equal(task.task_id, 1015161);
  assert.equal(task.completed_at.toISOString(), "2026-07-26T04:22:00.000Z");
});

test("normalizes completed PO GRN as Jakarta local time", () => {
  const po = normalizePurchaseOrderDetail({
    data: {
      id: 620305,
      purchase_order_number: "ID1/POR/1",
      status: "COMPLETED",
      destination_id: 819,
      received_at: "2026-07-26T09:13:42",
      grn_number: "ID1/GRN/1",
      items: [
        { request_quantity: 20, actual_quantity: 18 },
        { request_quantity: 5, actual_quantity: 5 },
      ],
    },
  });
  assert.equal(po.received_at.toISOString(), "2026-07-26T02:13:42.000Z");
  assert.equal(po.requested_qty, 25);
  assert.equal(po.actual_qty, 23);
});

test("prioritizes breached and missing-task GRN records", () => {
  assert.equal(priorityRank("BREACHED"), 0);
  assert.equal(priorityRank("URGENT", false), 1);
  assert.equal(priorityRank("URGENT", true), 2);
});
