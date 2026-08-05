const { databaseName, getPool } = require("./sync-soh")._internal;
const {
  buildPlanogramDetailRows,
  filterPlanogramDetailRows,
} = require("../lib/planogram-detail");
const { fetchLivePlanogramRules } = require("../lib/planogram-live");

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

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  let zones;
  try {
    zones = selectedZones(req.query.zones || req.query.zone);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message });
  }

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

    const allRows = buildPlanogramDetailRows(result.rows, planogram.rules);
    const filtered = filterPlanogramDetailRows(allRows, {
      status: req.query.status,
      query: req.query.q,
    }).sort((left, right) => (
      (left.status === "WRONG_L1" ? -1 : 1) - (right.status === "WRONG_L1" ? -1 : 1)
      || right.wrong_value - left.wrong_value
      || right.stock - left.stock
      || left.rack_name.localeCompare(right.rack_name)
      || left.sku_number.localeCompare(right.sku_number)
    ));
    const snapshotAt = result.rows.reduce((latest, row) => {
      const value = row.snapshot_at ? new Date(row.snapshot_at).toISOString() : null;
      return value && (!latest || value > latest) ? value : latest;
    }, null);
    const limit = limitValue(req.query.limit);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      zones,
      snapshot_at: snapshotAt,
      planogram_source: planogram.source,
      planogram_rule_count: planogram.rule_count,
      grain: "1 row = 1 SKU x occupied location",
      total: filtered.length,
      limit,
      truncated: filtered.length > limit,
      rows: filtered.slice(0, limit),
    });
  } catch (error) {
    console.error("Planogram detail query failed", { zones, message: error.message });
    return res.status(500).json({ ok: false, message: "Planogram detail query failed" });
  } finally {
    client?.release();
  }
};

module.exports._test = { limitValue, selectedZones };
