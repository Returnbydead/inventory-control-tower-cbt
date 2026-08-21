/**
 * Static Replenishment backend.
 *
 * UI is hosted as a static Vercel asset. All reads, calculations, validation,
 * and writes for Replenishment happen in this Apps Script project.
 *
 * This file is additive to the existing PARAM REPLEN Apps Script project and
 * intentionally reuses its CONFIG, TASK_HEADERS, getPlanogramRows_(),
 * getExistingTasks_(), getExistingTaskKeys_(), getOrCreateTaskSheet_(),
 * buildTaskKey_(), safeCell_(), clean_(), and number_() helpers.
 */

const REPLEN_STATIC_CONFIG = Object.freeze({
  INPUT_SPREADSHEET_ID: '1c7AJYYSO70wCZUmv3uiHSvA0tNciDEyEPBlPlEipvhw',
  PARAM_SHEET: 'Master Data 2',
  SOH_SHEET: 'SOH 2',
  CACHE_PREFIX: 'replenishment_static_v2',
  CACHE_SECONDS: 900,
  CACHE_CHUNK_SIZE: 80000,
  MAX_SELECTED_TASKS: 5000,
});

const REPLEN_STATIC_SOURCE_ZONES = new Set(['SRA1', 'SRB1', 'SRC1']);
const REPLEN_STATIC_SOURCE_LEVELS = new Set(['L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
const REPLEN_STATIC_INACTIVE_STATUSES = new Set([
  'CANCELLED',
  'CANCELED',
  'CLOSED',
  'COMPLETE',
  'COMPLETED',
  'DONE',
]);

/**
 * Keep task-writer serialization separate from long-running SOH syncs.
 * syncSOHStable uses the project-wide ScriptLock, so sharing that lock here
 * can block Replenishment writes for several minutes.
 */
function replenStaticGetTaskWriteLock_() {
  return LockService.getUserLock();
}

function getReplenishmentStaticSnapshot_(options) {
  const useCache = !options || options.useCache !== false;

  if (useCache) {
    const cached = replenStaticReadCache_();
    if (cached) {
      cached.cache_hit = true;
      return cached;
    }
  }

  const params = replenStaticReadParams_();
  const candidateSkuSet = new Set(
    params.filter(function(row) {
      return row.task_qty > 0;
    }).map(function(row) {
      return row.sku_number;
    })
  );
  const sohRows = replenStaticReadSoh_(candidateSkuSet);
  const existingTasks = getExistingTasks_();
  const existingKeys = getExistingTaskKeys_();
  const planogramRules = getPlanogramRows_();

  const snapshot = replenStaticBuildSnapshot_(
    params,
    sohRows,
    existingKeys,
    existingTasks,
    planogramRules
  );

  snapshot.cache_hit = false;
  replenStaticWriteCache_(snapshot);
  return snapshot;
}

function refreshReplenishmentStaticCache_() {
  return getReplenishmentStaticSnapshot_({ useCache: false });
}

function installReplenishmentStaticCacheTrigger() {
  const handler = 'refreshReplenishmentStaticCache_';
  const existing = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });

  existing.forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyMinutes(10)
    .create();

  return {
    ok: true,
    handler: handler,
    trigger_count: 1,
  };
}

