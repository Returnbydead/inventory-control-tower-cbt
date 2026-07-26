const SLA_MINUTES = 6 * 60;
const AT_RISK_MINUTES = 4 * 60;
const URGENT_MINUTES = 5 * 60;

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  const localIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text}+07:00`
    : text;
  const shortMatch = text.match(
    /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2})$/,
  );
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const date = shortMatch
    ? new Date(Date.UTC(
      2000 + Number(shortMatch[3]),
      months[shortMatch[2]],
      Number(shortMatch[1]),
      Number(shortMatch[4]) - 7,
      Number(shortMatch[5]),
    ))
    : new Date(localIso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function activityDate(activities, activityName, field = "start_date") {
  const activity = (activities || []).find(
    (entry) => String(entry?.activity_name || "").toUpperCase() === activityName,
  );
  return activity ? asDate(activity[field]) : null;
}

function classifyElapsed(elapsedMinutes) {
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < 0) return "NOT_STARTED";
  if (elapsedMinutes >= SLA_MINUTES) return "BREACHED";
  if (elapsedMinutes >= URGENT_MINUTES) return "URGENT";
  if (elapsedMinutes >= AT_RISK_MINUTES) return "AT_RISK";
  return "SAFE";
}

function calculateSla({ grnAt, completedAt, now = new Date(), isCompleted = false }) {
  const start = asDate(grnAt);
  const completed = asDate(completedAt);
  const end = completed || (isCompleted ? null : asDate(now));
  const deadline = start
    ? new Date(start.getTime() + SLA_MINUTES * 60000).toISOString()
    : null;
  if (!start || !end || end < start) {
    return {
      elapsed_minutes: null,
      remaining_minutes: null,
      sla_state: "NOT_STARTED",
      within_sla: null,
      sla_deadline_at: deadline,
      sla_outcome: null,
    };
  }

  const elapsedMinutes = Math.floor((end.getTime() - start.getTime()) / 60000);
  const withinSla = completed ? elapsedMinutes <= SLA_MINUTES : null;
  return {
    elapsed_minutes: elapsedMinutes,
    remaining_minutes: SLA_MINUTES - elapsedMinutes,
    sla_state: classifyElapsed(elapsedMinutes),
    within_sla: withinSla,
    sla_deadline_at: deadline,
    sla_outcome: withinSla === null ? null : withinSla ? "ACHIEVED" : "MISSED",
  };
}

function normalizePutawayDetail(detail) {
  const data = detail?.data || detail || {};
  const activities = Array.isArray(data.activities) ? data.activities : [];
  return {
    task_id: Number(data.id),
    task_number: String(data.task_number || "").trim(),
    purchase_order_number: String(data.purchase_order_number || "").trim(),
    location_id: Number(data.location_id),
    location_name: String(data.location_name || "").trim(),
    status: String(data.status || "").trim().toUpperCase(),
    staff_name: String(data.staff_name || "").trim(),
    pending_at: activityDate(activities, "PENDING"),
    in_progress_at: activityDate(activities, "IN_PROGRESS"),
    completed_at: activityDate(activities, "COMPLETED"),
    activities,
  };
}

function normalizePurchaseOrderDetail(detail) {
  const data = detail?.data || detail || {};
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    po_id: Number(data.id),
    purchase_order_number: String(data.purchase_order_number || "").trim(),
    status: String(data.status || "").trim().toUpperCase(),
    destination_id: Number(data.destination_id),
    destination_name: String(data.destination_name || "").trim(),
    vendor_name: String(data.vendor_name || "").trim(),
    request_shipping_at: asDate(data.request_shipping_date),
    received_at: asDate(data.received_at),
    grn_number: String(data.grn_number || "").trim(),
    requested_qty: items.reduce(
      (total, item) => total + (Number(item.request_quantity) || 0),
      0,
    ),
    actual_qty: items.reduce(
      (total, item) => total + (Number(item.actual_quantity) || 0),
      0,
    ),
    histories: Array.isArray(data.histories) ? data.histories : [],
  };
}

function priorityRank(slaState, hasTask = true) {
  const ranks = {
    BREACHED: 0,
    URGENT: 2,
    AT_RISK: 3,
    SAFE: 4,
    NOT_STARTED: 5,
  };
  if (!hasTask && slaState !== "BREACHED") return 1;
  return ranks[slaState] ?? 6;
}

module.exports = {
  SLA_MINUTES,
  classifyElapsed,
  calculateSla,
  normalizePutawayDetail,
  normalizePurchaseOrderDetail,
  priorityRank,
};
