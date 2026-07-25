const { getPool, ensureSchema } = require("./sync-soh")._internal;
const { evaluateCategory, targetFor } = require("../lib/l1-placement");

const ZONE_PATTERN = /^[A-Z]{2,3}\d$/;

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateRows(rows) {
  const locations = new Map();
  for (const row of rows) {
    const rackName = clean(row.rack_name);
    if (!rackName) continue;
    let location = locations.get(rackName);
    if (!location) {
      const target = targetFor(rackName);
      location = {
        rack_name: rackName,
        zone: clean(row.zone),
        rack_sequence: clean(row.rack_sequence),
        aisle: clean(row.aisle),
        rack_level: clean(row.rack_level),
        status: target.status === "MAPPED" ? "COMPLIANT" : target.status,
        allowed_l1: target.allowed,
        mapping_source: target.source,
        qty: 0,
        stock_value: 0,
        wrong_qty: 0,
        wrong_value: 0,
        skus: new Set(),
        l1: new Set(),
        l2: new Set(),
      };
      locations.set(rackName, location);
    }

    const qty = number(row.stock);
    const value = number(row.stock_value);
    const evaluation = evaluateCategory(rackName, row.l1_category_name);
    location.qty += qty;
    location.stock_value += value;
    if (evaluation.result === "WRONG_L1") {
      location.status = "WRONG_L1";
      location.wrong_qty += qty;
      location.wrong_value += value;
    }
    if (row.sku_number) location.skus.add(clean(row.sku_number));
    if (row.l1_category_name) location.l1.add(clean(row.l1_category_name));
    if (row.l2_category_name) location.l2.add(clean(row.l2_category_name));
  }

  return [...locations.values()].map((location) => ({
    ...location,
    qty: Math.round(location.qty * 1000) / 1000,
    stock_value: Math.round(location.stock_value),
    wrong_qty: Math.round(location.wrong_qty * 1000) / 1000,
    wrong_value: Math.round(location.wrong_value),
    sku_count: location.skus.size,
    l1_categories: [...location.l1].sort(),
    l2_categories: [...location.l2].sort(),
    skus: undefined,
    l1: undefined,
    l2: undefined,
  }));
}

function summarize(locations) {
  const summary = {
    occupied: locations.length,
    compliant: 0,
    wrong_l1: 0,
    no_target: 0,
    excluded: 0,
    qty: 0,
    stock_value: 0,
    wrong_qty: 0,
    wrong_value: 0,
  };
  for (const location of locations) {
    if (location.status === "COMPLIANT") summary.compliant += 1;
    else if (location.status === "WRONG_L1") summary.wrong_l1 += 1;
    else if (location.status === "NO_TARGET") summary.no_target += 1;
    else if (location.status === "EXCLUDED") summary.excluded += 1;
    summary.qty += location.qty;
    summary.stock_value += location.stock_value;
    summary.wrong_qty += location.wrong_qty;
    summary.wrong_value += location.wrong_value;
  }
  return summary;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const zone = clean(req.query.zone).toUpperCase();
  if (!ZONE_PATTERN.test(zone)) {
    return res.status(400).json({
      ok: false,
      message: "Parameter zone wajib, contoh: SRA1 atau MZE2.",
    });
  }

  let client;
  try {
    client = await getPool().connect();
    await ensureSchema(client);
    const result = await client.query(`
      SELECT
        rack_name, zone, rack_sequence, aisle, rack_level,
        sku_number, l1_category_name, l2_category_name,
        stock, stock_value, synced_at
      FROM soh_current
      WHERE UPPER(zone) = $1
        AND stock > 0
      ORDER BY rack_name, sku_number
    `, [zone]);
    const locations = aggregateRows(result.rows);
    const snapshotAt = result.rows.reduce((latest, row) => {
      const value = row.synced_at ? new Date(row.synced_at).toISOString() : null;
      return value && (!latest || value > latest) ? value : latest;
    }, null);

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      ok: true,
      zone,
      snapshot_at: snapshotAt,
      empty_semantics: "Master SLOC absent from locations is EMPTY.",
      summary: summarize(locations),
      locations,
    });
  } catch (error) {
    console.error("Rack status query failed", { zone, message: error.message });
    return res.status(500).json({ ok: false, message: "Rack status query failed" });
  } finally {
    client?.release();
  }
};

module.exports._test = { aggregateRows, summarize };
