const { targetFor } = require("./l1-placement");

const DEFAULT_CAPACITY_BY_KEY = Object.freeze({
  HRAL1: 28, HRAL2: 72, HRAL3: 72, HRAL4: 72, HRAL5: 72,
  HRBL1: 28, HRBL2: 72, HRBL3: 72, HRBL4: 72, HRBL5: 72,
  MZAL1: 12, MZAL2: 24, MZAL3: 24, MZAL4: 24, MZAL5: 24,
  MZBL1: 12, MZBL2: 24, MZBL3: 24, MZBL4: 24, MZBL5: 24,
  MZCL1: 12, MZCL2: 24, MZCL3: 24, MZCL4: 24, MZCL5: 24,
  MZDL1: 12, MZDL2: 24, MZDL3: 24, MZDL4: 24, MZDL5: 24,
  MZEL1: 12, MZEL2: 24, MZEL3: 24, MZEL4: 24, MZEL5: 24,
  MZFL1: 12, MZFL2: 24, MZFL3: 24, MZFL4: 24, MZFL5: 24,
  PLAL1: 2000,
  SRAL1: 400, SRAL2: 400, SRAL3: 400, SRAL4: 400, SRAL5: 400, SRAL6: 400,
  SRBL1: 400, SRBL2: 400, SRBL3: 400, SRBL4: 400, SRBL5: 400, SRBL6: 400,
  SRCL1: 400, SRCL2: 400, SRCL3: 400, SRCL4: 400, SRCL5: 400, SRCL6: 400,
});

const L1_STORAGE_COLUMNS = Object.freeze([
  { key: "mezzanine", label: "Mezzanine", storage_type: "Mezzanine" },
  { key: "spr", label: "SPR", storage_type: "Selective Racks" },
  { key: "high_risk", label: "High Risk", storage_type: "Hi-Risk" },
]);

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function zoneFamily(zone) {
  return clean(zone).toUpperCase().replace(/\d+$/, "");
}

function levelNumber(level) {
  const match = clean(level).toUpperCase().match(/^L?(\d+)$/);
  return match ? Number(match[1]) : null;
}

function capacityKey(zone, level) {
  const family = zoneFamily(zone);
  const numericLevel = levelNumber(level);
  return family && numericLevel ? `${family}L${numericLevel}` : "";
}

function storageType(zone) {
  const family = zoneFamily(zone);
  if (family === "PLA" || family === "PLB") return "Pallet Floor";
  if (family.startsWith("MZ")) return "Mezzanine";
  if (family.startsWith("HR")) return "Hi-Risk";
  if (family.startsWith("SR")) return "Selective Racks";
  return "Other";
}

function decodeMaster(masterPayload) {
  const fields = masterPayload?.schema?.location_fields || [];
  const dictionaries = masterPayload?.dictionaries || {};
  const index = Object.fromEntries(fields.map((field, position) => [field, position]));
  return (masterPayload?.locations || []).map((row) => ({
    rack_name: clean(row[index.rack_name]),
    zone: clean(dictionaries.zone?.[row[index.zone_id]]),
    level: clean(dictionaries.level?.[row[index.level_id]]),
  })).filter((row) => row.rack_name);
}

function addMetric(map, key, base) {
  const current = map.get(key) || { ...base, space_qty: 0, used_qty: 0, wrong_qty: 0, location_count: 0 };
  map.set(key, current);
  return current;
}

function finalise(row) {
  const available_qty = row.space_qty - row.used_qty;
  const utilization_pct = row.space_qty ? (row.used_qty / row.space_qty) * 100 : null;
  return {
    ...row,
    space_qty: Math.round(row.space_qty * 1000) / 1000,
    used_qty: Math.round(row.used_qty * 1000) / 1000,
    wrong_qty: Math.round(row.wrong_qty * 1000) / 1000,
    available_qty: Math.round(available_qty * 1000) / 1000,
    utilization_pct: utilization_pct === null ? null : Math.round(utilization_pct * 100) / 100,
  };
}

function targetLabel(target) {
  if (target.status !== "MAPPED" || !target.allowed?.length) return "Belum ada target L1";
  return target.allowed.length === 1 ? target.allowed[0] : `Shared: ${target.allowed.join(" / ")}`;
}

function summarizeL1ByStorage(l1Rows) {
  const byTarget = new Map();
  for (const row of l1Rows) {
    const column = L1_STORAGE_COLUMNS.find((item) => item.storage_type === storageType(row.zone));
    if (!column) continue;
    const target = byTarget.get(row.target_l1) || {
      target_l1: row.target_l1,
      shared: row.shared,
      mezzanine: null,
      spr: null,
      high_risk: null,
    };
    const metrics = target[column.key] || {
      space_qty: 0,
      used_qty: 0,
      wrong_qty: 0,
      location_count: 0,
    };
    metrics.space_qty += row.space_qty;
    metrics.used_qty += row.used_qty;
    metrics.wrong_qty += row.wrong_qty;
    metrics.location_count += row.location_count;
    target[column.key] = metrics;
    byTarget.set(row.target_l1, target);
  }

  return [...byTarget.values()].map((row) => ({
    ...row,
    ...Object.fromEntries(L1_STORAGE_COLUMNS.map(({ key }) => [
      key,
      row[key] ? finalise(row[key]) : null,
    ])),
  })).sort((left, right) => left.target_l1.localeCompare(right.target_l1));
}

