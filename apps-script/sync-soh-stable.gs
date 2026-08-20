/**
 * ============================================================
 * SYNC SOH STABLE - STANDALONE
 * ============================================================
 *
 * Cara pakai:
 * 1. Ganti file patch/legacy SOH dengan seluruh isi file standalone ini.
 *    Jangan biarkan SOH_CONFIG/helper SOH lama terduplikasi di project.
 * 2. Pastikan tidak ada eksekusi syncSOH yang masih Running.
 * 3. Jalankan installSOHStableTrigger30Minutes() satu kali.
 * 4. Jalankan syncSOHStable() satu kali untuk verifikasi.
 *
 * Installer menghapus trigger lama untuk syncSOH dan syncSOHStable, lalu
 * membuat tepat satu trigger syncSOHStable setiap 30 menit.
 */

const SOH_CONFIG = {
  SPREADSHEET_ID: '1sXemJ-p4DRXJ18BTtZo8pjvJeVJJhgJJMYnOlooOqps',

  TARGET_SHEET: 'SOH',
  COOKIE_SHEET: 'Cookies',
  COOKIE_CELL: 'A1',
  LOG_SHEET: 'SYNC_LOG',

  SUPERSET_BASE_URL: 'https://dash.astronauts.id',
  SLICE_ID: 21023,

  TIMEZONE: 'Asia/Jakarta',

  MAX_ROWS: 100000
};


const SOH_STABLE_CONFIG = {
  VERSION: '2026-08-11-bulk-v2',
  LOCK_WAIT_MS: 1000,
  TRIGGER_MINUTES: 30,
  FORMAT_PROPERTY_PREFIX: 'SOH_STABLE_FORMAT_STATE_'
};


/**
 * Sync SOH yang aman dari trigger overlap.
 *
 * Jika proses lain masih memegang ScriptLock, eksekusi langsung selesai
 * sebagai SKIPPED. Kondisi normal ini tidak dibuat menjadi Failed.
 */
function syncSOHStable() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(SOH_STABLE_CONFIG.LOCK_WAIT_MS)) {
    const skipped = {
      status: 'SKIPPED',
      reason: 'LOCKED',
      message: 'Sync lain masih berjalan.'
    };

    console.warn(JSON.stringify({
      event: 'SOH_SYNC_SKIPPED',
      reason: skipped.reason
    }));

    return skipped;
  }

  const startedAt = new Date();
  const startedMs = Date.now();
  let spreadsheet = null;
  let fetchedRows = 0;
  let fetchMs = 0;
  let writeMs = 0;

  try {
    spreadsheet = SpreadsheetApp.openById(
      SOH_CONFIG.SPREADSHEET_ID
    );

    const fetchStartedMs = Date.now();
    const cookie = getSOHSupersetCookie_(spreadsheet);
    const csrfToken = getSOHSupersetCsrfToken_(cookie);
    const queryContext = getSOHSavedChartQueryContext_(
      cookie,
      csrfToken
    );
    const result = fetchSOHSupersetData_(
      queryContext,
      cookie,
      csrfToken
    );

    fetchMs = Date.now() - fetchStartedMs;
    fetchedRows = result.rows.length;

    if (fetchedRows === 0) {
      throw new Error(
        'Superset mengembalikan 0 baris. Data SOH lama tidak dihapus.'
      );
    }

    if (fetchedRows >= SOH_CONFIG.MAX_ROWS) {
      throw new Error(
        'Data SOH mencapai row limit ' +
        SOH_CONFIG.MAX_ROWS +
        '. Snapshot tidak ditulis agar tidak terpotong.'
      );
    }

    const writeStartedMs = Date.now();
    writeSOHDataStable_(
      spreadsheet,
      result.headers,
      result.rows
    );
    writeMs = Date.now() - writeStartedMs;

    const durationMs = Date.now() - startedMs;
    const message = [
      'version=' + SOH_STABLE_CONFIG.VERSION,
      'write_mode=single_bulk',
      'fetch_ms=' + fetchMs,
      'write_ms=' + writeMs,
      'total_ms=' + durationMs
    ].join('; ');

    writeSOHSyncLog_(spreadsheet, {
      startedAt: startedAt,
      finishedAt: new Date(),
      status: 'SUCCESS',
      rows: fetchedRows,
      message: message
    });

    const success = {
      status: 'SUCCESS',
      version: SOH_STABLE_CONFIG.VERSION,
      writeMode: 'SINGLE_BULK',
      rows: fetchedRows,
      fetchMs: fetchMs,
      writeMs: writeMs,
      durationMs: durationMs
    };

    console.log(JSON.stringify({
      event: 'SOH_SYNC_SUCCESS',
      result: success
    }));

    return success;
  } catch (error) {
    const errorMessage = String(
      error && error.message ? error.message : error
    );

    if (spreadsheet) {
      try {
        writeSOHSyncLog_(spreadsheet, {
          startedAt: startedAt,
          finishedAt: new Date(),
          status: 'FAILED',
          rows: fetchedRows,
          message: errorMessage
        });
      } catch (logError) {
        console.error(JSON.stringify({
          event: 'SOH_SYNC_LOG_FAILED',
          message: String(logError)
        }));
      }
    }

    console.error(JSON.stringify({
      event: 'SOH_SYNC_FAILED',
      message: errorMessage
    }));

    throw error;
  } finally {
    lock.releaseLock();
  }
}


