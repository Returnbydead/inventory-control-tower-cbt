const { getPool, databaseName } = require("./sync-soh")._internal;
const { calculateSla, priorityRank } = require("../lib/putaway-sla");

const ALLOWED_STATUS = new Set(["PENDING", "IN_PROGRESS", "COMPLETED"]);
const ALLOWED_SLA = new Set(["SAFE", "AT_RISK", "URGENT", "BREACHED", "NOT_STARTED"]);
const ACTIVE_STATUSES = new Set(["PENDING", "IN_PROGRESS"]);

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

function jakartaDateKey(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isSalesOrder(value) {
  return /^INV\/SO\//i.test(clean(value));
}

function rackZone(rackName) {
  const rack = clean(rackName).toUpperCase();
  if (!rack) return "UNMAPPED";
  const cbtZone = rack.match(/^CBT-([A-Z]{3})/);
  if (cbtZone) return cbtZone[1];
  const zone = rack.match(/^([A-Z]{2,4})/);
  return zone ? zone[1] : "UNMAPPED";
}

function distinctCount(values) {
  return new Set(values.filter(Boolean)).size;
}

function summarize(tasks) {
  const summary = {
    total_tasks: tasks.length,
    total_qty: 0,
    total_assets: 0,
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
    done_gr_tasks: 0,
    done_gr_qty: 0,
    total_sku: 0,
    total_po: 0,
  };
  const sku = new Set();
  const po = new Set();
  const assets = new Set();
  for (const task of tasks) {
    summary.total_qty += task.total_qty;
    if (task.status === "PENDING") summary.pending += 1;
    else if (task.status === "IN_PROGRESS") summary.in_progress += 1;
    else if (task.status === "COMPLETED") summary.completed += 1;
    const key = task.sla_state.toLowerCase();
    if (Object.hasOwn(summary, key)) summary[key] += 1;
    if (task.within_sla === true) summary.completed_within_sla += 1;
    if (task.within_sla === false) summary.completed_late += 1;
    if (task.purchase_order_number) po.add(task.purchase_order_number);
    if (task.package_label) assets.add(task.package_label);
    for (const item of task.items) {
      if (item.product_sku) sku.add(item.product_sku);
    }
    if (task.received_at) {
      summary.done_gr_tasks += 1;
      summary.done_gr_qty += task.total_qty;
    }
  }
  summary.total_sku = sku.size;
  summary.total_po = po.size;
  summary.total_assets = assets.size;
  return summary;
}

function buildDashboard(taskRows, itemRows, {
  now = new Date(),
  status = "",
  sla = "",
  vendor = "",
  staff = "",
  zone = "",
  query = "",
  limit = 250,
  orphanGrnRows = [],
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
    const inboundReceivedAt = iso(row.received_at);
    const pendingAt = iso(row.pending_at);
    const inProgressAt = iso(row.in_progress_at);
    // Operational SLA starts only when WMS moves the task to IN_PROGRESS.
    // PO/GR and PENDING timestamps remain inbound context, not SLA fallbacks.
    const doneGrAt = pendingAt || inboundReceivedAt;
    const slaResult = calculateSla({
      inProgressAt,
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
      pending_at: pendingAt,
      in_progress_at: inProgressAt,
      completed_at: completedAt,
      received_at: doneGrAt,
      done_gr_source: pendingAt ? "PUTAWAY_PENDING" : inboundReceivedAt ? "INBOUND_PO" : null,
      grn_number: clean(row.grn_number) || null,
      inbound_status: clean(row.inbound_status) || null,
      vendor_name: clean(row.vendor_name) || null,
      requested_qty: number(row.requested_qty),
      actual_qty: number(row.actual_qty),
      ...slaResult,
      priority_rank: priorityRank(slaResult.sla_state, true),
      sku_count: new Set(items.map((item) => item.product_sku).filter(Boolean)).size,
      total_qty: items.reduce((total, item) => total + item.qty, 0),
      zones: [...new Set(items.map((item) => rackZone(item.to_rack_name)))],
      items,
      synced_at: iso(row.synced_at),
    };
  });

  // This ledger is the purchase-order Putaway report. Direct-sales (INV/SO)
  // work is intentionally excluded everywhere; active POR work remains in SLA
  // regardless of age, while completed POR work is Jakarta-today only.
  const operationalTasks = allTasks.filter((task) =>
    !isSalesOrder(task.purchase_order_number)
    && (
      ACTIVE_STATUSES.has(task.status)
      || (task.status === "COMPLETED" && jakartaDateKey(task.completed_at) === jakartaDateKey(now))
    )
  );

  let filtered = operationalTasks;
  if (status) filtered = filtered.filter((task) => task.status === status);
  if (sla) filtered = filtered.filter((task) => task.sla_state === sla);
  if (vendor) filtered = filtered.filter((task) => clean(task.vendor_name).toLowerCase() === vendor.toLowerCase());
  if (staff) filtered = filtered.filter((task) => clean(task.staff_name).toLowerCase() === staff.toLowerCase());
  if (zone) filtered = filtered.filter((task) => task.zones.includes(zone.toUpperCase()));
  if (query) {
    const needle = query.toLowerCase();
    filtered = filtered.filter((task) => [
      task.task_number,
      task.purchase_order_number,
      task.package_label,
      task.vendor_name,
      task.staff_name,
      task.grn_number,
      ...task.items.flatMap((item) => [
        item.product_sku,
        item.product_name,
        item.to_rack_name,
      ]),
    ].some((value) => clean(value).toLowerCase().includes(needle)));
  }

  const summary = summarize(filtered);

  const statusBreakdown = {};
  for (const key of ["PENDING", "IN_PROGRESS", "COMPLETED"]) {
    const rows = filtered.filter((task) => task.status === key);
    statusBreakdown[key.toLowerCase()] = {
      task_count: rows.length,
      qty: rows.reduce((sum, task) => sum + task.total_qty, 0),
      sku_count: distinctCount(rows.flatMap((task) => task.items.map((item) => item.product_sku))),
      po_count: distinctCount(rows.map((task) => task.purchase_order_number)),
      asset_count: distinctCount(rows.map((task) => task.package_label)),
    };
  }

  const activeTasks = filtered.filter((task) => task.status !== "COMPLETED");
  const completedTasks = filtered.filter((task) => task.status === "COMPLETED");
  const completedWithin = completedTasks.filter((task) => task.within_sla === true);
  const completedLate = completedTasks.filter((task) => task.within_sla === false);
  const completedQty = completedTasks.reduce((sum, task) => sum + task.total_qty, 0);
  const completedWithinQty = completedWithin.reduce((sum, task) => sum + task.total_qty, 0);
  const slaBreakdown = {
    active: Object.fromEntries(["SAFE", "AT_RISK", "URGENT", "BREACHED", "NOT_STARTED"].map((state) => {
      const rows = activeTasks.filter((task) => task.sla_state === state);
      return [state.toLowerCase(), {
        task_count: rows.length,
        qty: rows.reduce((sum, task) => sum + task.total_qty, 0),
      }];
    })),
    completed: {
      within_task_count: completedWithin.length,
      late_task_count: completedLate.length,
      within_qty: completedWithinQty,
      late_qty: completedLate.reduce((sum, task) => sum + task.total_qty, 0),
      task_percent: completedTasks.length ? completedWithin.length / completedTasks.length * 100 : 0,
      qty_percent: completedQty ? completedWithinQty / completedQty * 100 : 0,
    },
  };

  const groupTasks = (keyOf) => {
    const groups = new Map();
    for (const task of filtered) {
      const key = keyOf(task);
      const group = groups.get(key) || [];
      group.push(task);
      groups.set(key, group);
    }
    return groups;
  };

  const vendorBreakdown = [...groupTasks((task) => task.vendor_name || "Vendor belum linked")]
    .map(([vendorName, rows]) => ({
      vendor_name: vendorName,
      completed_tasks: rows.filter((task) => task.status === "COMPLETED").length,
      completed_qty: rows.filter((task) => task.status === "COMPLETED").reduce((sum, task) => sum + task.total_qty, 0),
      active_tasks: rows.filter((task) => task.status !== "COMPLETED").length,
      active_qty: rows.filter((task) => task.status !== "COMPLETED").reduce((sum, task) => sum + task.total_qty, 0),
      breached_tasks: rows.filter((task) => task.status !== "COMPLETED" && task.sla_state === "BREACHED").length,
    }))
    .sort((left, right) => (right.completed_qty + right.active_qty) - (left.completed_qty + left.active_qty));

  const manpowerBreakdown = [...groupTasks((task) => task.staff_name || "Belum assign")]
    .map(([staffName, rows]) => {
      const active = rows.filter((task) => task.status !== "COMPLETED");
      const completed = rows.filter((task) => task.status === "COMPLETED");
      return {
        staff_name: staffName,
        active_tasks: active.length,
        active_qty: active.reduce((sum, task) => sum + task.total_qty, 0),
        active_sku: distinctCount(active.flatMap((task) => task.items.map((item) => item.product_sku))),
        completed_tasks: completed.length,
        completed_qty: completed.reduce((sum, task) => sum + task.total_qty, 0),
        completed_sku: distinctCount(completed.flatMap((task) => task.items.map((item) => item.product_sku))),
        completed_within_sla: completed.filter((task) => task.within_sla === true).length,
        completed_late: completed.filter((task) => task.within_sla === false).length,
      };
    })
    .sort((left, right) => right.active_qty - left.active_qty || right.completed_qty - left.completed_qty);

  const rackMap = new Map();
  for (const task of activeTasks) {
    for (const item of task.items) {
      const rackName = item.to_rack_name || "Rack belum linked";
      const key = `${rackZone(item.to_rack_name)}|${rackName}`;
      const row = rackMap.get(key) || {
        zone: rackZone(item.to_rack_name),
        to_rack_name: rackName,
        active_task_ids: new Set(),
        active_qty: 0,
        sku: new Set(),
        breached_task_ids: new Set(),
        urgent_task_ids: new Set(),
      };
      row.active_task_ids.add(task.task_id);
      row.active_qty += item.qty;
      if (item.product_sku) row.sku.add(item.product_sku);
      if (task.sla_state === "BREACHED") row.breached_task_ids.add(task.task_id);
      if (task.sla_state === "URGENT") row.urgent_task_ids.add(task.task_id);
      rackMap.set(key, row);
    }
  }
  const rackBreakdown = [...rackMap.values()].map((row) => ({
    zone: row.zone,
    to_rack_name: row.to_rack_name,
    active_tasks: row.active_task_ids.size,
    active_qty: row.active_qty,
    sku_count: row.sku.size,
    breached_tasks: row.breached_task_ids.size,
    urgent_tasks: row.urgent_task_ids.size,
  })).sort((left, right) => right.active_qty - left.active_qty);

  const reconciliationMap = new Map();
  for (const task of filtered) {
    const key = task.purchase_order_number || `TASK:${task.task_id}`;
    const row = reconciliationMap.get(key) || {
      purchase_order_number: task.purchase_order_number || "PO belum linked",
      vendor_name: task.vendor_name || "Vendor belum linked",
      actual_qty: task.actual_qty,
      putaway_task_qty: 0,
      task_count: 0,
      asset_count: new Set(),
    };
    row.putaway_task_qty += task.total_qty;
    row.task_count += 1;
    if (task.package_label) row.asset_count.add(task.package_label);
    reconciliationMap.set(key, row);
  }
  const reconciliationRows = [...reconciliationMap.values()].map((row) => ({
    purchase_order_number: row.purchase_order_number,
    vendor_name: row.vendor_name,
    actual_qty: row.actual_qty,
    putaway_task_qty: row.putaway_task_qty,
    variance_qty: row.actual_qty - row.putaway_task_qty,
    task_count: row.task_count,
    asset_count: row.asset_count.size,
  })).sort((left, right) => Math.abs(right.variance_qty) - Math.abs(left.variance_qty));
  const reconciliation = {
    inbound_actual_qty: reconciliationRows.reduce((sum, row) => sum + row.actual_qty, 0),
    putaway_task_qty: reconciliationRows.reduce((sum, row) => sum + row.putaway_task_qty, 0),
    variance_qty: reconciliationRows.reduce((sum, row) => sum + row.variance_qty, 0),
    rows: reconciliationRows,
  };

  const sanitizedOrphans = orphanGrnRows.map((row) => ({
    purchase_order_number: clean(row.purchase_order_number) || null,
    grn_number: clean(row.grn_number) || null,
    vendor_name: clean(row.vendor_name) || null,
    received_at: iso(row.received_at),
    actual_qty: number(row.actual_qty),
  }));
  const compactException = (task) => ({
    task_id: task.task_id,
    task_number: task.task_number,
    purchase_order_number: task.purchase_order_number,
    package_label: task.package_label,
    status: task.status,
    staff_name: task.staff_name,
    received_at: task.received_at,
    vendor_name: task.vendor_name,
    total_qty: task.total_qty,
    sku_count: task.sku_count,
    sla_state: task.sla_state,
    remaining_minutes: task.remaining_minutes,
  });
  const exceptions = {
    summary: {
      grn_without_task: sanitizedOrphans.length,
      task_without_gr: filtered.filter((task) => !task.received_at).length,
      missing_po: filtered.filter((task) => !task.purchase_order_number).length,
      missing_asset: filtered.filter((task) => !task.package_label).length,
      missing_vendor: filtered.filter((task) => !task.vendor_name).length,
      unassigned_manpower: activeTasks.filter((task) => !task.staff_name).length,
    },
    grn_without_task: sanitizedOrphans,
    task_without_gr: filtered.filter((task) => !task.received_at).slice(0, 100).map(compactException),
    missing_links: filtered.filter((task) =>
      !task.purchase_order_number || !task.package_label || !task.vendor_name
    ).slice(0, 100).map(compactException),
    unassigned_manpower: activeTasks.filter((task) => !task.staff_name).slice(0, 100).map(compactException),
  };

  filtered.sort((left, right) =>
    left.priority_rank - right.priority_rank
    || (right.elapsed_minutes ?? -1) - (left.elapsed_minutes ?? -1)
    || right.task_id - left.task_id,
  );
  const priorityQueue = [...activeTasks].sort((left, right) =>
    left.priority_rank - right.priority_rank
    || (right.elapsed_minutes ?? -1) - (left.elapsed_minutes ?? -1)
    || right.task_id - left.task_id,
  );

  const snapshotAt = operationalTasks.reduce(
    (latest, task) => task.synced_at && (!latest || task.synced_at > latest)
      ? task.synced_at
      : latest,
    null,
  );
  return {
    snapshot_at: snapshotAt,
    official_sla_minutes: 60,
    clock_basis: "24x7 calendar time",
    scope: {
      active_statuses: ["PENDING", "IN_PROGRESS"],
      completed_window: "TODAY_ASIA_JAKARTA",
      included_po_prefix: "ID1/POR/",
      done_gr_basis: "WMS_PENDING_ACTIVITY",
      sla_start_basis: "WMS_IN_PROGRESS_ACTIVITY",
    },
    summary,
    status_breakdown: statusBreakdown,
    sla_breakdown: slaBreakdown,
    vendor_breakdown: vendorBreakdown,
    manpower_breakdown: manpowerBreakdown,
    rack_breakdown: rackBreakdown,
    reconciliation,
    exceptions,
    filters: {
      vendors: [...new Set(operationalTasks.map((task) => task.vendor_name).filter(Boolean))].sort(),
      staff: [...new Set(operationalTasks.map((task) => task.staff_name).filter(Boolean))].sort(),
      zones: [...new Set(operationalTasks.flatMap((task) => task.zones).filter((value) => value !== "UNMAPPED"))].sort(),
    },
    total_filtered: filtered.length,
    active_task_count: activeTasks.length,
    priority_queue: priorityQueue,
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
  const vendor = clean(req.query.vendor);
  const staff = clean(req.query.staff);
  const zone = clean(req.query.zone).toUpperCase();
  const query = clean(req.query.q);
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
    await client.query(`USE ${databaseName()}`);
    const [tasks, items, lastRun, orphanGrns] = await Promise.all([
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
          i.task_item_id, i.task_id, i.product_sku, i.product_name, i.product_image_url,
          i.qty, i.base_uom, i.from_rack_name, i.to_rack_name
        FROM putaway_items_current i
        INNER JOIN putaway_tasks_current t
          ON t.task_id = i.task_id
        WHERE t.location_id = 819
      `),
      client.query(`
        SELECT status, started_at, finished_at, error_code, error_message
        FROM putaway_sync_runs
        ORDER BY started_at DESC
        LIMIT 1
      `),
      client.query(`
        SELECT
          p.purchase_order_number, p.grn_number, p.vendor_name,
          p.received_at, p.actual_qty
        FROM inbound_po_current p
        LEFT JOIN putaway_tasks_current t
          ON t.purchase_order_number = p.purchase_order_number
          AND t.location_id = 819
        WHERE p.destination_id = 819
          AND p.received_at IS NOT NULL
          AND t.task_id IS NULL
        ORDER BY p.received_at ASC
        LIMIT 250
      `),
    ]);
    const dashboard = buildDashboard(tasks.rows, items.rows, {
      status,
      sla,
      vendor,
      staff,
      zone,
      query,
      limit,
      orphanGrnRows: orphanGrns.rows,
    });
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({
      ok: true,
      sync: lastRun.rows[0] || null,
      coverage_note: "GRN tanpa Putaway task terdeteksi dari inbound destination CBT.",
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
