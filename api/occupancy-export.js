const { databaseName, getPool } = require("./sync-soh")._internal;
const { evaluateCategory } = require("../lib/l1-placement");
const { storageType } = require("../lib/occupancy");
const { isExcludedOccupancyRack } = require("../lib/occupancy-exclusions");
const {
  buildPlanogramDetailRows,
  filterPlanogramDetailRows,
} = require("../lib/planogram-detail");
const { fetchLivePlanogramRules } = require("../lib/planogram-live");

const ALL_ZONES = "ALL";
const ZONE_PATTERN = /^[A-Z]{2,3}\d$/;
const PLANOGRAM_EXPORT_HEADERS = Object.freeze([
  "SKU Number",
  "Product Name",
  "Current Rack",
  "Zone",
  "Aisle",
  "Sequence",
  "Level",
  "Current L1 Produk",
  "Quantity",
  "Wrong Qty",
  "Kategori Target Rak Saat Ini",
  "Saran Placement",
  "Status",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function buildCsv(rows, { delimiter = ",", excelSeparator = false } = {}) {
  const separatorHint = excelSeparator ? `sep=${delimiter}\r\n` : "";
  return `\uFEFF${separatorHint}${rows
    .map((row) => row.map(csvValue).join(delimiter))
    .join("\r\n")}`;
}

function suggestionLabel(value) {
  return clean(value)
    .replaceAll("\u00c2\u00b7", "-")
    .replaceAll("\u00b7", "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
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

function l1Status(evaluation) {
  if (evaluation.result === "COMPLIANT") return "BENAR";
  if (evaluation.result === "WRONG_L1") return "SALAH";
  return "TIDAK ADA TARGET";
}

function exportRow(row, scope, snapshot, planogramRules) {
  const evaluation = evaluateCategory(row.rack_name, row.l1_category_name, planogramRules);
  return [
    scope,
    snapshot,
    storageType(row.zone),
    clean(row.zone),
    clean(row.rack_name),
    clean(row.aisle),
    clean(row.rack_sequence),
    clean(row.rack_level),
    clean(row.sku_number),
    clean(row.product_name),
    clean(row.l1_category_name),
    clean(row.l2_category_name),
    evaluation.allowed.join(" / "),
    l1Status(evaluation),
    evaluation.result,
    row.stock,
    row.stock_value,
    row.source_rows,
  ];
}

function planogramExportRow(row) {
  const suggestions = (row.suggestions || [])
    .slice(0, 4)
    .map((item) => suggestionLabel(item.label))
    .filter(Boolean)
    .join(" | ");

  return [
    clean(row.sku_number),
    clean(row.product_name),
    row.rack_name,
    row.zone,
    row.aisle,
    row.rack_sequence,
    row.rack_level,
    row.l1_category_name,
    row.stock,
    row.wrong_qty,
    (row.allowed_l1 || []).join(" / "),
    suggestions,
    row.status,
  ];
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
      ORDER BY zone, rack_name, sku_number
    `, [zones.includes(ALL_ZONES) ? ALL_ZONES : "", zones]);
    const rows = result.rows.filter((row) => !isExcludedOccupancyRack(row.rack_name));
    const snapshot = rows.reduce((latest, row) => {
      const value = row.snapshot_at ? new Date(row.snapshot_at).toISOString() : "";
      return value > latest ? value : latest;
    }, "");
    const scope = zones.includes(ALL_ZONES) ? ALL_ZONES : zones.join(",");
    const planogramDetail = clean(req.query.table).toLowerCase() === "planogram-sku-location";
    const headers = [[
      "Scope", "Snapshot", "Storage Area", "Zone", "SLOC / Rack", "Aisle", "Sequence", "Rack Level",
      "SKU", "Product Name", "L1 Aktual", "L2 Aktual", "Target L1", "Status L1", "Status Rule",
      "Qty", "Stock Value", "Source Rows",
    ]];
    const planogramHeaders = [PLANOGRAM_EXPORT_HEADERS];
    const csvRows = planogramDetail
      ? filterPlanogramDetailRows(buildPlanogramDetailRows(rows, planogram.rules), {
        status: req.query.status,
        query: req.query.q,
      }).map((row) => planogramExportRow(row))
      : rows.map((row) => exportRow(row, scope, snapshot, planogram.rules));
    const csv = buildCsv(
      [...(planogramDetail ? planogramHeaders : headers), ...csvRows],
      planogramDetail
        ? { delimiter: ";", excelSeparator: true }
        : { delimiter: "," },
    );
    const suffix = clean(req.query.table || "raw").replace(/[^a-z0-9_-]/gi, "-");
    const snapshotStamp = snapshot ? snapshot.replace(/[:.]/g, "-").slice(0, 19) : "snapshot";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="occupancy-${suffix}-${snapshotStamp}.csv"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error("Occupancy export query failed", { zones, message: error.message });
    return res.status(500).json({ ok: false, message: "Occupancy export query failed" });
  } finally {
    client?.release();
  }
};

module.exports._test = {
  exportRow,
  buildCsv,
  l1Status,
  PLANOGRAM_EXPORT_HEADERS,
  planogramExportRow,
  selectedZones,
  suggestionLabel,
};
