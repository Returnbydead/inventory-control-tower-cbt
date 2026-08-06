const MAX_PLANOGRAM_TASKS = 500;

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

function normalizeSku(value) {
  return clean(value).replace(/^'+/, "");
}

function normalizeRack(value) {
  return clean(value).toUpperCase();
}

function buildPlanogramTaskKey(skuNumber, fromRackName) {
  const sku = normalizeSku(skuNumber);
  const rack = normalizeRack(fromRackName);
  return sku && rack ? `PLANOGRAM|${sku}|${rack}` : "";
}

function normalizePlanogramTaskKey(value) {
  const parts = clean(value).split("|");
  if (parts.length !== 3 || parts[0].toUpperCase() !== "PLANOGRAM") return "";
  return buildPlanogramTaskKey(parts[1], parts[2]);
}

function normalizeSelectedTaskKeys(taskKeys) {
  if (!Array.isArray(taskKeys)) {
    const error = new Error("Payload task_keys wajib berupa array.");
    error.statusCode = 400;
    throw error;
  }

  const keys = taskKeys.map(normalizePlanogramTaskKey);
  if (keys.some((key) => !key)) {
    const error = new Error("Setiap task_key Planogram wajib valid.");
    error.statusCode = 400;
    throw error;
  }

  const unique = [...new Set(keys)];
  if (!unique.length) {
    const error = new Error("Tidak ada task Planogram yang dipilih.");
    error.statusCode = 400;
    throw error;
  }
  if (unique.length > MAX_PLANOGRAM_TASKS) {
    const error = new Error(`Maksimal ${MAX_PLANOGRAM_TASKS} task Planogram dalam satu proses generate.`);
    error.statusCode = 400;
    throw error;
  }
  return unique;
}

function eligiblePlanogramRow(row) {
  return row?.status === "WRONG_L1"
    && rounded(row?.wrong_qty) > 0
    && Array.isArray(row?.suggestions)
    && row.suggestions.length > 0;
}

function annotatePlanogramRows(rows, existingKeys = []) {
  const generated = new Set(
    (existingKeys || []).map(normalizePlanogramTaskKey).filter(Boolean),
  );

  return (rows || []).map((row) => {
    const taskKey = buildPlanogramTaskKey(row.sku_number, row.rack_name);
    const eligible = eligiblePlanogramRow(row);
    const alreadyGenerated = taskKey && generated.has(taskKey);
    return {
      ...row,
      task_key: taskKey,
      task_eligible: Boolean(eligible && !alreadyGenerated),
      task_status: alreadyGenerated ? "GENERATED" : eligible ? "READY" : "NOT_ELIGIBLE",
    };
  });
}

function selectCurrentTasks(rows, selectedKeys) {
  const current = new Map(
    (rows || [])
      .filter((row) => row.task_eligible)
      .map((row) => [normalizePlanogramTaskKey(row.task_key), row]),
  );
  const missing = selectedKeys.filter((key) => !current.has(key));
  if (missing.length) {
    const error = new Error("Kandidat Planogram sudah berubah atau sudah tergenerate. Refresh lalu pilih ulang task.");
    error.statusCode = 409;
    throw error;
  }
  return selectedKeys.map((key) => current.get(key));
}

function suggestionLabel(item) {
  const zone = clean(item?.zone).toUpperCase();
  const aisle = Math.trunc(number(item?.aisle));
  return zone && aisle > 0 ? `${zone} - aisle ${String(aisle).padStart(2, "0")}` : "";
}

function toPostedPlanogramTask(row) {
  if (!eligiblePlanogramRow(row)) {
    throw new Error("Baris bukan kandidat task Planogram aktif.");
  }
  const primary = row.suggestions[0];
  return {
    task_key: buildPlanogramTaskKey(row.sku_number, row.rack_name),
    sku_number: normalizeSku(row.sku_number),
    product_name: clean(row.product_name),
    move_qty: rounded(row.wrong_qty),
    from_rack_name: normalizeRack(row.rack_name),
    from_zone: clean(row.zone).toUpperCase(),
    from_aisle: Math.trunc(number(row.aisle)),
    from_sequence: Math.trunc(number(row.rack_sequence)),
    from_level: clean(row.rack_level).toUpperCase(),
    current_l1: clean(row.l1_category_name),
    target_l1_at_current_location: (row.allowed_l1 || []).map(clean).filter(Boolean).join(" / "),
    suggested_zone: clean(primary?.zone).toUpperCase(),
    suggested_aisle: Math.trunc(number(primary?.aisle)),
    suggestion_options: row.suggestions.map(suggestionLabel).filter(Boolean).join(" | "),
    suggested_rack_name: "",
    status: "GENERATED",
  };
}

function gasUrl() {
  const value = clean(process.env.REPLENISHMENT_GAS_URL);
  if (!value) throw new Error("REPLENISHMENT_GAS_URL belum diset.");
  return value.replace(/\?+$/, "");
}

async function parseGasResponse(response, label) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${label} tidak mengembalikan JSON valid.`);
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(clean(payload?.message) || `${label} gagal: HTTP ${response.status}`);
  }
  return payload;
}

async function fetchPlanogramTaskLedger() {
  const url = new URL(gasUrl());
  url.searchParams.set("action", "planogram_tasks");
  url.searchParams.set("_ts", String(Date.now()));
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { accept: "application/json" },
  });
  const payload = await parseGasResponse(response, "Ledger task Planogram");
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  return {
    tasks,
    keys: tasks.map((task) => task?.task_key).map(normalizePlanogramTaskKey).filter(Boolean),
  };
}

async function postPlanogramTasks(tasks) {
  const response = await fetch(gasUrl(), {
    method: "POST",
    redirect: "follow",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ kind: "planogram", tasks }),
  });
  return parseGasResponse(response, "Generate task Planogram");
}

module.exports = {
  MAX_PLANOGRAM_TASKS,
  annotatePlanogramRows,
  buildPlanogramTaskKey,
  eligiblePlanogramRow,
  fetchPlanogramTaskLedger,
  normalizePlanogramTaskKey,
  normalizeSelectedTaskKeys,
  postPlanogramTasks,
  selectCurrentTasks,
  suggestionLabel,
  toPostedPlanogramTask,
};