/**
 * Menulis snapshot tanpa menghapus seluruh isi/format sheet.
 *
 * - Area snapshot aktif langsung ditimpa.
 * - Hanya ekor data lama yang dibersihkan jika snapshot mengecil.
 * - Format hanya diterapkan saat schema berubah atau jumlah row bertambah.
 * - Commit dibiarkan pada akhir run tanpa memaksa flush sinkron.
 */
function writeSOHDataStable_(spreadsheet, headers, rows) {
  if (!headers || headers.length === 0) {
    throw new Error('Header SOH kosong. Snapshot tidak ditulis.');
  }

  let sheet = spreadsheet.getSheetByName(
    SOH_CONFIG.TARGET_SHEET
  );

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      SOH_CONFIG.TARGET_SHEET
    );
  }

  const totalColumns = headers.length;
  const totalRows = rows.length + 1;
  const previousLastRow = sheet.getLastRow();
  const previousLastColumn = sheet.getLastColumn();

  ensureSOHSheetSize_(
    sheet,
    totalRows,
    totalColumns
  );

  /*
   * Data sudah berada penuh di memory setelah response Superset diparse.
   * Tulis header + seluruh row dalam satu operasi agar Google Sheets hanya
   * menjalankan dependency recalculation satu kali.
   */
  const snapshotValues = [headers].concat(rows);

  sheet
    .getRange(
      1,
      1,
      totalRows,
      totalColumns
    )
    .setValues(snapshotValues);

  sheet
    .getRange(1, 1, 1, totalColumns)
    .setFontWeight('bold')
    .setBackground('#d9ead3')
    .setHorizontalAlignment('center');

  clearSOHStaleTail_(
    sheet,
    previousLastRow,
    previousLastColumn,
    totalRows,
    totalColumns
  );

  applySOHFormatsIncrementally_(
    spreadsheet,
    sheet,
    headers,
    rows.length
  );

  if (sheet.getFrozenRows() !== 1) {
    sheet.setFrozenRows(1);
  }

  const syncedAt = Utilities.formatDate(
    new Date(),
    SOH_CONFIG.TIMEZONE,
    'dd/MM/yyyy HH:mm:ss'
  );

  sheet
    .getRange('A1')
    .setNote(
      'Last sync: ' +
      syncedAt +
      ' WIB\nSource: Superset slice ' +
      SOH_CONFIG.SLICE_ID
    );
}


/**
 * Bersihkan hanya area data lama yang tidak tertimpa snapshot baru.
 */
