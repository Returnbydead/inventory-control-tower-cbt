const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const gasPath = path.join(root, 'apps-script', 'replenishment-static-backend.gs');
const htmlPath = path.join(root, 'public', 'preview', 'replenishment-calculator.html');

const gasSource = fs.readFileSync(gasPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

function clean(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const context = {
  console,
  Date,
  Set,
  Map,
  Object,
  Array,
  JSON,
  Math,
  String,
  Number,
  clean_: clean,
  number_: number,
  normalizeHeader_: (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
  buildTaskKey_: (sku, rack) => `${clean(sku)}|${clean(rack).toUpperCase()}`,
  LockService: {
    getUserLock: () => ({ scope: 'replenishment-writer' }),
    getScriptLock: () => ({ scope: 'global-script' }),
  },
};

vm.runInNewContext(
  `${gasSource}\nthis.__replenTest = {
    build: replenStaticBuildSnapshot_,
    parseRack: replenStaticParseRack_,
    taskWriteLock: typeof replenStaticGetTaskWriteLock_ === 'function'
      ? replenStaticGetTaskWriteLock_
      : null,
  };`,
  context,
  { filename: gasPath },
);

const { build, parseRack, taskWriteLock } = context.__replenTest;

function param(overrides = {}) {
  return {
    product_id: 'P1',
    sku_number: 'SKU1',
    product_name: 'Produk 1',
    l1_category_name: 'Minuman',
    soh: 30,
    storage: 28,
    pickface: 2,
    doi: 1,
    min_pf: 6,
    max_pf: 10,
    task_qty: 8,
    ...overrides,
  };
}

function soh(rackName, stock, overrides = {}) {
  const rack = parseRack(rackName);
  return {
    product_id: 'P1',
    sku_number: 'SKU1',
    product_name: 'Produk 1',
    rack_name: rackName,
    stock,
    l1_category_name: 'Minuman',
    zone: rack.zone,
    aisle: rack.aisle,
    rack_sequence: rack.rack_sequence,
    rack_level: rack.rack_level,
    remarks_zone: 'STORAGE',
    ...overrides,
  };
}

const planogram = [
  { category: 'Minuman', zone: 'SRA1', aisle_from: 1, aisle_to: 2 },
  { category: 'Minuman', zone: 'SRB1', aisle_from: 19, aisle_to: 20 },
];

test('uses Need Fulfill from Master Data 2 as the final quantity', () => {
  const result = build(
    [param({ task_qty: 8, pickface: 999, max_pf: 1 })],
    [soh('CBT-SRA1-01-01-L2-01', 10)],
    [],
    [],
    planogram,
  );

  assert.equal(result.summary.required_qty, 8);
  assert.equal(result.tasks[0].allocated_qty, 8);
});

test('does not replenish when Need Fulfill is zero', () => {
  const result = build(
    [param({ task_qty: 0 })],
    [soh('CBT-SRA1-01-01-L2-01', 100)],
    [],
    [],
    planogram,
  );

  assert.equal(result.summary.required_qty, 0);
  assert.equal(result.tasks.length, 0);
});

test('allocates the smallest valid storage rack first through L7', () => {
  const result = build(
    [param()],
    [
      soh('CBT-SRA1-02-01-L2-01', 10),
      soh('CBT-SRA1-01-01-L7-01', 5),
      soh('CBT-SRA1-03-01-L8-01', 1),
    ],
    [],
    [],
    planogram,
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(result.tasks.map((task) => [task.from_rack_name, task.allocated_qty]))),
    [
      ['CBT-SRA1-01-01-L7-01', 5],
      ['CBT-SRA1-02-01-L2-01', 3],
    ],
  );
});

test('SOH 2 source selection is driven by SPR rack zone and L2-L7 even when Remaks is blank', () => {
  const result = build(
    [param({ task_qty: 4 })],
    [soh('CBT-SRB1-09-01-L3-01', 7, { remarks_zone: '' })],
    [],
    [],
    planogram,
  );

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].allocated_qty, 4);
});

test('subtracts active generated quantity and skips an existing task key', () => {
  const result = build(
    [param()],
    [
      soh('CBT-SRA1-01-01-L2-01', 3),
      soh('CBT-SRA1-02-01-L2-01', 10),
    ],
    ['SKU1|CBT-SRA1-01-01-L2-01'],
    [{
      task_key: 'SKU1|OLD-RACK',
      sku_number: 'SKU1',
      allocated_qty: 2,
      status: 'GENERATED',
    }],
    planogram,
  );

  assert.equal(result.summary.remaining_required_qty, 6);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].from_rack_name, 'CBT-SRA1-02-01-L2-01');
  assert.equal(result.tasks[0].allocated_qty, 6);
});

test('keeps live Planogram routing and cross-zone options', () => {
  const result = build(
    [param()],
    [
      soh('CBT-SRB1-20-01-L1-01', 30, { remarks_zone: 'PICKFACE' }),
      soh('CBT-SRA1-01-01-L2-01', 8),
    ],
    [],
    [],
    planogram,
  );

  assert.equal(result.tasks[0].suggested_zone, 'SRB1');
  assert.equal(result.tasks[0].suggested_aisle, 20);
  assert.match(result.tasks[0].suggestion_options, /SRB1 - aisle 20/);
  assert.match(result.tasks[0].suggestion_options, /SRA1 - aisle 01/);
});

test('static UI calls Apps Script directly and never calls the Replenishment Vercel API', () => {
  assert.match(html, /https:\/\/script\.google\.com\/macros\/s\//);
  assert.match(html, /action", "replenishment_snapshot"/);
  assert.match(html, /kind: "replenishment_generate"/);
  assert.doesNotMatch(html, /\/api\/replenishment-calculator/);
  assert.doesNotMatch(html, /doiInput|doi_override|WEB_OVERRIDE/);

  const vercelIgnore = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8');
  assert.match(vercelIgnore, /^api\/replenishment-calculator\.js$/m);
});

test('Replenishment task writes use a lock isolated from long SOH sync runs', () => {
  assert.equal(typeof taskWriteLock, 'function');
  assert.equal(taskWriteLock().scope, 'replenishment-writer');
});

test('snapshot payload stays compact and a ten-minute cache warmer is available', () => {
  const result = build(
    [param()],
    [soh('CBT-SRA1-01-01-L2-01', 8)],
    [],
    [],
    planogram,
  );

  assert.equal(Object.hasOwn(result, 'sku_rows'), false);
  assert.match(gasSource, /CACHE_SECONDS: 900/);
  assert.match(gasSource, /function refreshReplenishmentStaticCache_/);
  assert.match(gasSource, /function installReplenishmentStaticCacheTrigger\(\)/);
  assert.match(gasSource, /ScriptApp\.deleteTrigger/);
  assert.match(gasSource, /everyMinutes\(10\)/);
});
