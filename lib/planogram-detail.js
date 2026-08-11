const {
  addressParts,
  evaluateCategory,
  normalizeCategory,
  placementRangesForCategory,
} = require("./l1-placement");
const { isExcludedOccupancyRack } = require("./occupancy-exclusions");

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value) {
  return Math.round(number(value) * 1000) / 1000;
}

function rowKey(row) {
  return [clean(row.sku_number), clean(row.rack_name), normalizeCategory(row.l1_category_name)].join("\u0000");
}

function aggregateSkuLocations(sourceRows, planogramRules) {
  const rows = new Map();
  for (const source of sourceRows || []) {
    const rackName = clean(source.rack_name);
    if (!rackName || isExcludedOccupancyRack(rackName) || number(source.stock) <= 0) continue;
    const key = rowKey(source);
    const current = rows.get(key) || {
      sku_number: clean(source.sku_number),
      product_name: clean(source.product_name),
      rack_name: rackName,
      zone: clean(source.zone),
      aisle: clean(source.aisle),
      rack_sequence: clean(source.rack_sequence),
      rack_level: clean(source.rack_level),
      l1_category_name: normalizeCategory(source.l1_category_name) || "Belum ada kategori L1",
      l2_category_name: clean(source.l2_category_name),
      stock: 0,
      stock_value: 0,
      source_rows: 0,
    };
    current.stock += number(source.stock);
    current.stock_value += number(source.stock_value);
    current.source_rows += number(source.source_rows) || 1;
    rows.set(key, current);
  }

  return [...rows.values()].map((row) => {
    const evaluation = evaluateCategory(row.rack_name, row.l1_category_name, planogramRules);
    const address = evaluation.address || addressParts(row.rack_name);
    return {
      ...row,
      zone: clean(address?.zone || row.zone),
      aisle: number(address?.aisle || row.aisle),
      rack_sequence: number(address?.sequence || row.rack_sequence),
      rack_level: address?.rackLevel ? `L${address.rackLevel}` : clean(row.rack_level),
      stock: rounded(row.stock),
      stock_value: Math.round(row.stock_value),
      allowed_l1: evaluation.allowed || [],
      status: evaluation.result,
      wrong_qty: evaluation.result === "WRONG_L1" ? rounded(row.stock) : 0,
      wrong_value: evaluation.result === "WRONG_L1" ? Math.round(row.stock_value) : 0,
    };
  });
}

function placementSuggestions(row, planogramRules) {
  if (row.status !== "WRONG_L1") return [];
  const category = normalizeCategory(row.l1_category_name);
  return placementRangesForCategory(category, planogramRules).map((range) => ({
    zone: range.zone,
    aisle: range.aisle_from,
    aisle_from: range.aisle_from,
    aisle_to: range.aisle_to,
    aisle_label: range.aisle_label,
    label: `${range.zone} · aisle ${range.aisle_label}`,
    reason: "Rule GSheet",
    source: range.source,
  }));
}

function buildPlanogramDetailRows(sourceRows, planogramRules) {
  const rows = aggregateSkuLocations(sourceRows, planogramRules);
  return rows.map((row) => ({
    ...row,
    suggestions: placementSuggestions(row, planogramRules),
  }));
}

function filterPlanogramDetailRows(rows, { status = "", query = "" } = {}) {
  const statusValue = clean(status).toUpperCase();
  const queryValue = clean(query).toLocaleLowerCase("id");
  return rows.filter((row) => (
    (!statusValue || row.status === statusValue)
    && (!queryValue || [
      row.sku_number,
      row.product_name,
      row.rack_name,
      row.zone,
      row.aisle,
      row.rack_sequence,
      row.l1_category_name,
      row.l2_category_name,
      ...(row.suggestions || []).flatMap((item) => [item.zone, item.aisle_label, item.label, item.reason]),
    ].join(" ").toLocaleLowerCase("id").includes(queryValue))
  ));
}

module.exports = {
  aggregateSkuLocations,
  buildPlanogramDetailRows,
  filterPlanogramDetailRows,
  placementSuggestions,
};