function clearSOHStaleTail_(
  sheet,
  previousLastRow,
  previousLastColumn,
  totalRows,
  totalColumns
) {
  if (previousLastRow > totalRows) {
    sheet
      .getRange(
        totalRows + 1,
        1,
        previousLastRow - totalRows,
        Math.max(previousLastColumn, totalColumns)
      )
      .clearContent();
  }

  if (
    previousLastColumn > totalColumns &&
    previousLastRow > 0
  ) {
    sheet
      .getRange(
        1,
        totalColumns + 1,
        Math.min(previousLastRow, totalRows),
        previousLastColumn - totalColumns
      )
      .clearContent();
  }
}


/**
 * Terapkan format hanya ketika dibutuhkan.
 */
function applySOHFormatsIncrementally_(
  spreadsheet,
  sheet,
  headers,
  dataRowCount
) {
  if (dataRowCount <= 0) {
    return;
  }

  const propertyKey = getSOHStableFormatPropertyKey_(
    spreadsheet,
    sheet
  );
  const properties = PropertiesService.getScriptProperties();
  const schema = headers.map(function(header) {
    return String(header).trim().toLowerCase();
  }).join('|');
  let state = null;

  try {
    state = JSON.parse(
      properties.getProperty(propertyKey) || 'null'
    );
  } catch (error) {
    state = null;
  }

  let startRow = 2;
  let rowCount = dataRowCount;

  if (state && state.schema === schema) {
    const formattedRows = Number(state.formattedRows) || 0;
    startRow = formattedRows + 2;
    rowCount = dataRowCount - formattedRows;
  }

  if (rowCount > 0) {
    applySOHFormatsToRange_(
      sheet,
      headers,
      startRow,
      rowCount
    );
  }

  properties.setProperty(
    propertyKey,
    JSON.stringify({
      schema: schema,
      formattedRows: Math.max(
        dataRowCount,
        state && state.schema === schema
          ? Number(state.formattedRows) || 0
          : 0
      )
    })
  );
}


function getSOHStableFormatPropertyKey_(
  spreadsheet,
  sheet
) {
  return SOH_STABLE_CONFIG.FORMAT_PROPERTY_PREFIX +
    spreadsheet.getId() +
    '_' +
    sheet.getSheetId();
}


/**
 * Adopsi format sheet lama agar migrasi pertama tidak memformat ulang semua row.
 */
function seedSOHStableFormatState_() {
  const spreadsheet = SpreadsheetApp.openById(
    SOH_CONFIG.SPREADSHEET_ID
  );
  const sheet = spreadsheet.getSheetByName(
    SOH_CONFIG.TARGET_SHEET
  );

  if (!sheet || sheet.getLastRow() < 1) {
    return false;
  }

  const lastColumn = sheet.getLastColumn();

  if (lastColumn < 1) {
    return false;
  }

  const headers = sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0];
  const schema = headers.map(function(header) {
    return String(header).trim().toLowerCase();
  }).join('|');
  const propertyKey = getSOHStableFormatPropertyKey_(
    spreadsheet,
    sheet
  );

  PropertiesService
    .getScriptProperties()
    .setProperty(
      propertyKey,
      JSON.stringify({
        schema: schema,
        formattedRows: Math.max(
          sheet.getLastRow() - 1,
          0
        )
      })
    );

  return true;
}


/**
 * Format kolom SOH pada subset row.
 */
function applySOHFormatsToRange_(
  sheet,
  headers,
  startRow,
  rowCount
) {
  const headerMap = {};

  headers.forEach(function(header, index) {
    headerMap[
      String(header).trim().toLowerCase()
    ] = index + 1;
  });

  [
    'product_id',
    'sku_number',
    'package_label',
    'rack_area_id'
  ].forEach(function(headerName) {
    setSOHColumnFormatStable_(
      sheet,
      headerMap,
      headerName,
      startRow,
      rowCount,
      '@'
    );
  });

  setSOHColumnFormatStable_(
    sheet,
    headerMap,
    'stock',
    startRow,
    rowCount,
    '#,##0.###'
  );
  setSOHColumnFormatStable_(
    sheet,
    headerMap,
    'stock_value',
    startRow,
    rowCount,
    '#,##0'
  );
  setSOHColumnFormatStable_(
    sheet,
    headerMap,
    'expiry_date',
    startRow,
    rowCount,
    'dd/MM/yyyy'
  );
  setSOHColumnFormatStable_(
    sheet,
    headerMap,
    'product_detail_updated_at',
    startRow,
    rowCount,
    'dd/MM/yyyy HH:mm:ss'
  );
}


