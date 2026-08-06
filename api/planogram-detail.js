const { databaseName, getPool } = require("./sync-soh")._internal;
const {
  buildPlanogramDetailRows,
  filterPlanogramDetailRows,
} = require("../lib/planogram-detail");
const { fetchLivePlanogramRules } = require("../lib/planogram-live");
const {
  annotatePlanogramRows,
  fetchPlanogramTaskLedger,
  normalizeSelectedTaskKeys,
  postPlanogramTasks,
  selectCurrentTasks,
  toPostedPlanogramTask,
} = require("../lib/planogram-tasks");

const ALL_ZONES = "ALL";
const ZONE_PATTERN = /^[A-Z]{2,3}\d$/;

function clean(value) {
  return String(value ?? "").trim();
}

function selectedZones(value) {
  const requested = clean(value || ALL_ZONES).toUpperCase()
    .split(",").map((item) => item.trim()).filter(Boolean);
  const zones = requested.includes(ALL_ZONES) ? [ALL_ZONES] : [...new Set(requested)];
  if (!zones.length || zones.some((zone) => zone !== ALL_ZONES && !ZONE_PATTERN.test(zone))) {
    throw new Error("Parameter zones wajib ALL atau daftar zone, contoh MZA1,MZB1.");
  }
  return zones;
}

function limitValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, Math.trunc(parsed))) : 500;
}

async function loadPlanogramRows(zones) {
  let client;
  try {
    const planogram = await fetchLivePlanogramRules();
    client = await getPool().connect();
    await client.query(`USE ${databaseName()}`);
    const result = await client.query(`
      SELECT
        sku_number, product_name, rack_name, zone, aisle, rack_sequence, rack_level,
        l1_category_name, l2_category_name,
        SUM(stock) AS stock,
        SUM(stock_value) AS stock_value,
        COUNT(*) AS source_rows,
        MAX(synced_at) AS snapshot_at
      FROM soh_current
      WHERE stock > 0 AND ($1 = 'ALL' OR UPPER(zone) = ANY($2::text[]))
      GROUP BY
        sku_number, product_name, rack_name, zone, aisle, rack_sequence, rack_level,
        l1_category_name, l2_category_name
    `, [zones.includes(ALL_ZONES) ? ALL_ZONES : "", zones]);

    const snapshotAt = result.rows.reduce((latest, row) => {
      const value = row.snapshot_at ? new Date(row.snapshot_at).toISOString() : null;
      return value && (!latest || value > latest) ? value : latest;
    }, null);
    return {
      rows: buildPlanogramDetailRows(result.rows, planogram.rules),
      snapshotAt,
      planogram,
    };
  } finally {
    client?.release();
  }
}

function sortRows(rows) {
  return rows.sort((left, right) => (
    Number(Boolean(right.task_eligible)) - Number(Boolean(left.task_eligible))
    || (left.status === "WRONG_L1" ? -1 : 1) - (right.status === "WRONG_L1" ? -1 : 1)
    || right.wrong_value - left.wrong_value
    || right.stock - left.stock
    || left.rack_name.localeCompare(right.rack_name)
    || left.sku_number.localeCompare(right.sku_number)
  ));
}

async function handleGet(req, res) {
  const zones = selectedZones(req.query.zones || req.query.zone);
  const loaded = await loadPlanogramRows(zones);
  const ledger = await fetchPlanogramTaskLedger();
  const filtered = filterPlanogramDetailRows(loaded.rows, {
    status: req.query.status,
    query: req.query.q,
  });
  const annotated = sortRows(annotatePlanogramRows(filtered, ledger.keys));
  const limit = limitValue(req.query.limit);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    zones,
    snapshot_at: loaded.snapshotAt,
    planogram_source: loaded.planogram.source,
    planogram_rule_count: loaded.planogram.rule_count,
    planogram_task_count: ledger.tasks.length,
    candidate_task_count: annotated.filter((row) => row.task_eligible).length,
    grain: "1 row = 1 SKU x occupied location",
    total: annotated.length,
    limit,
    truncated: annotated.length > limit,
    rows: annotated.slice(0, limit),
  });
}

async function handlePost(req, res) {
  const selectedKeys = normalizeSelectedTaskKeys(req.body?.task_keys);
  const loaded = await loadPlanogramRows([ALL_ZONES]);
  const ledger = await fetchPlanogramTaskLedger();
  const current = annotatePlanogramRows(loaded.rows, ledger.keys);
  const selected = selectCurrentTasks(current, selectedKeys);
  const result = await postPlanogramTasks(selected.map(toPostedPlanogramTask));

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    inserted: Number(result.inserted) || 0,
    skipped: Number(result.skipped) || 0,
    skipped_rows: Array.isArray(result.skipped_rows) ? result.skipped_rows : [],
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (error) {
    console.error("Planogram detail failed", { method: req.method, message: error.message });
    return res.status(Number(error.statusCode) || 500).json({
      ok: false,
      message: Number(error.statusCode) ? error.message : "Planogram detail gagal diproses",
    });
  }
};

module.exports._test = { limitValue, selectedZones, sortRows };
