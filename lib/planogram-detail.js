const {
  addressParts,
  evaluateCategory,
  normalizeCategory,
  placementAreasForCategory,
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

function aggregateSkuLocations(sourceRows) {
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
    const evaluation = evaluateCategory(row.rack_name, row.l1_category_name);
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

function areaKey(zone, aisle) {
  return `${clean(zone).toUpperCase()}:${String(number(aisle)).padStart(2, "0")}`;
}

function addMetric(map, key, value) {
  map.set(key, number(map.get(key)) + number(value));
}

function placementContext(rows) {
  const skuQty = new Map();
  const l1Qty = new Map();
  for (const row of rows) {
    if (row.status !== "COMPLIANT") continue;
    const area = areaKey(row.zone, row.aisle);
    addMetric(skuQty, `${clean(row.sku_number)}\u0000${area}`, row.stock);
    addMetric(l1Qty, `${normalizeCategory(row.l1_category_name)}\u0000${area}`, row.stock);
  }
  return { skuQty, l1Qty };
}

function placementSuggestions(row, context, limit = 4) {
  if (row.status !== "WRONG_L1") return [];
  const category = normalizeCategory(row.l1_category_name);
  const candidates = placementAreasForCategory(category).map((candidate) => {
    const key = areaKey(candidate.zone, candidate.aisle);
    const skuNeighborQty = number(context.skuQty.get(`${clean(row.sku_number)}\u0000${key}`));
    const l1NeighborQty = number(context.l1Qty.get(`${category}\u0000${key}`));
    const sameZone = clean(candidate.zone) === clean(row.zone);
    const distance = sameZone ? Math.abs(number(row.aisle) - candidate.aisle) : 999;
    const score = (skuNeighborQty > 0 ? 1e12 : 0)
      + skuNeighborQty * 1e6
      + (l1NeighborQty > 0 ? 1e9 : 0)
      + l1NeighborQty * 100
      + (sameZone ? 1e7 - distance : 0);
    let reason = "Rule L1 valid";
    if (skuNeighborQty > 0) reason = `Teman SKU ${rounded(skuNeighborQty)} qty`;
    else if (l1NeighborQty > 0) reason = `Cluster L1 ${rounded(l1NeighborQty)} qty`;
    else if (sameZone) reason = "Rule valid terdekat";
    return {
      zone: candidate.zone,
      aisle: candidate.aisle,
      label: `${candidate.zone} · aisle ${String(candidate.aisle).padStart(2, "0")}`,
      reason,
      sku_neighbor_qty: rounded(skuNeighborQty),
      l1_neighbor_qty: rounded(l1NeighborQty),
      score,
    };
  }).sort((left, right) => right.score - left.score || left.zone.localeCompare(right.zone) || left.aisle - right.aisle);

  // Start with the strongest aisle from each zone so cross-zone choices stay
  // visible, then fill remaining slots with the next strongest valid aisles.
  const picked = [];
  const zones = new Set();
  for (const candidate of candidates) {
    if (zones.has(candidate.zone)) continue;
    picked.push(candidate);
    zones.add(candidate.zone);
    if (picked.length >= limit) break;
  }
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  return picked.map(({ score, ...candidate }) => candidate);
}

function buildPlanogramDetailRows(sourceRows) {
  const rows = aggregateSkuLocations(sourceRows);
  const context = placementContext(rows);
  return rows.map((row) => ({
    ...row,
    suggestions: placementSuggestions(row, context),
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
      ...(row.suggestions || []).flatMap((item) => [item.zone, item.aisle, item.reason]),
    ].join(" ").toLocaleLowerCase("id").includes(queryValue))
  ));
}

module.exports = {
  aggregateSkuLocations,
  buildPlanogramDetailRows,
  filterPlanogramDetailRows,
  placementContext,
  placementSuggestions,
};