function generateReplenishmentStaticTasks_(taskKeys) {
  const selectedKeys = replenStaticNormalizeSelectedKeys_(taskKeys);
  const snapshot = getReplenishmentStaticSnapshot_({ useCache: false });

  if (!snapshot.generation_enabled) {
    throw new Error(
      snapshot.generation_block_reason === 'OVERGENERATED'
        ? 'Generate dikunci karena ledger memiliki qty overgenerated.'
        : 'Generate dikunci karena ledger belum aman.'
    );
  }

  const currentByKey = new Map(snapshot.tasks.map(function(task) {
    return [task.task_key, task];
  }));
  const sheet = getOrCreateTaskSheet_();
  const existingKeys = new Set(getExistingTaskKeys_(sheet));
  const createdAt = Utilities.formatDate(
    new Date(),
    CONFIG.TIMEZONE,
    'dd/MM/yyyy HH:mm:ss'
  );
  const acceptedRows = [];
  const skippedRows = [];

  selectedKeys.forEach(function(taskKey) {
    const task = currentByKey.get(taskKey);

    if (!task) {
      skippedRows.push({
        task_key: taskKey,
        reason: 'Task tidak lagi valid pada snapshot terbaru',
      });
      return;
    }

    if (existingKeys.has(taskKey)) {
      skippedRows.push({
        task_key: taskKey,
        reason: 'Task key sudah pernah tergenerate',
      });
      return;
    }

    if (number_(task.allocated_qty) <= 0 || number_(task.allocated_qty) > number_(task.source_stock)) {
      skippedRows.push({
        task_key: taskKey,
        reason: 'Allocated qty tidak valid terhadap source stock terbaru',
      });
      return;
    }

    acceptedRows.push([
      safeCell_(task.task_key),
      createdAt,
      safeCell_(task.product_id),
      safeCell_(task.sku_number),
      safeCell_(task.product_name),
      number_(task.doi),
      number_(task.max_pf),
      number_(task.target_pf),
      number_(task.pickface_stock),
      number_(task.replenish_qty),
      safeCell_(task.from_rack_name),
      number_(task.source_stock),
      number_(task.allocated_qty),
      safeCell_(task.suggested_zone),
      safeCell_(task.suggested_aisle),
      'GENERATED',
      safeCell_(task.suggestion_options),
      safeCell_(task.suggested_rack_name),
    ]);
    existingKeys.add(taskKey);
  });

  if (acceptedRows.length) {
    sheet.getRange(
      sheet.getLastRow() + 1,
      1,
      acceptedRows.length,
      TASK_HEADERS.length
    ).setValues(acceptedRows);
  }

  replenStaticClearCache_();

  return {
    inserted: acceptedRows.length,
    skipped: skippedRows.length,
    skipped_rows: skippedRows,
    batch_count: 1,
  };
}