function setSOHColumnFormatStable_(
  sheet,
  headerMap,
  headerName,
  startRow,
  rowCount,
  numberFormat
) {
  const columnIndex =
    headerMap[String(headerName).toLowerCase()];

  if (!columnIndex || rowCount <= 0) {
    return;
  }

  sheet
    .getRange(
      startRow,
      columnIndex,
      rowCount,
      1
    )
    .setNumberFormat(numberFormat);
}


/**
 * Hapus trigger legacy/duplikat, lalu pasang satu trigger stabil 30 menit.
 */
function installSOHStableTrigger30Minutes() {
  const deletedCount = deleteSOHStableTriggers_();
  const formatStateSeeded = seedSOHStableFormatState_();

  ScriptApp
    .newTrigger('syncSOHStable')
    .timeBased()
    .everyMinutes(SOH_STABLE_CONFIG.TRIGGER_MINUTES)
    .create();

  const result = {
    status: 'INSTALLED',
    version: SOH_STABLE_CONFIG.VERSION,
    handler: 'syncSOHStable',
    everyMinutes: SOH_STABLE_CONFIG.TRIGGER_MINUTES,
    deletedTriggers: deletedCount,
    formatStateSeeded: formatStateSeeded
  };

  console.log(JSON.stringify({
    event: 'SOH_TRIGGER_INSTALLED',
    result: result
  }));

  return result;
}


/**
 * Hapus semua trigger SOH lama dan trigger stabil duplikat.
 */
function deleteSOHStableTriggers_() {
  const handlers = {
    syncSOH: true,
    syncSOHStable: true
  };
  let deletedCount = 0;

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers[trigger.getHandlerFunction()]) {
      ScriptApp.deleteTrigger(trigger);
      deletedCount += 1;
    }
  });

  return deletedCount;
}


/**
 * Paksa format penuh pada run berikutnya jika format sheet diubah manual.
 */
function resetSOHStableFormatState() {
  const properties = PropertiesService.getScriptProperties();
  const allProperties = properties.getProperties();
  let deletedCount = 0;

  Object.keys(allProperties).forEach(function(key) {
    if (
      key.indexOf(
        SOH_STABLE_CONFIG.FORMAT_PROPERTY_PREFIX
      ) === 0
    ) {
      properties.deleteProperty(key);
      deletedCount += 1;
    }
  });

  console.log(JSON.stringify({
    event: 'SOH_FORMAT_STATE_RESET',
    deletedProperties: deletedCount
  }));

  return deletedCount;
}


function getSOHSupersetCookie_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    SOH_CONFIG.COOKIE_SHEET
  );

  if (!sheet) {
    throw new Error(
      'Sheet "' +
      SOH_CONFIG.COOKIE_SHEET +
      '" tidak ditemukan.'
    );
  }

  let cookie = String(
    sheet
      .getRange(SOH_CONFIG.COOKIE_CELL)
      .getDisplayValue() || ''
  ).trim();

  if (!cookie) {
    throw new Error(
      'Cookie Superset kosong di ' +
      SOH_CONFIG.COOKIE_SHEET +
      '!' +
      SOH_CONFIG.COOKIE_CELL
    );
  }

  if (
    !cookie.includes('session=') &&
    !cookie.includes(';')
  ) {
    cookie = 'session=' + cookie;
  }

  return cookie;
}


/**
 * Ambil CSRF token Superset.
 */
