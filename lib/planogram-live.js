const PLANOGRAM_SOURCE = "GSHEET_LIVE";
const PLANOGRAM_CACHE_SOURCE = "GSHEET_CACHE";
const PLANOGRAM_FALLBACK_SOURCE = "GSHEET_LAST_KNOWN";
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 350;
const DEFAULT_TIMEOUT_MS = 8000;
const bundledPlanogram = require("../public/data/planogram-gsheet-rules.json");

let lastGoodPlanogram = null;

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

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function fetchPlanogramAttempt({ fetchImpl, timeoutMs, gasUrlValue }) {
  const url = new URL(gasUrlValue || gasUrl());
  url.searchParams.set("action", "planogram");
  url.searchParams.set("_ts", String(Date.now()));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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
    stale: false,
  };
}

function cachedResult(source, error, stale = true) {
  const cached = lastGoodPlanogram || {
    rules: normalizePlanogramRows(bundledPlanogram.rules),
    fetchedAt: null,
  };
  return {
    rules: cached.rules,
    source,
    rule_count: cached.rules.length,
    stale,
    cached_at: cached.fetchedAt ? new Date(cached.fetchedAt).toISOString() : null,
    live_error: error?.message || "",
  };
}

async function fetchLivePlanogramRulesWith({
  fetchImpl = fetch,
  allowFallback = true,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  gasUrlValue,
} = {}) {
  const now = Date.now();
  if (lastGoodPlanogram && cacheTtlMs > 0 && now - lastGoodPlanogram.fetchedAt < cacheTtlMs) {
    return cachedResult(PLANOGRAM_CACHE_SOURCE, null, false);
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchPlanogramAttempt({ fetchImpl, timeoutMs, gasUrlValue });
      lastGoodPlanogram = { rules: result.rules, fetchedAt: Date.now() };
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await wait(retryDelayMs * (attempt + 1));
    }
  }

  if (!allowFallback) throw lastError;

  const source = lastGoodPlanogram ? PLANOGRAM_CACHE_SOURCE : PLANOGRAM_FALLBACK_SOURCE;
  console.warn("Planogram live fallback used", { source, message: lastError?.message });
  return cachedResult(
    source,
    lastError,
  );
}

async function fetchLivePlanogramRules(options) {
  return fetchLivePlanogramRulesWith(options);
}

function resetLivePlanogramCache() {
  lastGoodPlanogram = null;
}

module.exports = {
  fetchLivePlanogramRules,
  PLANOGRAM_SOURCE,
  _test: {
    fetchLivePlanogramRulesWith,
    normalizePlanogramRows,
    resetLivePlanogramCache,
  },
};
