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

function normalizeParamRows(rows) {
  const bySku = new Map();

  for (const row of rows || []) {
    const skuNumber = normalizeSku(row.sku_number);
    const maxPf = number(row.max_pf);

    if (!skuNumber || maxPf <= 0) continue;

    const current = bySku.get(skuNumber);

    if (!current || maxPf > current.max_pf) {
      bySku.set(skuNumber, {
        product_id: clean(row.product_id),
        sku_number: skuNumber,
        product_name: clean(row.product_name),
        max_pf: rounded(maxPf),
      });
    }
  }

  return [...bySku.values()];
}

function groupSohRows(rows) {
  const bySku = new Map();

  for (const row of rows || []) {
    const skuNumber = normalizeSku(row.sku_number);

    if (!skuNumber) continue;

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

function buildCalculator({ params, sohRows, existingKeys, doi }) {
  const existingKeySet = new Set(
    (existingKeys || []).map(clean).filter(Boolean),
  );

  const sohBySku = groupSohRows(sohRows);
  const candidates = [];
  const skuRows = [];

  let totalRequiredQty = 0;
  let totalAllocatedQty = 0;
  let totalShortageQty = 0;
  let skippedExistingCount = 0;

  for (const param of params) {
    const group = sohBySku.get(param.sku_number) || {
      sku_number: param.sku_number,
      pickface: [],
      storage: [],
      all: [],
    };
    // PARAM bisa berisi SKU yang sudah tidak memiliki stock di snapshot SOH.
    // SKU tanpa baris SOH bukan kandidat replenishment dan tidak boleh
    // menambah required qty maupun shortage qty.
    if (!group.all.length) {
      skuRows.push({
        product_id: clean(param.product_id),
        sku_number: param.sku_number,
        product_name: clean(param.product_name),
        doi: rounded(doi),
        max_pf: param.max_pf,
        target_pf: rounded(param.max_pf * doi),
        pickface_stock: 0,
        replenish_qty: 0,
        allocated_qty: 0,
        shortage_qty: 0,
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

    const targetPf = rounded(param.max_pf * doi);

    const pickfaceStock = rounded(
      group.pickface.reduce((total, row) => total + row.stock, 0),
    );

    const replenishQty = rounded(Math.max(0, targetPf - pickfaceStock));

    if (replenishQty <= 0) {
      skuRows.push({
        product_id: productId,
        sku_number: param.sku_number,
        product_name: productName,
        doi,
        max_pf: param.max_pf,
        target_pf: targetPf,
        pickface_stock: pickfaceStock,
        replenish_qty: 0,
        allocated_qty: 0,
        shortage_qty: 0,
        source_count: 0,
        task_count: 0,
        status: "NO_REPLENISHMENT",
      });

      continue;
    }

    totalRequiredQty += replenishQty;

    const suggestion = suggestionFor(group);

    const eligibleSources = [...group.storage].sort(
      (left, right) =>
        left.stock - right.stock ||
        left.rack_name.localeCompare(right.rack_name),
    );

    let remainingQty = replenishQty;
    let allocatedSkuQty = 0;
    let sourceCount = 0;
    let taskCount = 0;

    const pendingTasks = [];

    for (const source of eligibleSources) {
      if (remainingQty <= 0) break;

      const taskKey = buildTaskKey(param.sku_number, source.rack_name);

      if (existingKeySet.has(taskKey)) {
        skippedExistingCount += 1;
        continue;
      }

      const allocatedQty = rounded(Math.min(source.stock, remainingQty));

      if (allocatedQty <= 0) continue;

      pendingTasks.push({
        task_key: taskKey,
        product_id: productId,
        sku_number: param.sku_number,
        product_name: productName,
        doi: rounded(doi),
        max_pf: param.max_pf,
        target_pf: targetPf,
        pickface_stock: pickfaceStock,
        replenish_qty: replenishQty,
        from_rack_name: source.rack_name,
        source_stock: source.stock,
        allocated_qty: allocatedQty,
        suggested_zone: suggestion.suggested_zone,
        suggested_aisle: suggestion.suggested_aisle,
        suggested_rack_name: suggestion.suggested_rack_name,
        suggestion_basis: suggestion.suggestion_basis,
        status: "READY",
      });

      remainingQty = rounded(remainingQty - allocatedQty);
      allocatedSkuQty = rounded(allocatedSkuQty + allocatedQty);

      sourceCount += 1;
      taskCount += 1;
    }

    const shortageQty = rounded(Math.max(0, remainingQty));
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
      doi: rounded(doi),
      max_pf: param.max_pf,
      target_pf: targetPf,
      pickface_stock: pickfaceStock,
      replenish_qty: replenishQty,
      allocated_qty: allocatedSkuQty,
      shortage_qty: shortageQty,
      source_count: sourceCount,
      task_count: taskCount,
      status: skuStatus,
      ...suggestion,
    });
  }

  const snapshotAt = sohRows.reduce((latest, row) => {
    if (!row.snapshot_at) return latest;

    const value = new Date(row.snapshot_at).toISOString();
    return !latest || value > latest ? value : latest;
  }, null);

  return {
    ok: true,
    doi: rounded(doi),
    snapshot_at: snapshotAt,
    summary: {
      param_sku_count: params.length,

      soh_sku_count: skuRows.filter((row) => row.status !== "NO_SOH").length,

      missing_soh_sku_count: skuRows.filter((row) => row.status === "NO_SOH")
        .length,

      replenishment_sku_count: skuRows.filter(
        (row) => row.status !== "NO_SOH" && row.replenish_qty > 0,
      ).length,

      task_sku_count: new Set(candidates.map((task) => task.sku_number)).size,

      ready_sku_count: skuRows.filter((row) => row.status === "READY").length,

      partial_sku_count: skuRows.filter((row) => row.status === "PARTIAL")
        .length,

      stock_not_enough_sku_count: skuRows.filter(
        (row) => row.status === "STOCK_NOT_ENOUGH",
      ).length,

      task_count: candidates.length,
      required_qty: rounded(totalRequiredQty),
      allocated_qty: rounded(totalAllocatedQty),
      shortage_qty: rounded(totalShortageQty),
      skipped_existing_source_count: skippedExistingCount,
      existing_task_key_count: existingKeySet.size,
    },
    sku_rows: skuRows,
    tasks: candidates,
  };
}

async function loadSohRows(params) {
  const skuNumbers = params.map((row) => row.sku_number).filter(Boolean);

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

    return {
      product_id: clean(task.product_id),
      sku_number: skuNumber,
      product_name: clean(task.product_name),
      doi: rounded(task.doi),
      max_pf: rounded(task.max_pf),
      target_pf: rounded(task.target_pf),
      pickface_stock: rounded(task.pickface_stock),
      replenish_qty: rounded(task.replenish_qty),
      from_rack_name: fromRackName,
      source_stock: rounded(task.source_stock),
      allocated_qty: allocatedQty,
      suggested_zone: clean(task.suggested_zone),
      suggested_aisle: clean(task.suggested_aisle),
      status: clean(task.status) || "GENERATED",
    };
  });
}

async function handleGet(req, res) {
  const doi = number(req.query.doi || 1);

  if (!Number.isFinite(doi) || doi <= 0) {
    return json(res, 400, {
      ok: false,
      message: "DOI wajib berupa angka lebih dari 0.",
    });
  }

  const [paramPayload, keyPayload] = await Promise.all([
    fetchGasAction("param"),
    fetchGasAction("keys"),
  ]);

  const params = normalizeParamRows(paramPayload.rows);
  const sohRows = await loadSohRows(params);

  return json(
    res,
    200,
    buildCalculator({
      params,
      sohRows,
      existingKeys: keyPayload.keys,
      doi,
    }),
  );
}

async function handlePost(req, res) {
  const tasks = normalizePostedTasks(req.body?.tasks);
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

    return json(res, 500, {
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
  suggestionFor,
};
