const PLANOGRAM_SOURCE = "GSHEET_LIVE";

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function gasUrl() {
  const value = clean(process.env.REPLENISHMENT_GAS_URL);

  if (!value) {
    throw new Error("REPLENISHMENT_GAS_URL belum diset.");
  }

  return value.replace(/\?+$/, "");
}

function normalizePlanogramRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("API Planogram belum menyediakan array rows.");
  }

  const seen = new Set();
  const rules = [];

  for (const row of rows) {
    const category = clean(row?.category);
    const zone = clean(row?.zone).toUpperCase();
    const aisleFrom = Math.trunc(number(row?.aisle_from));
    const aisleTo = Math.trunc(number(row?.aisle_to || row?.aisle_from));

    if (!category || !/^[A-Z]{2,3}\d$/.test(zone)) {
      throw new Error("API Planogram berisi kategori atau modul yang tidak valid.");
    }

    if (aisleFrom <= 0 || aisleTo < aisleFrom || aisleTo > 99) {
      throw new Error(`API Planogram berisi rack suggestion tidak valid untuk ${category}.`);
    }

    const key = [category.toLocaleLowerCase("id"), zone, aisleFrom, aisleTo].join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    rules.push({
      category,
      zone,
      aisle_from: aisleFrom,
      aisle_to: aisleTo,
      aisle_label: aisleFrom === aisleTo
        ? String(aisleFrom).padStart(2, "0")
        : `${String(aisleFrom).padStart(2, "0")}-${String(aisleTo).padStart(2, "0")}`,
      source: PLANOGRAM_SOURCE,
    });
  }

  if (!rules.length) {
    throw new Error("API Planogram tidak mengembalikan aturan aktif.");
  }

  return rules;
}

async function fetchLivePlanogramRules() {
  const url = new URL(gasUrl());
  url.searchParams.set("action", "planogram");
  url.searchParams.set("_ts", String(Date.now()));

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { accept: "application/json" },
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`API Planogram gagal: HTTP ${response.status}${text ? ` - ${text.slice(0, 300)}` : ""}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`API Planogram tidak mengembalikan JSON valid: ${text.slice(0, 300)}`);
  }

  if (!payload?.ok) {
    throw new Error(clean(payload?.message) || "API Planogram gagal.");
  }

  const rules = normalizePlanogramRows(payload.rows);
  return {
    rules,
    source: PLANOGRAM_SOURCE,
    rule_count: rules.length,
  };
}

module.exports = {
  fetchLivePlanogramRules,
  PLANOGRAM_SOURCE,
  _test: { normalizePlanogramRows },
};
