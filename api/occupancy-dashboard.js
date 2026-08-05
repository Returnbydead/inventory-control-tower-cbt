const fs = require("node:fs/promises");
const path = require("node:path");
const { databaseName, getPool } = require("./sync-soh")._internal;
const { evaluateCategory, normalizeCategory } = require("../lib/l1-placement");
const { summarizeOccupancy } = require("../lib/occupancy");
const { isExcludedOccupancyRack } = require("../lib/occupancy-exclusions");
const { fetchLivePlanogramRules } = require("../lib/planogram-live");

const ALL_ZONES = "ALL";
const ZONE_PATTERN = /^[A-Z]{2,3}\d$/;
let masterPromise;

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadMaster() {
  masterPromise ||= fs.readFile(path.join(process.cwd(), "public", "data", "master-rack-index.json"), "utf8")
    .then(JSON.parse);
  return masterPromise;
}

function aggregateLiveRows(rows, planogramRules) {
  const byRack = new Map();
  for (const row of rows) {
    const rackName = clean(row.rack_name);
    if (!rackName || isExcludedOccupancyRack(rackName)) continue;
    const item = byRack.get(rackName) || {
      qty: 0,
      wrong_qty: 0,
      qty_by_l1: new Map(),
      wrong_qty_by_l1: new Map(),
      used_sloc_by_l1: new Set(),
    };
    const qty = number(row.stock);
    const category = normalizeCategory(row.l1_category_name) || "Belum ada kategori L1";
    item.qty += qty;
    item.qty_by_l1.set(category, number(item.qty_by_l1.get(category)) + qty);
    item.used_sloc_by_l1.add(category);
    if (evaluateCategory(rackName, row.l1_category_name, planogramRules).result === "WRONG_L1") {
      item.wrong_qty += qty;
      item.wrong_qty_by_l1.set(category, number(item.wrong_qty_by_l1.get(category)) + qty);
    }
    byRack.set(rackName, item);
  }
  return byRack;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }
  const requested = clean(req.query.zones || req.query.zone || ALL_ZONES).toUpperCase()
    .split(",").map((value) => value.trim()).filter(Boolean);
  const selectedZones = requested.includes(ALL_ZONES) ? [ALL_ZONES] : [...new Set(requested)];
  if (!selectedZones.length || selectedZones.some((zone) => zone !== ALL_ZONES && !ZONE_PATTERN.test(zone))) {
    return res.status(400).json({ ok: false, message: "Parameter zones wajib ALL atau daftar zone, contoh MZA1,MZB1." });
  }
  let client;
  try {
    const planogram = await fetchLivePlanogramRules();
    client = await getPool().connect();
    await client.query(`USE ${databaseName()}`);
    const result = await client.query(`
      SELECT rack_name, zone, l1_category_name, stock, synced_at
      FROM soh_current
      WHERE stock > 0 AND ($1 = 'ALL' OR UPPER(zone) = ANY($2::text[]))
    `, [selectedZones.includes(ALL_ZONES) ? ALL_ZONES : "", selectedZones]);
    const liveByRack = aggregateLiveRows(result.rows, planogram.rules);
    const master = await loadMaster();
    const allowedZones = selectedZones.includes(ALL_ZONES) ? null : new Set(selectedZones);
    const scopedMaster = allowedZones ? {
      ...master,
      locations: master.locations.filter((row) => {
        const zoneField = master.schema.location_fields.indexOf("zone_id");
        return allowedZones.has(String(master.dictionaries.zone?.[row[zoneField]] || "").toUpperCase());
      }),
    } : master;
    const dashboard = summarizeOccupancy(scopedMaster, liveByRack, undefined, planogram.rules);
    const snapshotAt = result.rows.reduce((latest, row) => {
      const value = row.synced_at ? new Date(row.synced_at).toISOString() : null;
      return value && (!latest || value > latest) ? value : latest;
    }, null);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      zones: selectedZones,
      available_zones: dashboard.zones.map((row) => row.zone),
      snapshot_at: snapshotAt,
      planogram_source: planogram.source,
      planogram_rule_count: planogram.rule_count,
      ...dashboard,
    });
  } catch (error) {
    console.error("Occupancy dashboard query failed", { selectedZones, message: error.message });
    return res.status(500).json({ ok: false, message: "Occupancy dashboard query failed" });
  } finally {
    client?.release();
  }
};

module.exports._test = { aggregateLiveRows, loadMaster };
