const { getPool } = require("./sync-soh")._internal;
const { ensurePutawaySchema } = require("./sync-putaway")._internal;
const { calculateSla, priorityRank } = require("../lib/putaway-sla");

const ALLOWED_STATUS = new Set(["PENDING", "IN_PROGRESS", "COMPLETED"]);
const ALLOWED_SLA = new Set(["SAFE", "AT_RISK", "URGENT", "BREACHED", "NOT_STARTED"]);

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildDashboard(taskRows, itemRows, {
  now = new Date(),
  status = "",
  sla = "",
  limit = 250,
} = {}) {
  const itemsByTask = new Map();
  for (const row of itemRows) {
    const taskId = Number(row.task_id);
    const items = itemsByTask.get(taskId) || [];
    items.push({
      task_item_id: Number(row.task_item_id),
      product_sku: clean(row.product_sku),
      product_name: clean(row.product_name),
      product_image_url: clean(row.product_image_url) || null,
      qty: number(row.qty),
      base_uom: clean(row.base_uom),
      from_rack_name: clean(row.from_rack_name),
      to_rack_name: clean(row.to_rack_name),
    });
    itemsByTask.set(taskId, items);
  }

  const allTasks = taskRows.map((row) => {
    const status = clean(row.status).toUpperCase();
    const completedAt = iso(row.completed_at);
    const slaResult = calculateSla({
      grnAt: row.received_at,
      completedAt,
      now,
      isCompleted: status === "COMPLETED",
    });
    const items = itemsByTask.get(Number(row.task_id)) || [];
    return {
      task_id: Number(row.task_id),
      task_number: clean(row.task_number),
      purchase_order_number: clean(row.purchase_order_number),
      package_label: clean(row.package_label),
      status,
      staff_name: clean(row.staff_name) || null,
      pending_at: iso(row.pending_at),
      in_progress_at: iso(row.in_progress_at),
      completed_at: completedAt,
      received_at: iso(row.received_at),
      grn_number: clean(row.grn_number) || null,
      inbound_status: clean(row.inbound_status) || null,
      vendor_name: clean(row.vendor_name) || null,
      requested_qty: number(row.requested_qty),
      actual_qty: number(row.actual_qty),
      ...slaResult,
      priority_rank: priorityRank(slaResult.sla_state, true),
      sku_count: new Set(items.map((item) => item.product_sku).filter(Boolean)).size,
      total_qty: items.reduce((total, item) => total + item.qty, 0),
      items,
      synced_at: iso(row.synced_at),
    };
  });

  const summary = {
    total_tasks: allTasks.length,
    pending: 0,
    in_progress: 0,
    completed: 0,
    safe: 0,
    at_risk: 0,
    urgent: 0,
    breached: 0,
    not_started: 0,
    completed_within_sla: 0,
    completed_late: 0,
  };
  for (const task of allTasks) {
    if (task.status === "PENDING") summary.pending += 1;
    else if (task.status === "IN_PROGRESS") summary.in_progress += 1;
    else if (task.status === "COMPLETED") summary.completed += 1;

    const key = task.sla_state.toLowerCase();
    if (Object.hasOwn(summary, key)) summary[key] += 1;
    if (task.within_sla === true) summary.completed_within_sla += 1;
    if (task.within_sla === false) summary.completed_late += 1;
  }

  let filtered = allTasks;
  if (status) filtered = filtered.filter((task) => task.status === status);
  if (sla) filtered = filtered.filter((task) => task.sla_state === sla);
  filtered.sort((left, right) =>
    left.priority_rank - right.priority_rank
    || (right.elapsed_minutes ?? -1) - (left.elapsed_minutes ?? -1)
    || right.task_id - left.task_id,
  );

  const snapshotAt = allTasks.reduce(
    (latest, task) => task.synced_at && (!latest || task.synced_at > latest)
      ? task.synced_at
      : latest,
    null,
  );
  return {
    snapshot_at: snapshotAt,
    official_sla_minutes: 360,
    clock_basis: "24x7 calendar time",
    summary,
    total_filtered: filtered.length,
    tasks: filtered.slice(0, limit),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }
  const status = clean(req.query.status).toUpperCase();
  const sla = clean(req.query.sla).toUpperCase();
  const limit = Math.min(Math.max(number(req.query.limit) || 250, 1), 500);
  if (status && !ALLOWED_STATUS.has(status)) {
    return res.status(400).json({ ok: false, message: "Status filter tidak valid." });
  }
  if (sla && !ALLOWED_SLA.has(sla)) {
    return res.status(400).json({ ok: false, message: "SLA filter tidak valid." });
  }

  let client;
  try {
    client = await getPool().connect();
    await ensurePutawaySchema(client);
    const [tasks, items, lastRun] = await Promise.all([
      client.query(`
        SELECT
          t.task_id, t.task_number, t.purchase_order_number, t.package_label,
          t.status, t.staff_name, t.pending_at, t.in_progress_at,
          t.completed_at, t.synced_at,
          p.status AS inbound_status, p.received_at, p.grn_number,
          p.vendor_name, p.requested_qty, p.actual_qty
        FROM putaway_tasks_current t
        LEFT JOIN inbound_po_current p
          ON p.purchase_order_number = t.purchase_order_number
        WHERE t.location_id = 819
      `),
      client.query(`
        SELECT
          task_item_id, task_id, product_sku, product_name, product_image_url,
          qty, base_uom, from_rack_name, to_rack_name
        FROM putaway_items_current
      `),
      client.query(`
        SELECT status, started_at, finished_at, error_code, error_message
        FROM putaway_sync_runs
        ORDER BY started_at DESC
        LIMIT 1
      `),
    ]);
    const dashboard = buildDashboard(tasks.rows, items.rows, { status, sla, limit });
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({
      ok: true,
      sync: lastRun.rows[0] || null,
      coverage_note: "GRN without any Putaway task is not included in this MVP query.",
      ...dashboard,
    });
  } catch (error) {
    console.error("Putaway dashboard query failed", { message: error.message });
    return res.status(500).json({
      ok: false,
      message: "Putaway dashboard query failed",
    });
  } finally {
    client?.release();
  }
};

module.exports._test = { buildDashboard };
