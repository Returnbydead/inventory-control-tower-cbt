const { createHash, randomUUID, timingSafeEqual } = require("crypto");
const { waitUntil } = require("@vercel/functions");
const { Pool } = require("pg");

const ROW_LIMIT = 100000;
const BATCH_SIZE = 250;
const SHARE_NAME = "inventory_cbt_org_share";
const DATABASE_PATTERN = /^[a-z][a-z0-9_]*$/i;

let pool;

function clean(value) {
  return String(value ?? "").trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(clean(left));
  const b = Buffer.from(clean(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function databaseName() {
  const value = clean(process.env.MOTHERDUCK_DATABASE || "inventory_cbt");
  if (!DATABASE_PATTERN.test(value)) {
    throw new Error("MOTHERDUCK_DATABASE hanya boleh berisi huruf, angka, dan underscore.");
  }
  return value;
}

function getPool() {
  if (pool) return pool;

  const token = clean(process.env.MOTHERDUCK_TOKEN);
  if (!token) throw new Error("MOTHERDUCK_TOKEN belum diset.");

  const host = clean(process.env.MOTHERDUCK_POSTGRES_HOST);
  if (host) {
    pool = new Pool({
      host,
      port: 5432,
      user: "postgres",
      password: token,
      database: "md:",
      max: 2,
      ssl: { rejectUnauthorized: true },
    });
    return pool;
  }

  const configuredUrl = clean(process.env.MOTHERDUCK_POSTGRES_URL);
  if (!configuredUrl) {
    throw new Error("MOTHERDUCK_POSTGRES_HOST atau MOTHERDUCK_POSTGRES_URL belum diset.");
  }

  const urlMatch = configuredUrl.match(/postgres(?:ql)?:\/\/[^\s'"`]+/i);
  const parsedUrl = new URL(urlMatch ? urlMatch[0] : configuredUrl);
  ["sslmode", "sslcert", "sslkey", "sslrootcert"].forEach((key) => {
    parsedUrl.searchParams.delete(key);
  });

  pool = new Pool({
    connectionString: parsedUrl.toString(),
    max: 2,
    ssl: { rejectUnauthorized: true },
  });
  return pool;
}

function supersetConfig() {
  const session = clean(process.env.SUPERSET_SESSION_COOKIE);
  if (!session) throw new Error("SUPERSET_SESSION_COOKIE belum diset.");
  return {
    baseUrl: clean(process.env.SUPERSET_BASE_URL || "https://dash.astronauts.id").replace(/\/$/, ""),
    cookie: session.startsWith("session=") ? session : `session=${session}`,
  };
}

const SOURCE_COLUMNS = [
  "location_name",
  "product_id",
  "sku_number",
  "product_name",
  "rack_name",
  "stock",
  "expiry_date",
  "l1_category_name",
  "l2_category_name",
  "package_label",
  "product_detail_status_name",
  "product_detail_updated_by",
  "product_detail_updated_at",
  "source_status",
  "stock_value",
  "rack_area_id",
];

function supersetPayload() {
  const filters = [
    { col: "lost_period_from", op: "TEMPORAL_RANGE", val: "No filter" },
    { col: "location_id", op: "IN", val: ["819"] },
    { col: "stock", op: ">", val: "0" },
    { col: "product_detail_status_name", op: "IN", val: ["Available"] },
    { col: "rack_name", op: "NOT IN", val: ["CONSUMABLES 4 (Aset)"] },
  ];

  return {
    datasource: { id: 273, type: "table" },
    force: true,
    queries: [{
      filters,
      extras: { having: "", where: "" },
      applied_time_extras: {},
      columns: SOURCE_COLUMNS,
      metrics: [],
      orderby: [],
      annotation_layers: [],
      row_limit: ROW_LIMIT,
      series_limit: 0,
      order_desc: true,
      url_params: { save_action: "saveas", slice_id: "21023" },
      custom_params: {},
      custom_form_data: {},
      post_processing: [],
      time_offsets: [],
    }],
    form_data: {
      datasource: "273__table",
      viz_type: "table",
      slice_id: 21023,
      query_mode: "aggregate",
      groupby: SOURCE_COLUMNS,
      metrics: [],
      adhoc_filters: filters.map((filter) => ({
        clause: "WHERE",
        comparator: filter.val,
        expressionType: "SIMPLE",
        operator: filter.op,
        subject: filter.col,
      })),
      row_limit: ROW_LIMIT,
      order_desc: true,
      result_format: "json",
      result_type: "full",
    },
    result_format: "json",
    result_type: "full",
  };
}

async function fetchSupersetRows() {
  const { baseUrl, cookie } = supersetConfig();
  const commonHeaders = {
    accept: "application/json",
    cookie,
    referer: `${baseUrl}/`,
  };

  const csrfResponse = await fetch(`${baseUrl}/api/v1/security/csrf_token/`, {
    headers: commonHeaders,
  });
  if (!csrfResponse.ok) {
    throw new Error(`Superset session/CSRF gagal: HTTP ${csrfResponse.status}`);
  }
  const csrfPayload = await csrfResponse.json();
  const csrfToken = clean(csrfPayload?.result);
  if (!csrfToken) throw new Error("Superset tidak mengembalikan CSRF token.");

  const chartResponse = await fetch(
    `${baseUrl}/api/v1/chart/data?form_data=${encodeURIComponent(JSON.stringify({ slice_id: 21023 }))}`,
    {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/json",
        "x-csrftoken": csrfToken,
      },
      body: JSON.stringify(supersetPayload()),
    },
  );

  if (!chartResponse.ok) {
    const detail = clean(await chartResponse.text()).slice(0, 300);
    throw new Error(`Superset chart gagal: HTTP ${chartResponse.status}${detail ? ` - ${detail}` : ""}`);
  }

  const payload = await chartResponse.json();
  const rows = payload?.result?.[0]?.data;
  if (!Array.isArray(rows)) {
    throw new Error("Format respons Superset tidak berisi result[0].data.");
  }
  if (rows.length === 0) {
    throw new Error("Superset mengembalikan 0 baris; snapshot lama dipertahankan.");
  }
  if (rows.length >= ROW_LIMIT) {
    throw new Error(`Superset mencapai row limit ${ROW_LIMIT}; snapshot tidak ditulis agar tidak terpotong.`);
  }
  return rows;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function deriveRack(rackName) {
  const rack = clean(rackName).toUpperCase();
  if (!rack) return { zone: "", rack_sequence: "", aisle: "", level: "" };
  const parts = rack.split("-");
  return {
    zone: parts[1] || "",
    rack_sequence: parts[2] || "",
    aisle: parts[3] || "",
    level: parts.find((part) => /^L\d+$/.test(part)) || "",
  };
}

function remarksZone(rackName, level) {
  const rack = clean(rackName).toUpperCase();
  if (!rack) return "LOST";
  if (rack.includes("PARKIR")) return "PARKIR";
  if (rack.includes("BADSTOCK")) return "BADSTOCK";
  if (rack.includes("PUTAWAY")) return "PUTAWAY";
  if (rack.includes("STG")) return "STAGING";
  if (/QR.*T/.test(rack)) return "QUARANTINE";
  if (rack.includes("CONSUMABLES")) return "CONSUMABLES";
  if (/(SRA1|SRB1|SRC1)/.test(rack)) return level === "L1" ? "PICKFACE" : "STORAGE";
  if (/(BF-TRANSIT|HR[AB]\d|MZ[A-G]\d|PL[AB]1|TRANSIT)/.test(rack)) return "PICKFACE";
  return "STORAGE";
}

function sourceRowKey(row) {
  return createHash("sha256").update(JSON.stringify([
    clean(row.location_name),
    clean(row.product_id),
    clean(row.sku_number),
    clean(row.rack_name),
    clean(row.expiry_date),
    clean(row.package_label),
    clean(row.product_detail_status_name),
    clean(row.source_status),
  ])).digest("hex");
}

function normalizeRow(row) {
  const rack = deriveRack(row.rack_name);
  return {
    source_row_key: sourceRowKey(row),
    location_name: clean(row.location_name) || null,
    product_id: clean(row.product_id) || null,
    sku_number: clean(row.sku_number) || null,
    product_name: clean(row.product_name) || null,
    rack_name: clean(row.rack_name) || null,
    stock: asNumber(row.stock),
    expiry_date: clean(row.expiry_date) || null,
    l1_category_name: clean(row.l1_category_name) || null,
    l2_category_name: clean(row.l2_category_name) || null,
    package_label: clean(row.package_label) || null,
    product_detail_status_name: clean(row.product_detail_status_name) || null,
    product_detail_updated_by: clean(row.product_detail_updated_by) || null,
    product_detail_updated_at: clean(row.product_detail_updated_at) || null,
    source_status: clean(row.source_status) || null,
    stock_value: asNumber(row.stock_value),
    rack_area_id: clean(row.rack_area_id) || null,
    zone: rack.zone || null,
    rack_sequence: rack.rack_sequence || null,
    aisle: rack.aisle || null,
    rack_level: rack.level || null,
    remarks_zone: remarksZone(row.rack_name, rack.level),
  };
}

async function ensureSchema(client) {
  const db = databaseName();
  await client.query(`CREATE DATABASE IF NOT EXISTS ${db}`);
  await client.query(`USE ${db}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS soh_current (
      source_row_key VARCHAR PRIMARY KEY,
      location_name VARCHAR,
      product_id VARCHAR,
      sku_number VARCHAR,
      product_name VARCHAR,
      rack_name VARCHAR,
      stock DOUBLE,
      expiry_date VARCHAR,
      l1_category_name VARCHAR,
      l2_category_name VARCHAR,
      package_label VARCHAR,
      product_detail_status_name VARCHAR,
      product_detail_updated_by VARCHAR,
      product_detail_updated_at VARCHAR,
      source_status VARCHAR,
      stock_value DOUBLE,
      rack_area_id VARCHAR,
      zone VARCHAR,
      rack_sequence VARCHAR,
      aisle VARCHAR,
      rack_level VARCHAR,
      remarks_zone VARCHAR,
      last_seen_run_id VARCHAR NOT NULL,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS soh_sync_runs (
      run_id VARCHAR PRIMARY KEY,
      status VARCHAR NOT NULL,
      fetched_rows BIGINT DEFAULT 0,
      unique_rows BIGINT DEFAULT 0,
      written_rows BIGINT DEFAULT 0,
      deleted_rows BIGINT DEFAULT 0,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finished_at TIMESTAMP,
      error_message VARCHAR
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS soh_current_rack_idx ON soh_current(rack_name)");
  await client.query("CREATE INDEX IF NOT EXISTS soh_current_sku_idx ON soh_current(sku_number)");
  await client.query("CREATE INDEX IF NOT EXISTS soh_current_zone_idx ON soh_current(zone)");
  await client.query(`
    CREATE SHARE IF NOT EXISTS ${SHARE_NAME}
    FROM ${db}
    (ACCESS ORGANIZATION, VISIBILITY DISCOVERABLE, UPDATE AUTOMATIC)
  `);
}

const DB_FIELDS = [
  "source_row_key", "location_name", "product_id", "sku_number", "product_name",
  "rack_name", "stock", "expiry_date", "l1_category_name", "l2_category_name",
  "package_label", "product_detail_status_name", "product_detail_updated_by",
  "product_detail_updated_at", "source_status", "stock_value", "rack_area_id",
  "zone", "rack_sequence", "aisle", "rack_level", "remarks_zone",
  "last_seen_run_id", "synced_at",
];

async function writeSnapshot(client, rawRows, runId) {
  const unique = new Map();
  for (const rawRow of rawRows) {
    const row = normalizeRow(rawRow);
    unique.set(row.source_row_key, row);
  }
  const rows = [...unique.values()];
  let written = 0;

  await client.query("BEGIN");
  try {
    // soh_current is a complete snapshot. Replacing it inside one transaction
    // avoids MotherDuck's PostgreSQL compatibility issue when a later sync
    // multi-row upserts keys that already exist.
    const deleted = await client.query("DELETE FROM soh_current");

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      const values = [];
      const placeholders = batch.map((row, rowIndex) => {
        const record = {
          ...row,
          last_seen_run_id: runId,
          synced_at: new Date().toISOString(),
        };
        const start = rowIndex * DB_FIELDS.length;
        values.push(...DB_FIELDS.map((field) => record[field]));
        return `(${DB_FIELDS.map((_, index) => `$${start + index + 1}`).join(",")})`;
      });

      await client.query(`
        INSERT INTO soh_current (${DB_FIELDS.join(",")})
        VALUES ${placeholders.join(",")}
      `, values);
      written += batch.length;
    }

    await client.query("COMMIT");
    return { uniqueRows: rows.length, written, deleted: deleted.rowCount || 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
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

async function executeSync(runId) {
  let client;
  try {
    client = await getPool().connect();
    await ensureSchema(client);

    const activeRun = await client.query(`
      SELECT run_id
      FROM soh_sync_runs
      WHERE status = 'RUNNING'
        AND started_at >= CURRENT_TIMESTAMP - INTERVAL '10 minutes'
      ORDER BY started_at DESC
      LIMIT 1
    `);
    if (activeRun.rows.length) {
      console.info("SOH sync skipped; another run is active", {
        runId,
        activeRunId: activeRun.rows[0].run_id,
      });
      return;
    }

    await client.query(
      "INSERT INTO soh_sync_runs (run_id, status) VALUES ($1, 'RUNNING')",
      [runId],
    );

    const rows = await fetchSupersetRows();
    const result = await writeSnapshot(client, rows, runId);
    await client.query(`
      UPDATE soh_sync_runs SET
        status = 'SUCCESS',
        fetched_rows = $2,
        unique_rows = $3,
        written_rows = $4,
        deleted_rows = $5,
        finished_at = CURRENT_TIMESTAMP
      WHERE run_id = $1
    `, [runId, rows.length, result.uniqueRows, result.written, result.deleted]);

    console.info("SOH sync completed", {
      runId,
      fetchedRows: rows.length,
      uniqueRows: result.uniqueRows,
      writtenRows: result.written,
      deletedRows: result.deleted,
    });
  } catch (error) {
    console.error("SOH sync failed", { runId, message: error.message });
    if (client) {
      try {
        await client.query(`
          UPDATE soh_sync_runs SET
            status = 'FAILED',
            error_message = $2,
            finished_at = CURRENT_TIMESTAMP
          WHERE run_id = $1
        `, [runId, clean(error.message).slice(0, 1000)]);
      } catch (logError) {
        console.error("Failed to persist sync error", logError);
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
  return json(res, 202, {
    ok: true,
    status: "accepted",
    run_id: runId,
  });
};

module.exports._test = {
  deriveRack,
  remarksZone,
  sourceRowKey,
  normalizeRow,
  supersetPayload,
};
