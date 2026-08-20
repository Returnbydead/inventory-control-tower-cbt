const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(
  process.argv[2] || path.join(__dirname, '..', 'apps-script', 'sync-soh-stable.gs')
);
const source = fs.readFileSync(sourcePath, 'utf8');

const context = {
  console: {
    log() {},
    warn() {},
    error() {}
  },
  LockService: {
    getScriptLock() {
      return {
        tryLock() {
          return false;
        },
        releaseLock() {
          throw new Error('Lock yang tidak didapat tidak boleh di-release.');
        }
      };
    }
  },
  SpreadsheetApp: {
    openById() {
      return {
        getSheetByName() {
          return null;
        }
      };
    }
  }
};

vm.createContext(context);
vm.runInContext(
  `${source}\n;globalThis.__syncUnderTest = ` +
    `(typeof syncSOHStable === 'function' ? syncSOHStable : syncSOH);` +
    `globalThis.__installUnderTest = ` +
    `(typeof installSOHStableTrigger30Minutes === 'function' ` +
    `? installSOHStableTrigger30Minutes : null);` +
    `globalThis.__writeUnderTest = ` +
    `(typeof writeSOHDataStable_ === 'function' ` +
    `? writeSOHDataStable_ : null);` +
    `globalThis.__configDefined = typeof SOH_CONFIG !== 'undefined';`,
  context,
  { filename: sourcePath }
);

let result;
assert.doesNotThrow(() => {
  result = context.__syncUnderTest();
}, 'Run kedua saat lock sibuk harus selesai sebagai SKIPPED, bukan Failed.');

assert.equal(result && result.status, 'SKIPPED');
assert.equal(result && result.reason, 'LOCKED');
assert.equal(
  context.__configDefined,
  true,
  'File GAS harus standalone dan mendefinisikan SOH_CONFIG sendiri.'
);
assert.match(source, /tryLock\(SOH_STABLE_CONFIG\.LOCK_WAIT_MS\)/);
assert.match(source, /everyMinutes\(SOH_STABLE_CONFIG\.TRIGGER_MINUTES\)/);
assert.match(source, /TRIGGER_MINUTES:\s*30/);
assert.doesNotMatch(source, /\.clearContents\(\)/);
assert.doesNotMatch(source, /\.clearFormats\(\)/);
assert.doesNotMatch(source, /SpreadsheetApp\.flush\(\)/);

if (context.__installUnderTest) {
  const existingTriggers = [
    { getHandlerFunction: () => 'syncSOH' },
    { getHandlerFunction: () => 'syncSOHStable' },
    { getHandlerFunction: () => 'doGet' }
  ];
  const deletedTriggers = [];
  const createdTriggers = [];

  context.ScriptApp = {
    getProjectTriggers() {
      return existingTriggers;
    },
    deleteTrigger(trigger) {
      deletedTriggers.push(trigger.getHandlerFunction());
    },
    newTrigger(handler) {
      const created = { handler, minutes: null };
      createdTriggers.push(created);
      return {
        timeBased() {
          return this;
        },
        everyMinutes(minutes) {
          created.minutes = minutes;
          return this;
        },
        create() {
          return created;
        }
      };
    }
  };

  let installResult;
  assert.doesNotThrow(() => {
    installResult = context.__installUnderTest();
  }, 'Installer standalone tidak boleh gagal karena SOH_CONFIG/helper hilang.');

  assert.deepEqual(
    Array.from(deletedTriggers),
    ['syncSOH', 'syncSOHStable']
  );
  assert.equal(createdTriggers.length, 1);
  assert.equal(createdTriggers[0].handler, 'syncSOHStable');
  assert.equal(createdTriggers[0].minutes, 30);
  assert.equal(installResult.deletedTriggers, 2);
}

if (context.__writeUnderTest) {
  const setValuesCalls = [];
  const propertyStore = {};
  const range = (row, column, numRows, numColumns) => ({
    setValues(values) {
      setValuesCalls.push({ row, column, numRows, numColumns, values });
      return this;
    },
    setFontWeight() { return this; },
    setBackground() { return this; },
    setHorizontalAlignment() { return this; },
    setNumberFormat() { return this; },
    setNote() { return this; },
    clearContent() { return this; }
  });
  const sheet = {
    getLastRow: () => 54210,
    getLastColumn: () => 2,
    getMaxRows: () => 60000,
    getMaxColumns: () => 10,
    getSheetId: () => 123,
    getFrozenRows: () => 1,
    getRange(row, column, numRows, numColumns) {
      if (typeof row === 'string') {
        return range(row, null, null, null);
      }
      return range(row, column, numRows, numColumns);
    }
  };
  const spreadsheet = {
    getId: () => 'spreadsheet-test',
    getSheetByName: () => sheet
  };

  context.PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(key) { return propertyStore[key] || null; },
        setProperty(key, value) { propertyStore[key] = value; },
        getProperties() { return { ...propertyStore }; },
        deleteProperty(key) { delete propertyStore[key]; }
      };
    }
  };
  context.Utilities = {
    formatDate() { return '11/08/2026 18:00:00'; }
  };

  const headers = ['sku_number', 'stock'];
  const rows = Array.from(
    { length: 54209 },
    (_, index) => [String(index), index]
  );

  context.__writeUnderTest(spreadsheet, headers, rows);

  assert.equal(
    setValuesCalls.length,
    1,
    '54.209 row harus ditulis dalam satu bulk setValues agar kalkulasi tidak berulang.'
  );
  assert.equal(setValuesCalls[0].numRows, 54210);
}

console.log('PASS: collision di-skip, trigger tunggal 30 menit, dan 54.209 row ditulis sekali.');
