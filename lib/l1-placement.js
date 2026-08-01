const rulesPayload = require("../public/data/l1-placement-rules.json");

// Confirmed operational additions that intentionally make one L1 valid in
// more than one storage area. Keep these additive so the original workbook
// mapping remains traceable while current floor guidance can be applied.
const PLACEMENT_RULE_ADDITIONS = Object.freeze({
  "SRA1:12": ["Cokelat"],
  "MZC2:10": ["Cokelat"],
});

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeCategory(value) {
  const normalized = clean(value).replace(/\s+/g, " ").toLocaleLowerCase("en");
  return rulesPayload.category_normalization[normalized] || clean(value);
}

function addressParts(rackName) {
  const match = clean(rackName).toUpperCase().match(
    /^[^-]+-([A-Z]+\d+)-(\d+)-(\d+)-L(\d+)-([^-]+)$/,
  );
  if (!match) return null;
  return {
    zone: match[1],
    aisle: Number(match[2]),
    sequence: Number(match[3]),
    rackLevel: Number(match[4]),
    position: match[5],
  };
}

function targetFor(rackName) {
  const address = addressParts(rackName);
  if (!address) {
    return { status: "NO_TARGET", allowed: [], source: "", address: null };
  }
  const key = `${address.zone}:${String(address.aisle).padStart(2, "0")}`;
  const rule = rulesPayload.rules[key];
  if (!rule) {
    return { status: "NO_TARGET", allowed: [], source: "", address };
  }
  if (rule.excluded) {
    return { status: "EXCLUDED", allowed: [], source: rule.source, address };
  }
  const allowed = new Set([
    ...(rule.allowed || []),
    ...(PLACEMENT_RULE_ADDITIONS[key] || []),
  ]);
  // Rules are keyed by the first numeric component (physical aisle). The
  // SRC1 aisle-18 exception applies only to sequence 13-17, the second
  // numeric component. `bay_allowed` is kept as a read fallback for the
  // already-generated rules file.
  const sequenceAllowed = rule.sequence_allowed || rule.bay_allowed || {};
  for (const category of sequenceAllowed[String(address.sequence)] || []) {
    allowed.add(category);
  }
  if (!allowed.size) {
    return { status: "NO_TARGET", allowed: [], source: rule.source, address };
  }
  return { status: "MAPPED", allowed: [...allowed], source: rule.source, address };
}

function placementAreasForCategory(value) {
  const category = normalizeCategory(value);
  const areas = [];
  for (const [key, rule] of Object.entries(rulesPayload.rules || {})) {
    if (rule.excluded) continue;
    const [zone, aisleText] = key.split(":");
    const allowed = new Set([
      ...(rule.allowed || []),
      ...(PLACEMENT_RULE_ADDITIONS[key] || []),
    ]);
    for (const categories of Object.values(rule.sequence_allowed || rule.bay_allowed || {})) {
      for (const item of categories || []) allowed.add(item);
    }
    if (!allowed.has(category)) continue;
    areas.push({
      zone,
      aisle: Number(aisleText),
      source: rule.source || "Planogram placement rule",
    });
  }
  return areas.sort((left, right) => (
    left.zone.localeCompare(right.zone) || left.aisle - right.aisle
  ));
}

function evaluateCategory(rackName, actualCategory) {
  const target = targetFor(rackName);
  if (target.status !== "MAPPED") return { ...target, result: target.status };
  const actual = normalizeCategory(actualCategory);
  return {
    ...target,
    actual,
    result: target.allowed.includes(actual) ? "COMPLIANT" : "WRONG_L1",
  };
}

module.exports = {
  addressParts,
  evaluateCategory,
  normalizeCategory,
  placementAreasForCategory,
  targetFor,
  PLACEMENT_RULE_ADDITIONS,
};
