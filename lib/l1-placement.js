const rulesPayload = require("../public/data/l1-placement-rules.json");
const gsheetRulesPayload = require("../public/data/planogram-gsheet-rules.json");

const PRIMARY_PLANOGRAM_ZONES = new Set(["SRA1", "SRB1", "SRC1"]);

// Legacy non-SPR additions remain available for rack evaluation outside the
// SRA1/SRB1/SRC1 GSheet mapping. They are never used for new suggestions.
const PLACEMENT_RULE_ADDITIONS = Object.freeze({
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

function gsheetRuleForAddress(address) {
  const allowed = new Set();
  for (const rule of gsheetRulesPayload.rules || []) {
    if (rule.zone !== address.zone) continue;
    if (address.aisle < rule.aisle_from || address.aisle > rule.aisle_to) continue;
    allowed.add(normalizeCategory(rule.category));
  }
  return {
    status: allowed.size ? "MAPPED" : "NO_TARGET",
    allowed: [...allowed],
    source: gsheetRulesPayload.source,
    address,
  };
}

function targetFor(rackName) {
  const address = addressParts(rackName);
  if (!address) {
    return { status: "NO_TARGET", allowed: [], source: "", address: null };
  }
  if (PRIMARY_PLANOGRAM_ZONES.has(address.zone)) {
    return gsheetRuleForAddress(address);
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
  for (const rule of gsheetRulesPayload.rules || []) {
    if (normalizeCategory(rule.category) !== category) continue;
    for (let aisle = rule.aisle_from; aisle <= rule.aisle_to; aisle += 1) {
      areas.push({
        zone: rule.zone,
        aisle,
        source: gsheetRulesPayload.source,
      });
    }
  }
  return areas.sort((left, right) => (
    left.zone.localeCompare(right.zone) || left.aisle - right.aisle
  ));
}

function placementRangesForCategory(value) {
  const category = normalizeCategory(value);
  return (gsheetRulesPayload.rules || [])
    .filter((rule) => normalizeCategory(rule.category) === category)
    .map((rule) => ({
      zone: rule.zone,
      aisle_from: rule.aisle_from,
      aisle_to: rule.aisle_to,
      aisle_label: rule.aisle_from === rule.aisle_to
        ? String(rule.aisle_from).padStart(2, "0")
        : `${String(rule.aisle_from).padStart(2, "0")}-${String(rule.aisle_to).padStart(2, "0")}`,
      source: gsheetRulesPayload.source,
    }));
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
  placementRangesForCategory,
  targetFor,
  PLACEMENT_RULE_ADDITIONS,
};