function summarizeOccupancy(masterPayload, liveByRack, capacityByKey = DEFAULT_CAPACITY_BY_KEY) {
  const zoneRows = new Map();
  const l1Rows = new Map();
  const l1CategoryRows = new Map();
  const unconfigured = new Map();
  const configuredRacks = new Set();
  const masterRacks = new Set();
  const selectedMaster = decodeMaster(masterPayload);

  for (const location of selectedMaster) {
    masterRacks.add(location.rack_name);
    const key = capacityKey(location.zone, location.level);
    const capacity = number(capacityByKey[key]);
    const live = liveByRack.get(location.rack_name) || { qty: 0, wrong_qty: 0 };
    if (!capacity) {
      const row = addMetric(unconfigured, key || "INVALID_ADDRESS", { capacity_key: key || "INVALID_ADDRESS" });
      row.used_qty += number(live.qty);
      row.wrong_qty += number(live.wrong_qty);
      row.location_count += 1;
      continue;
    }
    configuredRacks.add(location.rack_name);
    const zone = location.zone || "UNMAPPED";
    const zoneRow = addMetric(zoneRows, zone, { zone, storage_type: storageType(zone) });
    zoneRow.space_qty += capacity;
    zoneRow.used_qty += number(live.qty);
    zoneRow.wrong_qty += number(live.wrong_qty);
    zoneRow.location_count += 1;

    const target = targetFor(location.rack_name);
    const label = targetLabel(target);
    const l1Key = `${zone}\u0000${label}`;
    const l1Row = addMetric(l1Rows, l1Key, { zone, target_l1: label, shared: target.allowed?.length > 1 });
    l1Row.space_qty += capacity;
    l1Row.used_qty += number(live.qty);
    l1Row.wrong_qty += number(live.wrong_qty);
    l1Row.location_count += 1;

    // The L1 matrix intentionally keeps one category per row. A shared rack
    // contributes its capacity to every category that is allowed there; rows
    // must not be added together because they refer to the same shared pool.
    for (const category of target.allowed || []) {
      const categoryKey = `${zone}\u0000${category}`;
      const categoryRow = addMetric(l1CategoryRows, categoryKey, {
        zone,
        target_l1: category,
        shared: target.allowed.length > 1,
      });
      categoryRow.space_qty += capacity;
      categoryRow.location_count += 1;
    }

    // Usage is attributed to the actual SOH L1 category. This makes a wrong
    // placement visible in that category's storage column instead of hiding it
    // inside the rack's target category.
    for (const [category, usedQty] of live.qty_by_l1 || []) {
      const categoryKey = `${zone}\u0000${category}`;
      const categoryRow = addMetric(l1CategoryRows, categoryKey, {
        zone,
        target_l1: category,
        shared: target.allowed?.length > 1,
      });
      categoryRow.used_qty += number(usedQty);
      categoryRow.wrong_qty += number(live.wrong_qty_by_l1?.get(category));
    }
  }

  const unmasteredStock = [...liveByRack.entries()].reduce((total, [rackName, live]) => (
    masterRacks.has(rackName) ? total : total + number(live.qty)
  ), 0);
  const zones = [...zoneRows.values()].map(finalise).sort((a, b) => a.storage_type.localeCompare(b.storage_type) || a.zone.localeCompare(b.zone));
  const l1 = [...l1Rows.values()].map(finalise).sort((a, b) => a.zone.localeCompare(b.zone) || b.used_qty - a.used_qty || a.target_l1.localeCompare(b.target_l1));
  const l1_by_storage = summarizeL1ByStorage(l1);
  const l1_category = [...l1CategoryRows.values()].map(finalise).sort((a, b) => (
    a.zone.localeCompare(b.zone) || a.target_l1.localeCompare(b.target_l1)
  ));
  const l1_category_by_storage = summarizeL1ByStorage(l1_category);
  const unconfiguredRows = [...unconfigured.values()].map(finalise).sort((a, b) => b.used_qty - a.used_qty || a.capacity_key.localeCompare(b.capacity_key));
  const total = finalise(zones.reduce((summary, row) => ({
    storage_type: "Total", zone: "ALL", space_qty: summary.space_qty + row.space_qty,
    used_qty: summary.used_qty + row.used_qty, wrong_qty: summary.wrong_qty + row.wrong_qty,
    location_count: summary.location_count + row.location_count,
  }), { storage_type: "Total", zone: "ALL", space_qty: 0, used_qty: 0, wrong_qty: 0, location_count: 0 }));
  return {
    total,
    zones,
    l1,
    l1_by_storage,
    l1_category_by_storage,
    exceptions: zones.filter((row) => row.utilization_pct > 100).sort((a, b) => b.utilization_pct - a.utilization_pct),
    unconfigured: unconfiguredRows,
    unmastered_stock_qty: Math.round(unmasteredStock * 1000) / 1000,
  };
}

module.exports = {
  DEFAULT_CAPACITY_BY_KEY,
  capacityKey,
  storageType,
  L1_STORAGE_COLUMNS,
  decodeMaster,
  summarizeL1ByStorage,
  summarizeOccupancy,
};
