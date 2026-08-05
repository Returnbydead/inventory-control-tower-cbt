const { databaseName, getPool } = require("./sync-soh")._internal;
const { placementAreasForCategory } = require("../lib/l1-placement");

const SOURCE_ZONES = new Set(["SRA1", "SRB1", "SRC1"]);
const SOURCE_LEVELS = new Set(["L2", "L3", "L4", "L5", "L6"]);
const MAX_POST_TASKS = 1000;

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

function suggestionFor(group) {
  const existingPickface = [...group.pickface].sort(
    (left, right) =>
      right.stock - left.stock || left.rack_name.localeCompare(right.rack_name),
  )[0];

  if (existingPickface) {
    return {
      suggested_zone: existingPickface.zone,
      suggested_aisle: existingPickface.aisle,
      suggested_rack_name: existingPickface.rack_name,
      suggestion_basis: "EXISTING_SKU_PICKFACE",
    };
  }

  const category = group.all
    .map((row) => clean(row.l1_category_name))
    .find(Boolean);

  const area = category ? placementAreasForCategory(category)[0] : null;

  return {
    suggested_zone: clean(area?.zone),

    suggested_aisle: area?.aisle ? String(area.aisle).padStart(2, "0") : "",

    suggested_rack_name: "",

    suggestion_basis: area ? "PLANOGRAM_L1" : "NO_DESTINATION_SUGGESTION",
  };
}

/**
 * Web tidak menghitung kebutuhan replenishment.
 *
 * replenishQty langsung mengambil Task Qty GSheet.
 * Web hanya membagi Task Qty ke source rack MotherDuck.
 */
function buildCalculator({ params, sohRows, existingKeys }) {
  const existingKeySet = new Set(
    (existingKeys || []).map(normalizeTaskKey).filter(Boolean),
  );

  const sohBySku = groupSohRows(sohRows);

  const candidates = [];
  const skuRows = [];

  let totalRequiredQty = 0;
  let totalAllocatedQty = 0;
  let totalShortageQty = 0;
  let skippedExistingCount = 0;

  for (const param of params) {
    const taskQty = rounded(Math.max(0, param.task_qty));

    /**
     * Tidak ada Task Qty dari GSheet.
     */
    if (taskQty <= 0) {
      skuRows.push({
        product_id: param.product_id,
        sku_number: param.sku_number,
        product_name: param.product_name,

        doi: param.doi,
        max_pf: param.max_pf,
        target_pf: param.final_qty,

        pickface_stock: param.pickface,
        storage_stock: param.storage,

        need_qty: 0,
        replenish_qty: 0,
        task_qty: 0,

        allocated_qty: 0,
        shortage_qty: 0,

        source_count: 0,
        task_count: 0,

        status: "NO_REPLENISHMENT",
      });

      continue;
    }

    totalRequiredQty += taskQty;

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
      totalShortageQty += taskQty;

      skuRows.push({
        product_id: param.product_id,
        sku_number: param.sku_number,
        product_name: param.product_name,

        doi: param.doi,
        max_pf: param.max_pf,
        target_pf: param.final_qty,

        pickface_stock: param.pickface,
        storage_stock: param.storage,

        need_qty: taskQty,
        replenish_qty: taskQty,
        task_qty: taskQty,

        allocated_qty: 0,
        shortage_qty: taskQty,

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

    const suggestion = suggestionFor(group);

    /**
     * Source rack valid:
     *
     * - remarks_zone STORAGE
     * - Zone SRA1 / SRB1 / SRC1
     * - Level L2 sampai L6
     * - Stock terkecil lebih dahulu
     */
    const eligibleSources = [...group.storage].sort(
      (left, right) =>
        left.stock - right.stock ||
        left.rack_name.localeCompare(right.rack_name),
    );

    let remainingTaskQty = taskQty;
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

        doi: param.doi,
        max_pf: param.max_pf,
        target_pf: param.final_qty,

        pickface_stock: param.pickface,
        storage_stock: param.storage,

        need_qty: taskQty,
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

    const shortageQty = rounded(Math.max(0, taskQty - allocatedSkuQty));

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

      doi: param.doi,
      max_pf: param.max_pf,
      target_pf: param.final_qty,

      pickface_stock: param.pickface,
      storage_stock: param.storage,

      need_qty: taskQty,
      replenish_qty: taskQty,
      task_qty: taskQty,

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

  return {
    ok: true,

    /**
     * Dipertahankan agar frontend lama tidak error.
     * Nilainya berasal dari GSheet.
     */
    doi: sheetDoi,
    doi_source: "GSHEET",

    snapshot_at: snapshotAt,

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
       * Total Task Qty langsung dari GSheet.
       */
      required_qty: rounded(totalRequiredQty),

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
async function loadSohRows(params) {
  const skuNumbers = [
    ...new Set(
      params
        .filter((row) => rounded(row.task_qty) > 0)
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

async function loadCalculatorInputs() {
  const [paramPayload, keyPayload] = await Promise.all([
    fetchGasAction("param"),
    fetchGasAction("keys"),
  ]);

  const params = normalizeParamRows(paramPayload.rows);
  const sohRows = await loadSohRows(params);

  return {
    params,
    sohRows,
    existingKeys: keyPayload.keys,
  };
}

async function handleGet(req, res) {
  /**
   * Query DOI dari frontend lama diabaikan.
   * DOI resmi berasal dari GSheet.
   */
  const inputs = await loadCalculatorInputs();

  return json(
    res,
    200,
    buildCalculator(inputs),
  );
}

async function handlePost(req, res) {
  const selectedKeys = normalizeSelectedTaskKeys(req.body?.task_keys);
  const calculator = buildCalculator(await loadCalculatorInputs());
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
  groupSohRows,
  normalizeParamRows,
  normalizePostedTasks,
  normalizeSelectedTaskKeys,
  normalizeTaskKey,
  selectCurrentTasks,
  suggestionFor,
};
