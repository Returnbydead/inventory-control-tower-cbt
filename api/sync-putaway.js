const { randomUUID, timingSafeEqual } = require("crypto");
const { waitUntil } = require("@vercel/functions");
const { getPool, databaseName, ensureSchema: ensureSohSchema } = require("./sync-soh")._internal;
const {
  CBT_LOCATION_ID,
  fetchPutawayTasks,
  fetchPutawayDetail,
  fetchPutawayItems,
  fetchPurchaseOrders,
  fetchPurchaseOrderDetail,
} = require("../lib/wms-client");
const {
  normalizePutawayDetail,
  normalizePurchaseOrderDetail,
} = require("../lib/putaway-sla");

const ACTIVE_STATUSES = new Set(["PENDING", "IN_PROGRESS"]);
const DETAIL_CONCURRENCY = 6;
const ACTIVE_DETAIL_MAX_AGE_MINUTES = 15;

function clean(value) {
  return String(value ?? "").trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(clean(left));
  const b = Buffer.from(clean(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  const expected = clean(process.env.SYNC_SECRET);
  const authorization = clean(req.headers.authorization);
  const syncSecret = clean(req.headers["x-sync-secret"]);
  return Boolean(
    expected
    && (
      (authorization && safeEqual(authorization, `Bearer ${expected}`))
      || (syncSecret && safeEqual(syncSecret, expected))
    )
  );
}

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

async function ensurePutawaySchema(client) {
  await ensureSohSchema(client);
  const db = databaseName();
  await client.query(`USE ${db}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS putaway_tasks_current (
      task_id BIGINT PRIMARY KEY,
      task_number VARCHAR,
      purchase_order_number VARCHAR,
      package_label VARCHAR,
      location_id BIGINT,
      location_name VARCHAR,
      status VARCHAR,
      staff_name VARCHAR,
      inbound_date VARCHAR,
      pending_at TIMESTAMP,
      in_progress_at TIMESTAMP,
      completed_at TIMESTAMP,
      activities_json VARCHAR,
      last_seen_run_id VARCHAR NOT NULL,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS putaway_items_current (
      task_item_id BIGINT PRIMARY KEY,
      task_id BIGINT NOT NULL,
      product_id BIGINT,
      product_sku VARCHAR,
      product_name VARCHAR,
      product_image_url VARCHAR,
      qty DOUBLE,
      base_uom VARCHAR,
      carton_qty DOUBLE,
      carton_uom VARCHAR,
      from_rack_id BIGINT,
      from_rack_name VARCHAR,
      to_rack_id BIGINT,
      to_rack_name VARCHAR,
      staff_name VARCHAR,
      last_seen_run_id VARCHAR NOT NULL,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS putaway_sync_runs (
      run_id VARCHAR PRIMARY KEY,
      status VARCHAR NOT NULL,
      list_rows BIGINT DEFAULT 0,
      detail_rows BIGINT DEFAULT 0,
      item_rows BIGINT DEFAULT 0,
      po_rows BIGINT DEFAULT 0,
      unresolved_po_rows BIGINT DEFAULT 0,
      list_complete BOOLEAN DEFAULT FALSE,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      error_code VARCHAR,
      error_message VARCHAR
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS inbound_po_current (
      po_id BIGINT PRIMARY KEY,
      purchase_order_number VARCHAR,
      status VARCHAR,
      destination_id BIGINT,
      destination_name VARCHAR,
      vendor_name VARCHAR,
      request_shipping_at TIMESTAMP,
      received_at TIMESTAMP,
      grn_number VARCHAR,
      requested_qty DOUBLE,
      actual_qty DOUBLE,
      histories_json VARCHAR,
      last_seen_run_id VARCHAR NOT NULL,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS putaway_task_status_idx ON putaway_tasks_current(status)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS putaway_task_po_idx ON putaway_tasks_current(purchase_order_number)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS putaway_item_task_idx ON putaway_items_current(task_id)",
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS inbound_po_number_idx ON inbound_po_current(purchase_order_number)",
  );
}

async function mapConcurrent(values, concurrency, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        result[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return result;
}

function mergeTask(listRow, detailPayload, stored = {}) {
  const detail = detailPayload ? normalizePutawayDetail(detailPayload) : {};
  return {
    task_id: Number(listRow.id),
    task_number: clean(detail.task_number || listRow.task_number),
    purchase_order_number: clean(
      detail.purchase_order_number || listRow.purchase_order_number,
    ),
    package_label: clean(listRow.package_label),
    location_id: Number(detail.location_id || listRow.location_id),
    location_name: clean(detail.location_name || listRow.location_name),
    status: clean(detail.status || listRow.status).toUpperCase(),
    staff_name: clean(detail.staff_name || listRow.staff_name || stored.staff_name),
    inbound_date: clean(listRow.inbound_date),
    pending_at: detail.pending_at || stored.pending_at || null,
    in_progress_at: detail.in_progress_at || stored.in_progress_at || null,
    completed_at: detail.completed_at || stored.completed_at || null,
    activities_json: detail.activities
      ? JSON.stringify(detail.activities)
      : stored.activities_json || null,
  };
}

function normalizeItem(taskId, item) {
  return {
    task_item_id: Number(item.task_item_id),
    task_id: Number(taskId),
    product_id: Number(item.product_id) || null,
    product_sku: clean(item.product_sku),
    product_name: clean(item.product_name),
    product_image_url: clean(item.product_image?.url_medium),
    qty: Number(item.qty) || 0,
    base_uom: clean(item.base_uom),
    carton_qty: Number(item.carton_qty) || 0,
    carton_uom: clean(item.carton_uom),
    from_rack_id: Number(item.from_rack_id) || null,
    from_rack_name: clean(item.from_rack_name),
    to_rack_id: Number(item.to_rack_id) || null,
    to_rack_name: clean(item.to_rack_name),
    staff_name: clean(item.staff_name),
  };
}

function selectDetailRows(
  listRows,
  previous,
  newCompletedLimit = 20,
  detailLimit = 40,
  now = new Date(),
  activeDetailMaxAgeMinutes = ACTIVE_DETAIL_MAX_AGE_MINUTES,
) {
  const selected = [];
  const seen = new Set();
  const state = (row) => {
    const id = Number(row.id);
    const status = clean(row.status).toUpperCase();
    const prior = previous.get(id);
    const priorStatus = typeof prior === "object" ? prior?.status : clean(prior).toUpperCase();
    const needsBackfill = typeof prior === "object"
      ? !prior.has_detail
      : !prior;
    const priorSyncedAt = typeof prior === "object" ? new Date(prior?.synced_at || 0) : null;
    const staleActive = ACTIVE_STATUSES.has(status)
      && (!priorSyncedAt || Number.isNaN(priorSyncedAt.getTime())
        || now.getTime() - priorSyncedAt.getTime() >= activeDetailMaxAgeMinutes * 60_000);
    return {
      row,
      id,
      active: ACTIVE_STATUSES.has(status),
      changed: Boolean(priorStatus && priorStatus !== status),
      forceDetail: Boolean(row.force_detail),
      needsBackfill,
      staleActive,
      priorSyncedAt,
    };
  };
  const candidates = listRows.map(state);
  const add = (candidate) => {
    if (selected.length >= detailLimit || seen.has(candidate.id)) return false;
    selected.push(candidate.row);
    seen.add(candidate.id);
    return true;
  };

  // Explicit stale candidates and status transitions are always the freshest
  // operational signal. Stale candidates can come from the stored queue when
  // they are no longer present in the bounded WMS list response.
  for (const candidate of candidates
    .filter((item) => item.forceDetail || item.changed)
    .sort((left, right) => Number(right.forceDetail) - Number(left.forceDetail))) {
    add(candidate);
  }

  // Reserve capacity for both sides so a large active queue cannot starve
  // completed item/rack backfill indefinitely.
  const completedCapacity = Math.min(
    newCompletedLimit,
    Math.max(0, detailLimit - selected.length),
  );
  const activeCapacity = Math.max(
    0,
    detailLimit - selected.length - completedCapacity,
  );
  let activeAdded = 0;
  const activeCandidates = candidates
    .filter((candidate) => candidate.active && (candidate.needsBackfill || candidate.staleActive))
    .sort((left, right) => left.priorSyncedAt - right.priorSyncedAt);
  for (const candidate of activeCandidates) {
    if (activeAdded < activeCapacity) {
      if (add(candidate)) activeAdded += 1;
    }
  }
  let completedAdded = 0;
  for (const candidate of candidates) {
    if (!candidate.active && candidate.needsBackfill && completedAdded < completedCapacity) {
      if (add(candidate)) completedAdded += 1;
    }
  }
  return selected;
}

function selectSnapshotRows(listRows, recentLimit = 100) {
  return listRows.filter((row, index) => {
    const status = clean(row.status).toUpperCase();
    return index < recentLimit || ACTIVE_STATUSES.has(status);
  });
}

function selectPoNumbersForRefresh(tasks, stored = new Map(), limit = 75) {
  const candidates = [];
  const seen = new Set();
  const ordered = [...tasks].sort((left, right) => {
    const leftActive = ACTIVE_STATUSES.has(clean(left.status).toUpperCase());
    const rightActive = ACTIVE_STATUSES.has(clean(right.status).toUpperCase());
    return Number(rightActive) - Number(leftActive);
  });
  for (const task of ordered) {
    const poNumber = clean(task.purchase_order_number);
    if (
      candidates.length >= limit
      || seen.has(poNumber)
      || !/^ID1\/PO[RX]\//i.test(poNumber)
    ) continue;
    const current = stored.get(poNumber);
    if (!current || !current.received_at) {
      candidates.push(poNumber);
      seen.add(poNumber);
    }
  }
  return candidates;
}

async function replaceTaskRows(client, tasks, detailedTaskIds, items, runId, listComplete) {
  await client.query("BEGIN");
  try {
    if (listComplete) {
      await client.query(
        "DELETE FROM putaway_tasks_current WHERE location_id = $1",
        [CBT_LOCATION_ID],
      );
    } else if (tasks.length) {
      await client.query(
        "DELETE FROM putaway_tasks_current WHERE task_id = ANY($1::BIGINT[])",
        [tasks.map((task) => task.task_id)],
      );
    }

    for (let offset = 0; offset < tasks.length; offset += 100) {
      const batch = tasks.slice(offset, offset + 100);
      const values = [];
      const rows = batch.map((task, index) => {
        const base = index * 14;
        values.push(
          task.task_id, task.task_number, task.purchase_order_number,
          task.package_label, task.location_id, task.location_name, task.status,
          task.staff_name, task.inbound_date, task.pending_at, task.in_progress_at,
          task.completed_at, task.activities_json, runId,
        );
        return `(${Array.from({ length: 14 }, (_, parameter) => `$${base + parameter + 1}`).join(", ")}, CURRENT_TIMESTAMP)`;
      });
      await client.query(`
        INSERT INTO putaway_tasks_current (
          task_id, task_number, purchase_order_number, package_label,
          location_id, location_name, status, staff_name, inbound_date,
          pending_at, in_progress_at, completed_at, activities_json,
          last_seen_run_id, synced_at
        ) VALUES ${rows.join(", ")}
      `, values);
    }

    if (detailedTaskIds.length) {
      await client.query(
        "DELETE FROM putaway_items_current WHERE task_id = ANY($1::BIGINT[])",
        [detailedTaskIds],
      );
    }
    for (let offset = 0; offset < items.length; offset += 100) {
      const batch = items.slice(offset, offset + 100);
      const values = [];
      const rows = batch.map((item, index) => {
        const base = index * 16;
        values.push(
          item.task_item_id, item.task_id, item.product_id, item.product_sku,
          item.product_name, item.product_image_url, item.qty, item.base_uom,
          item.carton_qty, item.carton_uom, item.from_rack_id,
          item.from_rack_name, item.to_rack_id, item.to_rack_name,
          item.staff_name, runId,
        );
        return `(${Array.from({ length: 16 }, (_, parameter) => `$${base + parameter + 1}`).join(", ")}, CURRENT_TIMESTAMP)`;
      });
      await client.query(`
        INSERT INTO putaway_items_current (
          task_item_id, task_id, product_id, product_sku, product_name,
          product_image_url, qty, base_uom, carton_qty, carton_uom,
          from_rack_id, from_rack_name, to_rack_id, to_rack_name,
          staff_name, last_seen_run_id, synced_at
        ) VALUES ${rows.join(", ")}
      `, values);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function replacePurchaseOrders(client, purchaseOrders, runId) {
  if (!purchaseOrders.length) return;
  await client.query("BEGIN");
  try {
    await client.query(
      "DELETE FROM inbound_po_current WHERE po_id = ANY($1::BIGINT[])",
      [purchaseOrders.map((po) => po.po_id)],
    );
    for (const po of purchaseOrders) {
      await client.query(`
        INSERT INTO inbound_po_current (
          po_id, purchase_order_number, status, destination_id,
          destination_name, vendor_name, request_shipping_at, received_at,
          grn_number, requested_qty, actual_qty, histories_json,
          last_seen_run_id, synced_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, CURRENT_TIMESTAMP
        )
      `, [
        po.po_id, po.purchase_order_number, po.status, po.destination_id,
        po.destination_name, po.vendor_name, po.request_shipping_at,
        po.received_at, po.grn_number, po.requested_qty, po.actual_qty,
        JSON.stringify(po.histories), runId,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function executeSync(runId) {
  let client;
  try {
    client = await getPool().connect();
    await ensurePutawaySchema(client);

    const activeRun = await client.query(`
      SELECT run_id
      FROM putaway_sync_runs
      WHERE status = 'RUNNING'
        AND started_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
      LIMIT 1
    `);
    if (activeRun.rows.length) {
      console.info("Putaway sync skipped; another run is active", {
        runId,
        activeRunId: activeRun.rows[0].run_id,
      });
      return;
    }
    await client.query(
      "INSERT INTO putaway_sync_runs (run_id, status) VALUES ($1, 'RUNNING')",
      [runId],
    );

    // Keep the operational snapshot inside the Vercel function window.
    // Full historical backfill is handled separately from this live cron.
    // Active Putaway can be older than the newest 100 rows. Read enough list
    // pages to retain operational PENDING/IN_PROGRESS tasks, while the heavier
    // detail and item calls remain bounded below.
    const maxPages = Number(process.env.WMS_PUTAWAY_MAX_PAGES || 10);
    const detailLimit = Math.max(1, Number(process.env.WMS_DETAIL_BATCH_LIMIT || 10));
    const staleActiveDetailLimit = Math.min(
      detailLimit,
      Math.max(1, Number(process.env.WMS_STALE_ACTIVE_DETAIL_LIMIT || 5)),
    );
    const staleActiveMaxAgeMinutes = Math.max(
      1,
      Number(process.env.WMS_ACTIVE_DETAIL_MAX_AGE_MINUTES || ACTIVE_DETAIL_MAX_AGE_MINUTES),
    );
    const fetchedList = await fetchPutawayTasks({ maxPages });
    console.info("WMS putaway pagination trace", {
      maxPages,
      pages: fetchedList.pageTrace,
    });
    const list = {
      rows: selectSnapshotRows(fetchedList.rows),
      // This is an operational subset, not a full historical snapshot.
      complete: false,
    };
    const listTaskIds = new Set(list.rows.map((row) => Number(row.id)));
    const staleCutoff = new Date(
      Date.now() - staleActiveMaxAgeMinutes * 60_000,
    ).toISOString();
    // The WMS list is deliberately bounded for a fast live sync. Re-add a
    // small oldest-first slice of stored active work so it cannot stay stale
    // forever when it falls outside that list window.
    const staleActive = await client.query(`
      SELECT
        task_id AS id, task_number, purchase_order_number, package_label,
        location_id, location_name, status, staff_name, inbound_date,
        pending_at, in_progress_at, completed_at, activities_json, synced_at
      FROM putaway_tasks_current
      WHERE location_id = $1
        AND status IN ('PENDING', 'IN_PROGRESS')
        AND (synced_at IS NULL OR synced_at <= $2)
      ORDER BY synced_at ASC
      LIMIT $3
    `, [CBT_LOCATION_ID, staleCutoff, staleActiveDetailLimit]);
    const staleRows = staleActive.rows
      .filter((row) => !listTaskIds.has(Number(row.id)))
      .map((row) => ({ ...row, force_detail: true }));
    const sourceRows = [...list.rows, ...staleRows];
    const existing = sourceRows.length
      ? await client.query(
        `SELECT task_id, status, staff_name, pending_at, in_progress_at,
          completed_at, activities_json, synced_at,
          CASE WHEN activities_json IS NOT NULL THEN TRUE ELSE FALSE END AS has_detail
        FROM putaway_tasks_current
        WHERE task_id = ANY($1::BIGINT[])`,
        [sourceRows.map((row) => Number(row.id))],
      )
      : { rows: [] };
    const previous = new Map(
      existing.rows.map((row) => [Number(row.task_id), {
        status: clean(row.status).toUpperCase(),
        has_detail: Boolean(row.has_detail),
        staff_name: clean(row.staff_name),
        pending_at: row.pending_at || null,
        in_progress_at: row.in_progress_at || null,
        completed_at: row.completed_at || null,
        activities_json: row.activities_json || null,
        synced_at: row.synced_at || null,
      }]),
    );
    const detailRows = selectDetailRows(
      sourceRows,
      previous,
      Number(process.env.WMS_NEW_COMPLETED_DETAIL_LIMIT || 5),
      detailLimit,
      new Date(),
      staleActiveMaxAgeMinutes,
    );

    const detailBundles = await mapConcurrent(
      detailRows,
      DETAIL_CONCURRENCY,
      async (row) => {
        const [detail, items] = await Promise.all([
          fetchPutawayDetail(row.id),
          fetchPutawayItems(row.id),
        ]);
        return { taskId: Number(row.id), detail, items };
      },
    );
    const bundleById = new Map(
      detailBundles.map((bundle) => [bundle.taskId, bundle]),
    );
    const tasks = sourceRows.map((row) => mergeTask(
      row,
      bundleById.get(Number(row.id))?.detail,
      previous.get(Number(row.id)),
    ));
    const items = detailBundles.flatMap((bundle) =>
      bundle.items.map((item) => normalizeItem(bundle.taskId, item)),
    );

    const candidatePoNumbers = [...new Set(tasks
      .map((task) => task.purchase_order_number)
      .filter((number) => /^ID1\/PO[RX]\//i.test(number)))];
    const storedPoResult = candidatePoNumbers.length
      ? await client.query(`
        SELECT purchase_order_number, received_at
        FROM inbound_po_current
        WHERE purchase_order_number = ANY($1::VARCHAR[])
      `, [candidatePoNumbers])
      : { rows: [] };
    const storedPos = new Map(storedPoResult.rows.map((row) => [
      clean(row.purchase_order_number),
      { received_at: row.received_at || null },
    ]));
    const poNumbers = selectPoNumbersForRefresh(
      tasks,
      storedPos,
      Number(process.env.WMS_PO_REFRESH_LIMIT || 75),
    );
    const poList = await fetchPurchaseOrders({
      targetNumbers: poNumbers,
      maxPages: Number(process.env.WMS_PO_MAX_PAGES || 30),
    });
    const poDetails = await mapConcurrent(
      poList.rows,
      DETAIL_CONCURRENCY,
      async (row) => normalizePurchaseOrderDetail(
        await fetchPurchaseOrderDetail(row.id),
      ),
    );

    await replaceTaskRows(
      client,
      tasks,
      detailBundles.map((bundle) => bundle.taskId),
      items,
      runId,
      list.complete,
    );
    await replacePurchaseOrders(client, poDetails, runId);
    await client.query(`
      UPDATE putaway_sync_runs SET
        status = 'SUCCESS',
        list_rows = $2,
        detail_rows = $3,
        item_rows = $4,
        list_complete = $5,
        po_rows = $6,
        unresolved_po_rows = $7,
        finished_at = CURRENT_TIMESTAMP
      WHERE run_id = $1
    `, [
      runId, tasks.length, detailBundles.length, items.length, list.complete,
      poDetails.length, poList.unresolved.length,
    ]);
  } catch (error) {
    console.error("Putaway sync failed", {
      runId,
      code: error.code,
      message: error.message,
    });
    if (client) {
      try {
        await client.query(`
          UPDATE putaway_sync_runs SET
            status = 'FAILED',
            error_code = $2,
            error_message = $3,
            finished_at = CURRENT_TIMESTAMP
          WHERE run_id = $1
        `, [
          runId,
          clean(error.code).slice(0, 100),
          clean(error.message).slice(0, 1000),
        ]);
      } catch (logError) {
        console.error("Failed to persist Putaway sync error", logError);
      }
    }
  } finally {
    client?.release();
  }
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok: false, message: "Method not allowed" });
  }
  if (!authorized(req)) {
    return json(res, 401, { ok: false, message: "Unauthorized" });
  }
  const runId = randomUUID();
  waitUntil(executeSync(runId));
  return json(res, 202, { ok: true, status: "accepted", run_id: runId });
};

module.exports._test = {
  mergeTask,
  normalizeItem,
  mapConcurrent,
  selectDetailRows,
  selectPoNumbersForRefresh,
  selectSnapshotRows,
  replacePurchaseOrders,
};

module.exports._internal = {
  ensurePutawaySchema,
  executeSync,
};
