const { databaseName, getPool } = require("./sync-soh")._internal;
const { placementRangesForCategory } = require("../lib/l1-placement");
const { fetchLivePlanogramRules } = require("../lib/planogram-live");

const SOURCE_ZONES = new Set(["SRA1", "SRB1", "SRC1"]);
const SOURCE_LEVELS = new Set(["L2", "L3", "L4", "L5", "L6", "L7"]);
const MAX_POST_TASKS = 1000;

function generationEnabled() {
  return clean(process.env.REPLENISHMENT_GENERATION_ENABLED).toLowerCase() === "true";
}

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

function wholeQty(value) {
  return Math.round(Math.max(0, number(value)));
}

function normalizeDoiOverride(value) {
  if (value === undefined || value === null || clean(value) === "") {
    return null;
  }

  const doi = number(value);

  if (doi <= 0) {
    const error = new Error("DOI override wajib berupa angka lebih dari 0.");
    error.statusCode = 400;
    throw error;
  }

  return rounded(doi);
}

function normalizeSku(value) {
  return clean(value);
}

function normalizeRack(value) {
  return clean(value).toUpperCase();
}

function buildTaskKey(skuNumber, fromRackName) {
  return `${normalizeSku(skuNumber)}|${normalizeRack(fromRackName)}`;
}

function normalizeTaskKey(value) {
  const raw = clean(value);
  const separator = raw.indexOf("|");

  if (separator <= 0 || separator === raw.length - 1) {
    return "";
  }

  return buildTaskKey(raw.slice(0, separator), raw.slice(separator + 1));
}

function gasUrl() {
  const value = clean(process.env.REPLENISHMENT_GAS_URL);

  if (!value) {
    throw new Error("REPLENISHMENT_GAS_URL belum diset.");
  }

  return value.replace(/\?+$/, "");
}

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
}

