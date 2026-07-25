const rulesPayload = require("../public/data/l1-placement-rules.json");

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
    rackSequence: Number(match[2]),
    aisle: Number(match[3]),
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
  const allowed = new Set(rule.allowed);
  for (const category of rule.bay_allowed[String(address.rackSequence)] || []) {
    allowed.add(category);
  }
  if (!allowed.size) {
    return { status: "NO_TARGET", allowed: [], source: rule.source, address };
  }
  return { status: "MAPPED", allowed: [...allowed], source: rule.source, address };
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
  targetFor,
};
