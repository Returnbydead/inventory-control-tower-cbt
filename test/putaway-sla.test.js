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

test("uses the official one-hour SLA across 24 calendar hours", () => {
  assert.equal(SLA_MINUTES, 60);
  assert.equal(classifyElapsed(39), "SAFE");
  assert.equal(classifyElapsed(40), "AT_RISK");
  assert.equal(classifyElapsed(50), "URGENT");
  assert.equal(classifyElapsed(60), "BREACHED");
  assert.equal(classifyElapsed(2880), "BREACHED");
});

test("starts the one-hour SLA at IN_PROGRESS instead of GR or PENDING", () => {
  assert.equal(SLA_MINUTES, 60);
  assert.deepEqual(calculateSla({
    inProgressAt: "2026-08-20T10:00:00+07:00",
    now: new Date("2026-08-20T10:50:00+07:00"),
  }), {
    elapsed_minutes: 50,
    remaining_minutes: 10,
    sla_state: "URGENT",
    within_sla: null,
    sla_deadline_at: "2026-08-20T04:00:00.000Z",
    sla_outcome: null,
  });
});

test("calculates active SLA from IN_PROGRESS until now", () => {
  assert.deepEqual(calculateSla({
    inProgressAt: "2026-07-26T00:00:00+07:00",
    now: new Date("2026-07-26T00:50:00+07:00"),
  }), {
    elapsed_minutes: 50,
    remaining_minutes: 10,
    sla_state: "URGENT",
    within_sla: null,
    sla_deadline_at: "2026-07-25T18:00:00.000Z",
    sla_outcome: null,
  });
});

test("calculates completed task compliance", () => {
  const result = calculateSla({
    inProgressAt: "2026-07-26T00:00:00+07:00",
    completedAt: "2026-07-26T01:01:00+07:00",
  });
  assert.equal(result.within_sla, false);
  assert.equal(result.sla_outcome, "MISSED");
  assert.equal(result.remaining_minutes, -1);
});

test("does not fabricate an SLA result for completed task without completion time", () => {
  const result = calculateSla({
    isCompleted: true,
    now: new Date("2026-07-27T00:00:00+07:00"),
  });
  assert.equal(result.elapsed_minutes, null);
  assert.equal(result.sla_state, "NOT_STARTED");
  assert.equal(result.sla_outcome, null);
  assert.equal(result.sla_deadline_at, null);
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

test("derives DONE GR time from completed inbound history when the API omits received_at", () => {
  const po = normalizePurchaseOrderDetail({
    data: {
      id: 620305,
      purchase_order_number: "ID1/POR/2026070000527893",
      status: "COMPLETED",
      destination_id: 819,
      histories: [
        {
          activity_name: "RECEIVING",
          start_date: "2026-07-26T08:45:00",
          end_date: "2026-07-26T09:13:42",
        },
        {
          activity_name: "COMPLETED",
          start_date: "2026-07-26T09:13:42",
        },
      ],
      items: [{ actual_quantity: 18 }],
    },
  });
  assert.equal(po.received_at.toISOString(), "2026-07-26T02:13:42.000Z");
});

test("treats partially fulfilled inbound history as DONE GR", () => {
  const po = normalizePurchaseOrderDetail({
    data: {
      id: 620306,
      purchase_order_number: "ID1/POR/2026070000527894",
      status: "PARTIALLY_FULFILLED",
      destination_id: 819,
      histories: [{
        activity_name: "PARTIALLY_FULFILLED",
        start_date: "2026-07-26T10:20:00",
      }],
    },
  });
  assert.equal(po.received_at.toISOString(), "2026-07-26T03:20:00.000Z");
});

test("prioritizes breached and missing-task GRN records", () => {
  assert.equal(priorityRank("BREACHED"), 0);
  assert.equal(priorityRank("URGENT", false), 1);
  assert.equal(priorityRank("URGENT", true), 2);
});