function replenStaticReadParams_() {
  const ss = SpreadsheetApp.openById(REPLEN_STATIC_CONFIG.INPUT_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(REPLEN_STATIC_CONFIG.PARAM_SHEET);

  if (!sheet) throw new Error('Sheet Master Data 2 tidak ditemukan.');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(1, 1, lastRow, 16).getValues();
  const headerIndex = values.slice(0, 10).findIndex(function(row) {
    return normalizeHeader_(row[0]) === 'product_id'
      && normalizeHeader_(row[1]) === 'sku_number';
  });

  if (headerIndex === -1) {
    throw new Error('Header Product_id / sku_number Master Data 2 tidak ditemukan.');
  }

  const bySku = new Map();

  values.slice(headerIndex + 1).forEach(function(row) {
    const skuNumber = clean_(row[1]);
    if (!skuNumber) return;

    bySku.set(skuNumber, {
      product_id: clean_(row[0]),
      sku_number: skuNumber,
      product_name: clean_(row[2]),
      l1_category_name: clean_(row[3]),
      is_bulky: clean_(row[4]),
      soh: replenStaticWholeQty_(row[5]),
      storage: replenStaticWholeQty_(row[6]),
      pickface: replenStaticWholeQty_(row[7]),
      doi: replenStaticRounded_(row[8]),
      min_pf: replenStaticWholeQty_(row[9]),
      max_pf: replenStaticWholeQty_(row[10]),
      task_qty: replenStaticWholeQty_(row[11]),
      spr_suggestion_area: clean_(row[12]).toUpperCase(),
      spr_suggestion_level: clean_(row[13]).toUpperCase(),
      mezz_suggestion_area: clean_(row[14]).toUpperCase(),
      mezz_suggestion_level: clean_(row[15]).toUpperCase(),
    });
  });

  return Array.from(bySku.values());
}

function replenStaticReadSoh_(candidateSkuSet) {
  if (!candidateSkuSet.size) return [];

  const ss = SpreadsheetApp.openById(REPLEN_STATIC_CONFIG.INPUT_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(REPLEN_STATIC_CONFIG.SOH_SHEET);

  if (!sheet) throw new Error('Sheet SOH 2 tidak ditemukan.');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // Read only the nine columns needed by the calculator instead of A:AA.
  const core = sheet.getRange(2, 2, lastRow - 1, 5).getValues(); // B:F
  const categories = sheet.getRange(2, 8, lastRow - 1, 1).getValues(); // H
  const locationMeta = sheet.getRange(2, 19, lastRow - 1, 3).getValues(); // S:U
  const rows = [];

  for (let index = 0; index < core.length; index += 1) {
    const skuNumber = clean_(core[index][1]);
    if (!candidateSkuSet.has(skuNumber)) continue;

    const rackName = clean_(core[index][3]).toUpperCase();
    const rackMeta = replenStaticParseRack_(rackName);
    const sheetZone = clean_(locationMeta[index][0]).toUpperCase();
    const sheetLevel = clean_(locationMeta[index][1]).toUpperCase();

    rows.push({
      product_id: clean_(core[index][0]),
      sku_number: skuNumber,
      product_name: clean_(core[index][2]),
      rack_name: rackName,
      stock: replenStaticRounded_(core[index][4]),
      l1_category_name: clean_(categories[index][0]),
      zone: rackMeta.zone || sheetZone,
      aisle: rackMeta.aisle,
      rack_sequence: rackMeta.rack_sequence,
      rack_level: rackMeta.rack_level || sheetLevel,
      remarks_zone: clean_(locationMeta[index][2]).toUpperCase(),
    });
  }

  return rows;
}

function replenStaticParseRack_(rackName) {
  const match = clean_(rackName).toUpperCase().match(
    /(?:^|-)([A-Z]{2,3}\d)-(\d{1,2})-(\d{1,2})-(L\d+)(?:-|$)/
  );

  return match ? {
    zone: match[1],
    aisle: String(number_(match[2])).padStart(2, '0'),
    rack_sequence: String(number_(match[3])).padStart(2, '0'),
    rack_level: match[4],
  } : {
    zone: '',
    aisle: '',
    rack_sequence: '',
    rack_level: '',
  };
}

function replenStaticBuildSnapshot_(params, sohRows, existingKeys, existingTasks, planogramRules) {
  const activeTasks = (existingTasks || []).filter(function(task) {
    return task.task_key
      && task.sku_number
      && number_(task.allocated_qty) > 0
      && !REPLEN_STATIC_INACTIVE_STATUSES.has(clean_(task.status).toUpperCase());
  });
  const existingKeySet = new Set((existingKeys || []).map(replenStaticNormalizeTaskKey_).filter(Boolean));
  const existingAllocatedBySku = new Map();

  activeTasks.forEach(function(task) {
    const taskKey = replenStaticNormalizeTaskKey_(task.task_key);
    if (taskKey) existingKeySet.add(taskKey);

    const skuNumber = clean_(task.sku_number) || clean_(taskKey.split('|')[0]);
    existingAllocatedBySku.set(
      skuNumber,
      replenStaticRounded_((existingAllocatedBySku.get(skuNumber) || 0) + number_(task.allocated_qty))
    );
  });

  const sohBySku = new Map();
  (sohRows || []).forEach(function(row) {
    const skuNumber = clean_(row.sku_number);
    if (!skuNumber) return;

    const group = sohBySku.get(skuNumber) || { all: [], storage: [] };
    group.all.push(row);

    if (
      REPLEN_STATIC_SOURCE_ZONES.has(clean_(row.zone).toUpperCase())
      && REPLEN_STATIC_SOURCE_LEVELS.has(clean_(row.rack_level).toUpperCase())
      && number_(row.stock) > 0
    ) {
      group.storage.push(row);
    }

    sohBySku.set(skuNumber, group);
  });

  const tasks = [];
  const skuRows = [];
  let totalRequiredQty = 0;
  let totalExistingAllocatedQty = 0;
  let totalExistingGeneratedQty = 0;
  let totalOvergeneratedQty = 0;
  let totalAllocatedQty = 0;
  let totalShortageQty = 0;
  let skippedExistingSourceCount = 0;

  (params || []).forEach(function(param) {
    const taskQty = replenStaticWholeQty_(param.task_qty);
    const existingGeneratedQty = replenStaticRounded_(existingAllocatedBySku.get(param.sku_number) || 0);
    const existingAllocatedQty = Math.min(taskQty, existingGeneratedQty);
    const overgeneratedQty = Math.max(0, existingGeneratedQty - taskQty);
    const remainingRequiredQty = Math.max(0, taskQty - existingAllocatedQty);

    totalRequiredQty += taskQty;
    totalExistingAllocatedQty += existingAllocatedQty;
    totalExistingGeneratedQty += existingGeneratedQty;
    totalOvergeneratedQty += overgeneratedQty;

    if (taskQty <= 0) {
      skuRows.push(replenStaticSkuResult_(param, {
        status: 'NO_REPLENISHMENT',
        existing_allocated_qty: existingAllocatedQty,
        existing_generated_qty: existingGeneratedQty,
        overgenerated_qty: overgeneratedQty,
      }));
      return;
    }

    if (remainingRequiredQty <= 0) {
      skuRows.push(replenStaticSkuResult_(param, {
        status: 'ALREADY_GENERATED',
        existing_allocated_qty: existingAllocatedQty,
        existing_generated_qty: existingGeneratedQty,
        overgenerated_qty: overgeneratedQty,
      }));
      return;
    }

    const group = sohBySku.get(param.sku_number) || { all: [], storage: [] };
    const suggestion = replenStaticSuggestionFor_(param, group, planogramRules || []);
    const sources = group.storage.slice().sort(function(left, right) {
      return number_(left.stock) - number_(right.stock)
        || clean_(left.rack_name).localeCompare(clean_(right.rack_name));
    });
    const seenSourceKeys = new Set();
    const pendingTasks = [];
    let remaining = remainingRequiredQty;
    let allocatedSkuQty = 0;

    sources.forEach(function(source) {
      if (remaining <= 0) return;

      const taskKey = buildTaskKey_(param.sku_number, source.rack_name);
      if (seenSourceKeys.has(taskKey)) return;
      seenSourceKeys.add(taskKey);

      if (existingKeySet.has(taskKey)) {
        skippedExistingSourceCount += 1;
        return;
      }

      const allocatedQty = replenStaticRounded_(Math.min(number_(source.stock), remaining));
      if (allocatedQty <= 0) return;

      pendingTasks.push({
        task_key: taskKey,
        product_id: clean_(param.product_id || (group.all[0] || {}).product_id),
        sku_number: param.sku_number,
        product_name: clean_(param.product_name || (group.all[0] || {}).product_name),
        doi: replenStaticRounded_(param.doi),
        max_pf: replenStaticWholeQty_(param.max_pf),
        target_pf: replenStaticWholeQty_(param.max_pf),
        pickface_stock: replenStaticWholeQty_(param.pickface),
        storage_stock: replenStaticWholeQty_(param.storage),
        need_qty: taskQty,
        replenish_qty: taskQty,
        task_qty: taskQty,
        from_rack_name: clean_(source.rack_name).toUpperCase(),
        source_stock: replenStaticRounded_(source.stock),
        allocated_qty: allocatedQty,
        suggested_zone: suggestion.suggested_zone,
        suggested_aisle: suggestion.suggested_aisle,
        suggestion_options: suggestion.suggestion_options,
        suggested_rack_name: suggestion.suggested_rack_name,
        suggestion_basis: suggestion.suggestion_basis,
      });

      remaining = replenStaticRounded_(remaining - allocatedQty);
      allocatedSkuQty = replenStaticRounded_(allocatedSkuQty + allocatedQty);
    });

    const shortageQty = Math.max(0, remainingRequiredQty - allocatedSkuQty);
    const status = shortageQty > 0
      ? allocatedSkuQty > 0 ? 'PARTIAL' : 'STOCK_NOT_ENOUGH'
      : 'READY';

    pendingTasks.forEach(function(task) {
      task.status = status;
      task.shortage_qty = shortageQty;
      tasks.push(task);
    });

    totalAllocatedQty += allocatedSkuQty;
    totalShortageQty += shortageQty;

    skuRows.push(replenStaticSkuResult_(param, Object.assign({
      status: status,
      existing_allocated_qty: existingAllocatedQty,
      existing_generated_qty: existingGeneratedQty,
      overgenerated_qty: overgeneratedQty,
      remaining_required_qty: remainingRequiredQty,
      allocated_qty: allocatedSkuQty,
      shortage_qty: shortageQty,
      source_count: pendingTasks.length,
      task_count: pendingTasks.length,
    }, suggestion)));
  });

  const ledgerReady = true;
  const ledgerSafe = replenStaticRounded_(totalOvergeneratedQty) <= 0;
  const snapshotAt = new Date().toISOString();

  return {
    ok: true,
    action: 'replenishment_snapshot',
    data_source: 'GSHEET_DIRECT',
    generation_enabled: ledgerReady && ledgerSafe,
    generation_block_reason: ledgerSafe ? null : 'OVERGENERATED',
    ledger_mode: 'TASKS',
    ledger_ready: ledgerReady,
    ledger_safe: ledgerSafe,
    doi: 0,
    doi_source: 'GSHEET',
    doi_override: null,
    snapshot_at: snapshotAt,
    planogram_source: 'GSHEET_LIVE',
    planogram_rule_count: (planogramRules || []).length,
    summary: {
      param_sku_count: (params || []).length,
      replenishment_sku_count: skuRows.filter(function(row) { return row.task_qty > 0; }).length,
      task_sku_count: new Set(tasks.map(function(task) { return task.sku_number; })).size,
      task_count: tasks.length,
      required_qty: replenStaticRounded_(totalRequiredQty),
      existing_allocated_qty: replenStaticRounded_(totalExistingAllocatedQty),
      existing_generated_qty: replenStaticRounded_(totalExistingGeneratedQty),
      overgenerated_qty: replenStaticRounded_(totalOvergeneratedQty),
      remaining_required_qty: replenStaticRounded_(Math.max(0, totalRequiredQty - totalExistingAllocatedQty)),
      allocated_qty: replenStaticRounded_(totalAllocatedQty),
      shortage_qty: replenStaticRounded_(totalShortageQty),
      skipped_existing_source_count: skippedExistingSourceCount,
      existing_task_key_count: existingKeySet.size,
    },
    tasks: tasks,
  };
}

function replenStaticSkuResult_(param, details) {
  return Object.assign({
    product_id: param.product_id,
    sku_number: param.sku_number,
    product_name: param.product_name,
    doi: replenStaticRounded_(param.doi),
    max_pf: replenStaticWholeQty_(param.max_pf),
    target_pf: replenStaticWholeQty_(param.max_pf),
    pickface_stock: replenStaticWholeQty_(param.pickface),
    storage_stock: replenStaticWholeQty_(param.storage),
    need_qty: replenStaticWholeQty_(param.task_qty),
    replenish_qty: replenStaticWholeQty_(param.task_qty),
    task_qty: replenStaticWholeQty_(param.task_qty),
    existing_allocated_qty: 0,
    existing_generated_qty: 0,
    overgenerated_qty: 0,
    remaining_required_qty: replenStaticWholeQty_(param.task_qty),
    allocated_qty: 0,
    shortage_qty: 0,
    source_count: 0,
    task_count: 0,
  }, details || {});
}

function replenStaticSuggestionFor_(param, group, planogramRules) {
  const category = clean_(param.l1_category_name)
    || (group.all || []).map(function(row) { return clean_(row.l1_category_name); }).find(Boolean)
    || '';
  const skuQtyByArea = new Map();

  (group.all || []).forEach(function(row) {
    const zone = clean_(row.zone).toUpperCase();
    const aisle = Math.trunc(number_(row.aisle));
    if (!zone || aisle <= 0) return;
    const key = zone + '|' + aisle;
    skuQtyByArea.set(key, replenStaticRounded_((skuQtyByArea.get(key) || 0) + number_(row.stock)));
  });

  const candidates = [];
  (planogramRules || []).forEach(function(rule) {
    if (clean_(rule.category).toLowerCase() !== category.toLowerCase()) return;

    for (let aisle = number_(rule.aisle_from); aisle <= number_(rule.aisle_to); aisle += 1) {
      const zone = clean_(rule.zone).toUpperCase();
      candidates.push({
        zone: zone,
        aisle: aisle,
        sku_qty: skuQtyByArea.get(zone + '|' + aisle) || 0,
      });
    }
  });

  candidates.sort(function(left, right) {
    return right.sku_qty - left.sku_qty
      || left.zone.localeCompare(right.zone)
      || left.aisle - right.aisle;
  });

  const picked = [];
  const pickedZones = new Set();
  candidates.forEach(function(candidate) {
    if (picked.length >= 4 || pickedZones.has(candidate.zone)) return;
    picked.push(candidate);
    pickedZones.add(candidate.zone);
  });
  candidates.forEach(function(candidate) {
    if (picked.length >= 4 || picked.includes(candidate)) return;
    picked.push(candidate);
  });

  const primary = picked[0] || null;

  return {
    suggested_zone: primary ? primary.zone : '',
    suggested_aisle: primary ? primary.aisle : '',
    suggestion_options: picked.map(function(area) {
      return area.zone + ' - aisle ' + String(area.aisle).padStart(2, '0');
    }).join(' | '),
    suggested_rack_name: '',
    suggestion_basis: primary ? 'PLANOGRAM_GSHEET' : 'NO_DESTINATION_SUGGESTION',
  };
}

function replenStaticNormalizeSelectedKeys_(taskKeys) {
  if (!Array.isArray(taskKeys) || !taskKeys.length) {
    throw new Error('Payload task_keys wajib berupa array dan tidak boleh kosong.');
  }

  if (taskKeys.length > REPLEN_STATIC_CONFIG.MAX_SELECTED_TASKS) {
    throw new Error('Maksimal ' + REPLEN_STATIC_CONFIG.MAX_SELECTED_TASKS + ' task per request.');
  }

  const normalized = Array.from(new Set(taskKeys.map(replenStaticNormalizeTaskKey_).filter(Boolean)));
  if (normalized.length !== taskKeys.length) {
    throw new Error('Setiap task_key wajib unik dan berformat SKU|SOURCE_RACK.');
  }

  return normalized;
}

function replenStaticNormalizeTaskKey_(value) {
  const raw = clean_(value);
  const separator = raw.indexOf('|');
  if (separator <= 0 || separator === raw.length - 1) return '';
  return buildTaskKey_(raw.slice(0, separator), raw.slice(separator + 1));
}

function replenStaticWholeQty_(value) {
  return Math.round(Math.max(0, number_(value)));
}

function replenStaticRounded_(value) {
  return Math.round(number_(value) * 1000) / 1000;
}

function replenStaticReadCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const manifest = JSON.parse(cache.get(REPLEN_STATIC_CONFIG.CACHE_PREFIX + ':manifest') || 'null');
    if (!manifest || !manifest.chunks) return null;

    let json = '';
    for (let index = 0; index < manifest.chunks; index += 1) {
      const chunk = cache.get(REPLEN_STATIC_CONFIG.CACHE_PREFIX + ':chunk:' + index);
      if (chunk === null) return null;
      json += chunk;
    }

    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function replenStaticWriteCache_(payload) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(payload);
    const chunks = [];

    for (let offset = 0; offset < json.length; offset += REPLEN_STATIC_CONFIG.CACHE_CHUNK_SIZE) {
      chunks.push(json.slice(offset, offset + REPLEN_STATIC_CONFIG.CACHE_CHUNK_SIZE));
    }

    const entries = {};
    chunks.forEach(function(chunk, index) {
      entries[REPLEN_STATIC_CONFIG.CACHE_PREFIX + ':chunk:' + index] = chunk;
    });
    entries[REPLEN_STATIC_CONFIG.CACHE_PREFIX + ':manifest'] = JSON.stringify({ chunks: chunks.length });
    cache.putAll(entries, REPLEN_STATIC_CONFIG.CACHE_SECONDS);
  } catch (error) {
    // Cache is an optimization. A cache quota miss must not break live data.
  }
}

function replenStaticClearCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const manifest = JSON.parse(cache.get(REPLEN_STATIC_CONFIG.CACHE_PREFIX + ':manifest') || 'null');
    const keys = [REPLEN_STATIC_CONFIG.CACHE_PREFIX + ':manifest'];

    for (let index = 0; index < number_((manifest || {}).chunks); index += 1) {
      keys.push(REPLEN_STATIC_CONFIG.CACHE_PREFIX + ':chunk:' + index);
    }

    cache.removeAll(keys);
  } catch (error) {
    // Ignore cache cleanup failures.
  }
}