function getSOHSupersetCsrfToken_(cookie) {
  const url =
    SOH_CONFIG.SUPERSET_BASE_URL +
    '/api/v1/security/csrf_token/';

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Accept: 'application/json',
      Cookie: cookie,
      Referer: SOH_CONFIG.SUPERSET_BASE_URL + '/'
    },
    muteHttpExceptions: true
  });

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      'Gagal mengambil CSRF token SOH. HTTP ' +
      statusCode +
      ': ' +
      responseText.slice(0, 300)
    );
  }

  const payload = JSON.parse(responseText);
  const csrfToken = String(
    payload.result || ''
  ).trim();

  if (!csrfToken) {
    throw new Error(
      'Superset tidak mengembalikan CSRF token.'
    );
  }

  return csrfToken;
}


/**
 * Ambil query_context terbaru dari chart 21023.
 *
 * Metric, calculated column, filter, Remaks_Zone,
 * Zone, dan lvl mengikuti chart Superset.
 */
function getSOHSavedChartQueryContext_(
  cookie,
  csrfToken
) {
  const url =
    SOH_CONFIG.SUPERSET_BASE_URL +
    '/api/v1/chart/' +
    SOH_CONFIG.SLICE_ID;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Accept: 'application/json',
      Cookie: cookie,
      Referer:
        SOH_CONFIG.SUPERSET_BASE_URL +
        '/superset/explore/?slice_id=' +
        SOH_CONFIG.SLICE_ID,
      'X-CSRFToken': csrfToken
    },
    muteHttpExceptions: true
  });

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      'Gagal membaca chart SOH ' +
      SOH_CONFIG.SLICE_ID +
      '. HTTP ' +
      statusCode +
      ': ' +
      responseText.slice(0, 300)
    );
  }

  const payload = JSON.parse(responseText);
  const chart = payload.result || {};

  let queryContext = chart.query_context;

  if (typeof queryContext === 'string') {
    queryContext = JSON.parse(queryContext);
  }

  if (
    !queryContext ||
    !Array.isArray(queryContext.queries) ||
    queryContext.queries.length === 0
  ) {
    throw new Error(
      'Chart SOH tidak memiliki query_context yang valid.'
    );
  }

  queryContext.force = false;
  queryContext.result_format = 'json';
  queryContext.result_type = 'full';

  queryContext.queries.forEach(function(query) {
    query.row_limit = SOH_CONFIG.MAX_ROWS;
  });

  if (!queryContext.form_data) {
    queryContext.form_data = {};
  }

  queryContext.form_data.slice_id =
    SOH_CONFIG.SLICE_ID;

  queryContext.form_data.result_format = 'json';
  queryContext.form_data.result_type = 'full';
  queryContext.form_data.row_limit =
    SOH_CONFIG.MAX_ROWS;

  return queryContext;
}


/**
 * Request data SOH dari Superset.
 */
function fetchSOHSupersetData_(
  queryContext,
  cookie,
  csrfToken
) {
  const formData = encodeURIComponent(
    JSON.stringify({
      slice_id: SOH_CONFIG.SLICE_ID
    })
  );

  const url =
    SOH_CONFIG.SUPERSET_BASE_URL +
    '/api/v1/chart/data?form_data=' +
    formData;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(queryContext),
    headers: {
      Accept: 'application/json',
      Cookie: cookie,
      Referer:
        SOH_CONFIG.SUPERSET_BASE_URL +
        '/superset/explore/?slice_id=' +
        SOH_CONFIG.SLICE_ID,
      'X-CSRFToken': csrfToken
    },
    muteHttpExceptions: true
  });

  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      'Request SOH Superset gagal. HTTP ' +
      statusCode +
      ': ' +
      responseText.slice(0, 500)
    );
  }

  const payload = JSON.parse(responseText);
  const result =
    payload.result && payload.result[0];

  if (!result) {
    throw new Error(
      'Respons SOH tidak memiliki result[0].'
    );
  }

  const sourceRows = Array.isArray(result.data)
    ? result.data
    : [];

  let headers = Array.isArray(result.colnames)
    ? result.colnames
    : [];

  if (
    headers.length === 0 &&
    sourceRows.length > 0 &&
    typeof sourceRows[0] === 'object'
  ) {
    headers = Object.keys(sourceRows[0]);
  }

  if (headers.length === 0) {
    throw new Error(
      'Header SOH tidak ditemukan.'
    );
  }

  const rows = sourceRows.map(function(row) {
    if (Array.isArray(row)) {
      return row.map(function(value, index) {
        return normalizeSOHCellValue_(
          value,
          headers[index]
        );
      });
    }

    return headers.map(function(header) {
      return normalizeSOHCellValue_(
        row[header],
        header
      );
    });
  });

  return {
    headers: headers,
    rows: rows
  };
}


