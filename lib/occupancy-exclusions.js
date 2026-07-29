const EXCLUDED_RACK_NAMES = Object.freeze([
  "RACK - CONSUMABLE",
  "CBT-ADJ-01-01-01",
  "SUPPLIES-CBT-01",
  "PARKIR-WTW-CBT",
  "CBT-STG1-GL-01-01-01",
  "CBT-STG1-IB-01-01-01",
  "CBT-STG1-LB-01-01-01",
  "CBT-STG1-LB-01-01-02",
  "CBT-STG1-RL-01-01-01",
]);

function normalizedRackName(value) {
  return String(value ?? "").trim().toUpperCase();
}

const EXCLUDED_RACK_SET = new Set(EXCLUDED_RACK_NAMES.map(normalizedRackName));

function isExcludedOccupancyRack(rackName) {
  return EXCLUDED_RACK_SET.has(normalizedRackName(rackName));
}

module.exports = {
  EXCLUDED_RACK_NAMES,
  isExcludedOccupancyRack,
};