async function parseJsonResponse(response, label) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `${label} gagal: HTTP ${response.status}${
        text ? ` - ${text.slice(0, 300)}` : ""
      }`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label} tidak mengembalikan JSON valid: ${text.slice(0, 300)}`,
    );
  }
}

async function fetchGasAction(action) {
  const url = new URL(gasUrl());

  url.searchParams.set("action", action);
  url.searchParams.set("_ts", String(Date.now()));

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      accept: "application/json",
    },
  });

  const payload = await parseJsonResponse(response, `GAS action=${action}`);

  if (!payload?.ok) {
    throw new Error(clean(payload?.message) || `GAS action=${action} gagal.`);
  }

  return payload;
}

async function postTasksToGas(tasks) {
  const response = await fetch(gasUrl(), {
    method: "POST",
    redirect: "follow",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ tasks }),
  });

  const payload = await parseJsonResponse(response, "Penyimpanan task ke GAS");

  if (!payload?.ok) {
    throw new Error(
      clean(payload?.message) || "Penyimpanan task ke GAS gagal.",
    );
  }

  return payload;
}

/**
 * GSheet PARAM adalah sumber final:
 *
 * - SOH
 * - Pickface
 * - Storage
 * - Order/day
 * - Shelf Life
 * - Max PF
 * - Final Qty
 * - DOI
 * - Task Qty
 */
function normalizeParamRows(rows) {
  const bySku = new Map();

  for (const row of rows || []) {
    const skuNumber = normalizeSku(row.sku_number);

    if (!skuNumber) {
      continue;
    }

    const normalized = {
      product_id: clean(row.product_id),
      sku_number: skuNumber,
      product_name: clean(row.product_name),

      soh: rounded(row.soh),
      pickface: rounded(row.pickface),
      storage: rounded(row.storage),

      order_per_day: rounded(row.order_per_day),
      shelf_life: rounded(row.shelf_life),

      max_pf: rounded(row.max_pf),
      final_qty: rounded(row.final_qty),
      doi: rounded(row.doi),
      task_qty: rounded(row.task_qty),
    };

    bySku.set(skuNumber, normalized);
  }

  return [...bySku.values()];
}

/**
 * Detail SOH MotherDuck digunakan hanya untuk:
 *
 * - Source rack
 * - Stock source rack
 * - Destination Pickface
 */
function groupSohRows(rows) {
  const bySku = new Map();

  for (const row of rows || []) {
    const skuNumber = normalizeSku(row.sku_number);

    if (!skuNumber) {
      continue;
    }

    const group = bySku.get(skuNumber) || {
      sku_number: skuNumber,
      pickface: [],
      storage: [],
      all: [],
    };

    const normalized = {
      product_id: clean(row.product_id),
      sku_number: skuNumber,
      product_name: clean(row.product_name),

      rack_name: normalizeRack(row.rack_name),
      zone: clean(row.zone).toUpperCase(),
      aisle: clean(row.aisle),
      rack_sequence: clean(row.rack_sequence),
      rack_level: clean(row.rack_level).toUpperCase(),

      remarks_zone: clean(row.remarks_zone).toUpperCase(),
      l1_category_name: clean(row.l1_category_name),

      stock: rounded(row.stock),

      snapshot_at: row.snapshot_at
        ? new Date(row.snapshot_at).toISOString()
        : null,
    };

    group.all.push(normalized);

    if (normalized.remarks_zone === "PICKFACE" && normalized.stock > 0) {
      group.pickface.push(normalized);
    }

    if (
      normalized.remarks_zone === "STORAGE" &&
      SOURCE_ZONES.has(normalized.zone) &&
      SOURCE_LEVELS.has(normalized.rack_level) &&
      normalized.stock > 0
    ) {
      group.storage.push(normalized);
    }

    bySku.set(skuNumber, group);
  }

  return bySku;
}

function suggestionFor(group, planogramRules) {
  const category = group.all
    .map((row) => clean(row.l1_category_name))
    .find(Boolean);

  const area = category
    ? placementRangesForCategory(category, planogramRules)[0]
    : null;

  return {
    suggested_zone: clean(area?.zone),

    suggested_aisle: clean(area?.aisle_label),

    suggested_rack_name: "",

    suggestion_basis: area ? "PLANOGRAM_GSHEET" : "NO_DESTINATION_SUGGESTION",
  };
}

function calculationForParam(param, doiOverride) {
  if (doiOverride === null) {
    return {
      doi: rounded(param.doi),
      targetPf: wholeQty(param.final_qty),
      needQty: wholeQty(param.task_qty),
      taskQty: wholeQty(param.task_qty),
    };
  }

  const rawTargetPf = Math.max(0, param.max_pf) * doiOverride;
  const rawNeedQty = Math.max(0, rawTargetPf - param.pickface);
  const targetPf = wholeQty(rawTargetPf);
  const needQty = wholeQty(rawNeedQty);
  const taskQty = wholeQty(
    Math.min(Math.max(0, param.storage), rawNeedQty),
  );

  return {
    doi: doiOverride,
    targetPf,
    needQty,
    taskQty,
  };
}

const INACTIVE_TASK_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "CLOSED",
  "COMPLETE",
  "COMPLETED",
  "DONE",
]);

function normalizeExistingTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((task) => {
      const skuNumber = normalizeSku(task?.sku_number);
      const fromRackName = normalizeRack(task?.from_rack_name);
      const taskKey = normalizeTaskKey(
        task?.task_key ||
          (skuNumber && fromRackName
            ? buildTaskKey(skuNumber, fromRackName)
            : ""),
      );
      const taskKeySku = normalizeSku(taskKey.split("|")[0]);
      const status = clean(task?.status).toUpperCase();

      return {
        task_key: taskKey,
        // Google Sheets may coerce identifiers such as 089686010947 into a
        // number and drop the leading zero. task_key remains text because it
        // also contains the rack separator, so it is the canonical SKU source.
        sku_number: taskKeySku || skuNumber,
        allocated_qty: rounded(task?.allocated_qty),
        status,
      };
    })
    .filter(
      (task) =>
        task.task_key &&
        task.sku_number &&
        task.allocated_qty > 0 &&
        !INACTIVE_TASK_STATUSES.has(task.status),
    );
}

/**
 * Tanpa override, Task Qty final berasal dari GSheet.
 * Dengan override, server menghitung ulang Target PF, Need, dan Task Qty.
 * MotherDuck tetap hanya membagi Task Qty ke source rack.
 */
function buildCalculator({
  params,
  sohRows,
  existingKeys,
  existingTasks,
  planogramRules,
  planogramSource = "",
  ledgerMode = "KEYS_ONLY",
  doiOverride = null,
}) {
  const activeTasks = normalizeExistingTasks(existingTasks);
  const existingKeySet = new Set(
    [...(existingKeys || []), ...activeTasks.map((task) => task.task_key)]
      .map(normalizeTaskKey)
      .filter(Boolean),
  );
  const existingAllocatedBySku = new Map();

  for (const task of activeTasks) {
    existingAllocatedBySku.set(
      task.sku_number,
      rounded(
        (existingAllocatedBySku.get(task.sku_number) || 0) +
          task.allocated_qty,
      ),
    );
  }

  const sohBySku = groupSohRows(sohRows);

  const candidates = [];
  const skuRows = [];

  let totalRequiredQty = 0;
  let totalAllocatedQty = 0;
  let totalShortageQty = 0;
  let totalExistingAllocatedQty = 0;
  let totalExistingGeneratedQty = 0;
  let totalOvergeneratedQty = 0;
  let skippedExistingCount = 0;

  for (const param of params) {
    const calculation = calculationForParam(param, doiOverride);
    const { doi, targetPf, needQty, taskQty } = calculation;
    const existingGeneratedQty = rounded(
      existingAllocatedBySku.get(param.sku_number) || 0,
    );
    const existingAllocatedQty = rounded(
      Math.min(taskQty, existingGeneratedQty),
    );
    const overgeneratedQty = rounded(
      Math.max(0, existingGeneratedQty - taskQty),
    );
    const remainingRequiredQty = rounded(
      Math.max(0, taskQty - existingAllocatedQty),
    );

    totalRequiredQty += taskQty;
    totalExistingAllocatedQty += existingAllocatedQty;
    totalExistingGeneratedQty += existingGeneratedQty;
    totalOvergeneratedQty += overgeneratedQty;

    /**
     * Tidak ada Task Qty dari GSheet.
     */
    if (taskQty <= 0) {
      skuRows.push({
        product_id: param.product_id,
        sku_number: param.sku_number,
        product_name: param.product_name,

        doi,
        max_pf: param.max_pf,
        target_pf: targetPf,

        pickface_stock: param.pickface,
        storage_stock: param.storage,

        need_qty: 0,
        replenish_qty: 0,
        task_qty: 0,

        existing_allocated_qty: existingAllocatedQty,
        existing_generated_qty: existingGeneratedQty,
        overgenerated_qty: overgeneratedQty,
        remaining_required_qty: 0,

        allocated_qty: 0,
        shortage_qty: 0,

        source_count: 0,
        task_count: 0,

        status: "NO_REPLENISHMENT",
      });

      continue;
    }

    if (remainingRequiredQty <= 0) {
      skuRows.push({
        product_id: param.product_id,
        sku_number: param.sku_number,
        product_name: param.product_name,
        doi,
        max_pf: param.max_pf,
        target_pf: targetPf,
        pickface_stock: param.pickface,
        storage_stock: param.storage,
        need_qty: needQty,
        replenish_qty: taskQty,
        task_qty: taskQty,
        existing_allocated_qty: existingAllocatedQty,
        existing_generated_qty: existingGeneratedQty,
        overgenerated_qty: overgeneratedQty,
        remaining_required_qty: 0,
        allocated_qty: 0,
        shortage_qty: 0,
        source_count: 0,
        task_count: 0,
        status: "ALREADY_GENERATED",
      });
      continue;
    }

    const group = sohBySku.get(param.sku_number) || {
      sku_number: param.sku_number,
      pickface: [],
      storage: [],
      all: [],
    };

    /**
     * GSheet memiliki Task Qty tetapi SKU tidak ditemukan
     * di detail SOH MotherDuck.
     */
    if (!group.all.length) {
      totalShortageQty += remainingRequiredQty;

      skuRows.push({
        product_id: param.product_id,
        sku_number: param.sku_number,
        product_name: param.product_name,

        doi,
        max_pf: param.max_pf,
        target_pf: targetPf,

        pickface_stock: param.pickface,
        storage_stock: param.storage,

        need_qty: needQty,
        replenish_qty: taskQty,
        task_qty: taskQty,

        existing_allocated_qty: existingAllocatedQty,
        existing_generated_qty: existingGeneratedQty,
        overgenerated_qty: overgeneratedQty,
        remaining_required_qty: remainingRequiredQty,

        allocated_qty: 0,
        shortage_qty: remainingRequiredQty,

        source_count: 0,
        task_count: 0,

        status: "NO_SOH",
      });

      continue;
    }

    const productId = clean(
      param.product_id || group.all.find((row) => row.product_id)?.product_id,
    );

    const productName = clean(
      param.product_name ||
        group.all.find((row) => row.product_name)?.product_name,
    );

    const suggestion = suggestionFor(group, planogramRules);

    /**
     * Source rack valid:
     *
     * - remarks_zone STORAGE
     * - Zone SRA1 / SRB1 / SRC1
     * - Level L2 sampai L7
     * - Stock terkecil lebih dahulu
     */
    const eligibleSources = [...group.storage].sort(
      (left, right) =>
        left.stock - right.stock ||
        left.rack_name.localeCompare(right.rack_name),
    );

    let remainingTaskQty = remainingRequiredQty;
    let allocatedSkuQty = 0;
    let sourceCount = 0;
    let taskCount = 0;

    const pendingTasks = [];
    const seenSourceKeys = new Set();

    for (const source of eligibleSources) {
      if (remainingTaskQty <= 0) {
        break;
      }

      const taskKey = buildTaskKey(param.sku_number, source.rack_name);

      if (seenSourceKeys.has(taskKey)) {
        continue;
      }

      seenSourceKeys.add(taskKey);

      /**
       * SKU + source rack yang sudah pernah dibuat
       * tidak digenerate ulang.
       */
      if (existingKeySet.has(taskKey)) {
        skippedExistingCount += 1;
        continue;
      }

      const allocatedQty = rounded(Math.min(source.stock, remainingTaskQty));

      if (allocatedQty <= 0) {
        continue;
      }

      pendingTasks.push({
        task_key: taskKey,

        product_id: productId,
        sku_number: param.sku_number,
        product_name: productName,

        doi,
        max_pf: param.max_pf,
        target_pf: targetPf,

        pickface_stock: param.pickface,
        storage_stock: param.storage,

        need_qty: needQty,
        replenish_qty: taskQty,
        task_qty: taskQty,

        from_rack_name: source.rack_name,
        source_stock: source.stock,
        allocated_qty: allocatedQty,

        suggested_zone: suggestion.suggested_zone,
        suggested_aisle: suggestion.suggested_aisle,
        suggested_rack_name: suggestion.suggested_rack_name,

        suggestion_basis: suggestion.suggestion_basis,

        status: "READY",
      });

      remainingTaskQty = rounded(remainingTaskQty - allocatedQty);

      allocatedSkuQty = rounded(allocatedSkuQty + allocatedQty);

      sourceCount += 1;
      taskCount += 1;
    }

    const shortageQty = rounded(
      Math.max(0, remainingRequiredQty - allocatedSkuQty),
    );

    const skuStatus =
      shortageQty > 0
        ? allocatedSkuQty > 0
          ? "PARTIAL"
          : "STOCK_NOT_ENOUGH"
        : "READY";

    for (const task of pendingTasks) {
      candidates.push({
        ...task,
        status: skuStatus,
        shortage_qty: shortageQty,
      });
    }

    totalAllocatedQty += allocatedSkuQty;
    totalShortageQty += shortageQty;

    skuRows.push({
      product_id: productId,
      sku_number: param.sku_number,
      product_name: productName,

      doi,
      max_pf: param.max_pf,
      target_pf: targetPf,

      pickface_stock: param.pickface,
      storage_stock: param.storage,

      need_qty: needQty,
      replenish_qty: taskQty,
      task_qty: taskQty,

      existing_allocated_qty: existingAllocatedQty,
      existing_generated_qty: existingGeneratedQty,
      overgenerated_qty: overgeneratedQty,
      remaining_required_qty: remainingRequiredQty,

      allocated_qty: allocatedSkuQty,
      shortage_qty: shortageQty,

      source_count: sourceCount,
      task_count: taskCount,

      status: skuStatus,

      ...suggestion,
    });
  }

  const snapshotAt = sohRows.reduce((latest, row) => {
    if (!row.snapshot_at) {
      return latest;
    }

    const value = new Date(row.snapshot_at).toISOString();

    return !latest || value > latest ? value : latest;
  }, null);

  const sheetDoi =
    params.map((row) => rounded(row.doi)).find((value) => value > 0) || 0;
  const ledgerReady = ledgerMode === "TASKS";
  const ledgerSafe = ledgerReady && rounded(totalOvergeneratedQty) <= 0;
  const generationConfigured = generationEnabled();
  const generationBlockReason = !ledgerReady
    ? "LEDGER_UNAVAILABLE"
    : !ledgerSafe
      ? "OVERGENERATED"
      : !generationConfigured
        ? "SERVER_CONFIG"
        : null;

  return {
    ok: true,
    generation_enabled: generationConfigured && ledgerSafe,
    generation_block_reason: generationBlockReason,
    ledger_mode: ledgerMode,
    ledger_ready: ledgerReady,
    ledger_safe: ledgerSafe,

    /**
     * Dipertahankan agar frontend lama tidak error.
     * Nilainya berasal dari GSheet.
     */
    doi: doiOverride ?? sheetDoi,
    doi_source: doiOverride === null ? "GSHEET" : "WEB_OVERRIDE",
    doi_override: doiOverride,

    snapshot_at: snapshotAt,
    planogram_source: planogramSource,
    planogram_rule_count: Array.isArray(planogramRules) ? planogramRules.length : 0,

    summary: {
      param_sku_count: params.length,

      soh_sku_count: skuRows.filter(
        (row) => row.task_qty > 0 && row.status !== "NO_SOH",
      ).length,

      missing_soh_sku_count: skuRows.filter((row) => row.status === "NO_SOH")
        .length,

      replenishment_sku_count: skuRows.filter((row) => row.task_qty > 0).length,

      task_sku_count: new Set(candidates.map((task) => task.sku_number)).size,

      ready_sku_count: skuRows.filter((row) => row.status === "READY").length,

      partial_sku_count: skuRows.filter((row) => row.status === "PARTIAL")
        .length,

      stock_not_enough_sku_count: skuRows.filter(
        (row) => row.status === "STOCK_NOT_ENOUGH",
      ).length,

      task_count: candidates.length,

      /**
       * Total Task Qty dari GSheet atau hasil DOI override.
       */
      required_qty: rounded(totalRequiredQty),

      existing_allocated_qty: rounded(totalExistingAllocatedQty),

      existing_generated_qty: rounded(totalExistingGeneratedQty),

      overgenerated_qty: rounded(totalOvergeneratedQty),

      remaining_required_qty: rounded(
        Math.max(0, totalRequiredQty - totalExistingAllocatedQty),
      ),

      /**
       * Total yang berhasil dibagi ke source rack.
       */
      allocated_qty: rounded(totalAllocatedQty),

      /**
       * Task Qty yang belum mendapatkan source rack.
       */
      shortage_qty: rounded(totalShortageQty),

      skipped_existing_source_count: skippedExistingCount,

      existing_task_key_count: existingKeySet.size,
    },

    sku_rows: skuRows,
    tasks: candidates,
  };
}

/**
 * MotherDuck hanya diambil untuk SKU
 * yang Task Qty GSheet lebih dari 0.
 */
async function loadSohRows(params, doiOverride = null) {
  const skuNumbers = [
    ...new Set(
      params
        .filter((row) => calculationForParam(row, doiOverride).taskQty > 0)
        .map((row) => row.sku_number)
        .filter(Boolean),
    ),
  ];

  if (!skuNumbers.length) {
    return [];
  }

  let client;

  try {
    client = await getPool().connect();

    await client.query(`USE ${databaseName()}`);

    const result = await client.query(
      `
        SELECT
          product_id,
          sku_number,
          product_name,
          rack_name,
          zone,
          aisle,
          rack_sequence,
          rack_level,
          remarks_zone,
          l1_category_name,
          SUM(stock) AS stock,
          MAX(synced_at) AS snapshot_at
        FROM soh_current
        WHERE stock > 0
          AND sku_number = ANY($1::text[])
        GROUP BY
          product_id,
          sku_number,
          product_name,
          rack_name,
          zone,
          aisle,
          rack_sequence,
          rack_level,
          remarks_zone,
          l1_category_name
        ORDER BY
          sku_number,
          stock ASC,
          rack_name
      `,
      [skuNumbers],
    );

    return result.rows;
  } finally {
    client?.release();
  }
}

function normalizePostedTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new Error("Payload tasks wajib berupa array.");
  }

  if (!tasks.length) {
    throw new Error("Tidak ada task yang dipilih.");
  }

  if (tasks.length > MAX_POST_TASKS) {
    throw new Error(`Maksimal ${MAX_POST_TASKS} task dalam satu request.`);
  }

  return tasks.map((task) => {
    const skuNumber = normalizeSku(task.sku_number);

    const fromRackName = normalizeRack(task.from_rack_name);

    const allocatedQty = rounded(task.allocated_qty);

    if (!skuNumber || !fromRackName) {
      throw new Error(
        "Setiap task wajib memiliki sku_number dan from_rack_name.",
      );
    }

    if (allocatedQty <= 0) {
      throw new Error(`allocated_qty SKU ${skuNumber} harus lebih dari 0.`);
    }

    const sourceStock = rounded(task.source_stock);
    const replenishQty = rounded(task.replenish_qty);

    if (sourceStock <= 0 || allocatedQty > sourceStock) {
      throw new Error(
        `allocated_qty SKU ${skuNumber} tidak boleh melebihi source_stock.`,
      );
    }

    if (replenishQty <= 0 || allocatedQty > replenishQty) {
      throw new Error(
        `allocated_qty SKU ${skuNumber} tidak boleh melebihi replenish_qty.`,
      );
    }

    return {
      task_key: buildTaskKey(skuNumber, fromRackName),
      product_id: clean(task.product_id),
      sku_number: skuNumber,
      product_name: clean(task.product_name),

      doi: rounded(task.doi),
      max_pf: rounded(task.max_pf),
      target_pf: rounded(task.target_pf),

      pickface_stock: rounded(task.pickface_stock),

      replenish_qty: replenishQty,

      from_rack_name: fromRackName,

      source_stock: sourceStock,

      allocated_qty: allocatedQty,

      suggested_zone: clean(task.suggested_zone),

      suggested_aisle: clean(task.suggested_aisle),

      suggested_rack_name: normalizeRack(task.suggested_rack_name),

      status: clean(task.status) || "GENERATED",
    };
  });
}

function normalizeSelectedTaskKeys(taskKeys) {
  if (!Array.isArray(taskKeys)) {
    const error = new Error("Payload task_keys wajib berupa array.");
    error.statusCode = 400;
    throw error;
  }

  const normalizedKeys = taskKeys.map(normalizeTaskKey);

  if (normalizedKeys.some((key) => !key)) {
    const error = new Error("Setiap task_key wajib berformat SKU|SOURCE_RACK.");
    error.statusCode = 400;
    throw error;
  }

  const normalized = [...new Set(normalizedKeys)];

  if (!normalized.length) {
    const error = new Error("Tidak ada task yang dipilih.");
    error.statusCode = 400;
    throw error;
  }

  if (normalized.length > MAX_POST_TASKS) {
    const error = new Error(
      `Maksimal ${MAX_POST_TASKS} task dalam satu request.`,
    );
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function selectCurrentTasks(tasks, selectedKeys) {
  const currentByKey = new Map(
    (tasks || []).map((task) => [normalizeTaskKey(task.task_key), task]),
  );

  const missingKeys = selectedKeys.filter((key) => !currentByKey.has(key));

  if (missingKeys.length) {
    const error = new Error(
      "Kandidat task sudah berubah. Refresh kalkulasi lalu pilih ulang task.",
    );
    error.statusCode = 409;
    throw error;
  }

  const selectedTasks = selectedKeys.map((key) => currentByKey.get(key));
  const allocatedBySku = new Map();

  for (const task of selectedTasks) {
    const skuNumber = normalizeSku(task.sku_number);
    allocatedBySku.set(
      skuNumber,
      rounded((allocatedBySku.get(skuNumber) || 0) + task.allocated_qty),
    );
  }

  for (const task of selectedTasks) {
    const allocatedQty = allocatedBySku.get(normalizeSku(task.sku_number)) || 0;

    if (allocatedQty > rounded(task.task_qty)) {
      throw new Error(
        `Total allocated_qty SKU ${task.sku_number} melebihi Task Qty terbaru.`,
      );
    }
  }

  return selectedTasks;
}

async function loadCalculatorInputs(doiOverride = null) {
  const [paramPayload, ledgerPayload] = await Promise.all([
    fetchGasAction("param"),
    fetchGasAction("tasks")
      .then((payload) => {
        if (!Array.isArray(payload.tasks)) {
          throw new Error("GAS action=tasks belum menyediakan array tasks.");
        }

        return {
          existingTasks: payload.tasks,
          existingKeys: [],
          ledgerMode: "TASKS",
        };
      })
      .catch(async () => {
        const payload = await fetchGasAction("keys");

        return {
          existingTasks: [],
          existingKeys: Array.isArray(payload.keys) ? payload.keys : [],
          ledgerMode: "KEYS_ONLY",
        };
      }),
  ]);
  // Apps Script can close one of several simultaneous executions. Keep the
  // operational PARAM + ledger pair unchanged, then read Planogram after the
  // ledger has been reconciled so a mapping refresh cannot downgrade safety.
  const planogramPayload = await fetchLivePlanogramRules();

  const params = normalizeParamRows(paramPayload.rows);
  const sohRows = await loadSohRows(params, doiOverride);

  return {
    params,
    sohRows,
    ...ledgerPayload,
    planogramRules: planogramPayload.rules,
    planogramSource: planogramPayload.source,
    doiOverride,
  };
}

async function handleGet(req, res) {
  const doiOverride = normalizeDoiOverride(req.query?.doi);
  const inputs = await loadCalculatorInputs(doiOverride);

  return json(
    res,
    200,
    buildCalculator(inputs),
  );
}

async function handlePost(req, res) {
  if (!generationEnabled()) {
    const error = new Error(
      "Generate task dikunci sementara untuk mencegah task duplikat.",
    );
    error.statusCode = 423;
    throw error;
  }

  const selectedKeys = normalizeSelectedTaskKeys(req.body?.task_keys);
  const doiOverride = normalizeDoiOverride(req.body?.doi_override);
  const calculator = buildCalculator(await loadCalculatorInputs(doiOverride));

  if (!calculator.ledger_ready) {
    const error = new Error(
      "Generate task tetap dikunci karena ledger GAS belum mengirim detail task aktif.",
    );
    error.statusCode = 423;
    throw error;
  }

  if (!calculator.ledger_safe) {
    const error = new Error(
      "Generate task dikunci karena ledger memiliki qty overgenerated. Rekonsiliasi task aktif diperlukan sebelum generate berikutnya.",
    );
    error.statusCode = 423;
    throw error;
  }

  const currentTasks = selectCurrentTasks(calculator.tasks, selectedKeys);
  const tasks = normalizePostedTasks(currentTasks);

  const result = await postTasksToGas(tasks);

  return json(res, 200, {
    ok: true,

    inserted: number(result.inserted),

    skipped: number(result.skipped),

    skipped_rows: Array.isArray(result.skipped_rows) ? result.skipped_rows : [],
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return await handleGet(req, res);
    }

    if (req.method === "POST") {
      return await handlePost(req, res);
    }

    res.setHeader("Allow", "GET, POST");

    return json(res, 405, {
      ok: false,
      message: "Method not allowed",
    });
  } catch (error) {
    console.error("Replenishment calculator failed", {
      method: req.method,
      message: error.message,
    });

    return json(res, Number(error.statusCode) || 500, {
      ok: false,

      message: error.message || "Replenishment calculator gagal.",
    });
  }
};

module.exports._test = {
  buildCalculator,
  buildTaskKey,
  calculationForParam,
  generationEnabled,
  groupSohRows,
  normalizeDoiOverride,
  normalizeExistingTasks,
  normalizeParamRows,
  normalizePostedTasks,
  normalizeSelectedTaskKeys,
  normalizeTaskKey,
  selectCurrentTasks,
  suggestionFor,
};
