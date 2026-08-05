const { databaseName, getPool } = require("./sync-soh")._internal;
const { evaluateCategory, targetFor } = require("../lib/l1-placement");
const { fetchLivePlanogramRules } = require("../lib/planogram-live");

const ZONE_PATTERN = /^[A-Z]{2,3}\d$/;
const ALL_ZONES = "ALL";

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateRows(rows, planogramRules) {
  const locations = new Map();
  for (const row of rows) {
    const rackName = clean(row.rack_name);
    if (!rackName) continue;
    let location = locations.get(rackName);
    if (!location) {
      const target = targetFor(rackName, planogramRules);
      location = {
        rack_name: rackName,
        zone: clean(target.address?.zone || row.zone),
        rack_sequence: clean(target.address?.sequence ?? row.rack_sequence),
        aisle: clean(target.address?.aisle ?? row.aisle),
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
    const evaluation = evaluateCategory(rackName, row.l1_category_name, planogramRules);
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
    mapped_qty: 0,
    correct_qty: 0,
    no_target_qty: 0,
    stock_value: 0,
    wrong_qty: 0,
    wrong_value: 0,
  };
  for (const location of locations) {
    if (location.status === "COMPLIANT") {
      summary.compliant += 1;
      summary.mapped_qty += location.qty;
      summary.correct_qty += location.qty;
    } else if (location.status === "WRONG_L1") {
      summary.wrong_l1 += 1;
      summary.mapped_qty += location.qty;
      summary.correct_qty += Math.max(0, location.qty - location.wrong_qty);
    } else if (location.status === "NO_TARGET") {
      summary.no_target += 1;
      summary.no_target_qty += location.qty;
    }
    else if (location.status === "EXCLUDED") summary.excluded += 1;
    summary.qty += location.qty;
    summary.stock_value += location.stock_value;
    summary.wrong_qty += location.wrong_qty;
    summary.wrong_value += location.wrong_value;
  }
  return summary;
}

function summarizeByZone(locations) {
  const grouped = new Map();
  for (const location of locations) {
    const zone = clean(location.zone) || "UNMAPPED";
    const rows = grouped.get(zone) || [];
    rows.push(location);
    grouped.set(zone, rows);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([zone, rows]) => [zone, summarize(rows)]),
  );
}

async function activateReadDatabase(client, database = databaseName()) {
  await client.query(`USE ${database}`);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const requestedZones = clean(req.query.zones)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const zone = clean(req.query.zone).toUpperCase();
  const selectedZones = requestedZones.length ? [...new Set(requestedZones)] : [zone];
  const allZones = selectedZones.includes(ALL_ZONES);
  const summaryOnly = clean(req.query.summary) === "1";
  if (!allZones && (!selectedZones.length || selectedZones.some((value) => !ZONE_PATTERN.test(value)))) {
    return res.status(400).json({
      ok: false,
      message: "Parameter zone/zones wajib, contoh: SRA1 atau MZE2.",
    });
  }

  let client;
  try {
    const planogram = await fetchLivePlanogramRules();
    client = await getPool().connect();
    // This is a read endpoint. Schema creation also creates indexes and a
    // MotherDuck share, which can exceed a serverless request budget.
    await activateReadDatabase(client);
    const result = await client.query(`
      SELECT
        rack_name, zone, rack_sequence, aisle, rack_level,
        sku_number, l1_category_name, l2_category_name,
        stock, stock_value, synced_at
      FROM soh_current
      WHERE ($1 = 'ALL' OR UPPER(zone) = ANY($2::text[]))
        AND stock > 0
      ORDER BY rack_name, sku_number
    `, [allZones ? ALL_ZONES : "", selectedZones]);
    const locations = aggregateRows(result.rows, planogram.rules);
    const snapshotAt = result.rows.reduce((latest, row) => {
      const value = row.synced_at ? new Date(row.synced_at).toISOString() : null;
      return value && (!latest || value > latest) ? value : latest;
    }, null);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      zone: allZones ? ALL_ZONES : selectedZones.join(","),
      zones: allZones ? [ALL_ZONES] : selectedZones,
      snapshot_at: snapshotAt,
      planogram_source: planogram.source,
      planogram_rule_count: planogram.rule_count,
      empty_semantics: "Master SLOC absent from locations is EMPTY.",
      summary: summarize(locations),
      ...(allZones || selectedZones.length > 1 ? { zone_summaries: summarizeByZone(locations) } : {}),
      ...(!summaryOnly ? { locations } : {}),
    });
  } catch (error) {
    console.error("Rack status query failed", { selectedZones, message: error.message });
    return res.status(500).json({ ok: false, message: "Rack status query failed" });
  } finally {
    client?.release();
  }
};

module.exports._test = { aggregateRows, summarize, summarizeByZone, activateReadDatabase };
