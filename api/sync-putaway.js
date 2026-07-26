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

function mergeTask(listRow, detailPayload) {
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
    staff_name: clean(detail.staff_name || listRow.staff_name),
    inbound_date: clean(listRow.inbound_date),
    pending_at: detail.pending_at || null,
    in_progress_at: detail.in_progress_at || null,
    completed_at: detail.completed_at || null,
    activities_json: detail.activities ? JSON.stringify(detail.activities) : null,
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

    for (const task of tasks) {
      await client.query(`
        INSERT INTO putaway_tasks_current (
          task_id, task_number, purchase_order_number, package_label,
          location_id, location_name, status, staff_name, inbound_date,
          pending_at, in_progress_at, completed_at, activities_json,
          last_seen_run_id, synced_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, CURRENT_TIMESTAMP
        )
      `, [
        task.task_id, task.task_number, task.purchase_order_number,
        task.package_label, task.location_id, task.location_name, task.status,
        task.staff_name, task.inbound_date, task.pending_at, task.in_progress_at,
        task.completed_at, task.activities_json, runId,
      ]);
    }

    if (detailedTaskIds.length) {
      await client.query(
        "DELETE FROM putaway_items_current WHERE task_id = ANY($1::BIGINT[])",
        [detailedTaskIds],
      );
    }
    for (const item of items) {
      await client.query(`
        INSERT INTO putaway_items_current (
          task_item_id, task_id, product_id, product_sku, product_name,
          product_image_url, qty, base_uom, carton_qty, carton_uom,
          from_rack_id, from_rack_name, to_rack_id, to_rack_name,
          staff_name, last_seen_run_id, synced_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP
        )
      `, [
        item.task_item_id, item.task_id, item.product_id, item.product_sku,
        item.product_name, item.product_image_url, item.qty, item.base_uom,
        item.carton_qty, item.carton_uom, item.from_rack_id,
        item.from_rack_name, item.to_rack_id, item.to_rack_name,
        item.staff_name, runId,
      ]);
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

    const maxPages = Number(process.env.WMS_PUTAWAY_MAX_PAGES || 30);
    const list = await fetchPutawayTasks({ maxPages });
    const existing = list.rows.length
      ? await client.query(
        "SELECT task_id, status FROM putaway_tasks_current WHERE task_id = ANY($1::BIGINT[])",
        [list.rows.map((row) => Number(row.id))],
      )
      : { rows: [] };
    const previous = new Map(
      existing.rows.map((row) => [Number(row.task_id), clean(row.status).toUpperCase()]),
    );
    const detailRows = list.rows.filter((row) => {
      const status = clean(row.status).toUpperCase();
      return ACTIVE_STATUSES.has(status)
        || !previous.has(Number(row.id))
        || previous.get(Number(row.id)) !== status;
    });

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
    const tasks = list.rows.map((row) => mergeTask(row, bundleById.get(Number(row.id))?.detail));
    const items = detailBundles.flatMap((bundle) =>
      bundle.items.map((item) => normalizeItem(bundle.taskId, item)),
    );

    const poNumbers = [...new Set(tasks
      .map((task) => task.purchase_order_number)
      .filter((number) => /^ID1\/PO[RX]\//i.test(number)))];
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
  replacePurchaseOrders,
};

module.exports._internal = {
  ensurePutawaySchema,
  executeSync,
};