/**
 * Normalisasi nilai SOH.
 */
function normalizeSOHCellValue_(value, header) {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  const columnName = String(
    header || ''
  ).trim().toLowerCase();

  /*
   * Kolom ini wajib menjadi text agar:
   * - SKU nol depan tidak hilang
   * - Product ID tidak berubah format
   * - Package label aman
   */
  const textColumns = [
    'product_id',
    'sku_number',
    'package_label',
    'rack_area_id'
  ];

  if (textColumns.includes(columnName)) {
    return String(value);
  }

  /*
   * Konversi kolom tanggal.
   */
  if (columnName === 'expiry_date') {
    return parseSOHDate_(value);
  }

  if (columnName === 'product_detail_updated_at') {
    return parseSOHDateTime_(value);
  }

  /*
   * Kolom numerik.
   */
  const numericColumns = [
    'stock',
    'stock_value'
  ];

  if (numericColumns.includes(columnName)) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
      ? numericValue
      : 0;
  }

  return value;
}


/**
 * Parse tanggal expiry.
 */
function parseSOHDate_(value) {
  if (value instanceof Date) {
    return value;
  }

  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const date = new Date(text);

  if (isNaN(date.getTime())) {
    return text;
  }

  return date;
}


/**
 * Parse datetime product update.
 */
function parseSOHDateTime_(value) {
  if (value instanceof Date) {
    return value;
  }

  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const date = new Date(text);

  if (isNaN(date.getTime())) {
    return text;
  }

  return date;
}


/**
 * Overwrite tab SOH.
 */


function ensureSOHSheetSize_(
  sheet,
  requiredRows,
  requiredColumns
) {
  const currentRows = sheet.getMaxRows();
  const currentColumns = sheet.getMaxColumns();

  if (currentRows < requiredRows) {
    sheet.insertRowsAfter(
      currentRows,
      requiredRows - currentRows
    );
  }

  if (currentColumns < requiredColumns) {
    sheet.insertColumnsAfter(
      currentColumns,
      requiredColumns - currentColumns
    );
  }
}


/**
 * Tulis log SOH ke SYNC_LOG yang sama.
 */
function writeSOHSyncLog_(
  spreadsheet,
  logData
) {
  let sheet = spreadsheet.getSheetByName(
    SOH_CONFIG.LOG_SHEET
  );

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      SOH_CONFIG.LOG_SHEET
    );

    sheet.appendRow([
      'Started At',
      'Finished At',
      'Status',
      'Rows',
      'Message',
      'Slice ID'
    ]);

    sheet
      .getRange(1, 1, 1, 6)
      .setFontWeight('bold')
      .setBackground('#d9ead3');

    sheet.setFrozenRows(1);
  }

  sheet.appendRow([
    Utilities.formatDate(
      logData.startedAt,
      SOH_CONFIG.TIMEZONE,
      'dd/MM/yyyy HH:mm:ss'
    ),
    Utilities.formatDate(
      logData.finishedAt,
      SOH_CONFIG.TIMEZONE,
      'dd/MM/yyyy HH:mm:ss'
    ),
    logData.status,
    logData.rows || 0,
    logData.message || '',
    SOH_CONFIG.SLICE_ID
  ]);
}


/**
 * Buat trigger sync SOH setiap 10 menit.
 *
 * Jalankan fungsi ini satu kali saja.
 */
