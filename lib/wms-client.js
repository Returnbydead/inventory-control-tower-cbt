const WMS_BASE_URL = "https://api.astronauts.id";
const CBT_LOCATION_ID = 819;

function clean(value) {
  return String(value ?? "").trim();
}

function wmsConfig() {
  const token = clean(process.env.WMS_ACCESS_TOKEN);
  if (!token) throw new Error("WMS_ACCESS_TOKEN belum diset.");
  return {
    token,
    device: clean(process.env.WMS_DEVICE || "desktop-admin"),
    deviceId: clean(process.env.WMS_DEVICE_ID),
  };
}

function requestHeaders() {
  const config = wmsConfig();
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${config.token}`,
    origin: "https://admin.astronauts.id",
    referer: "https://admin.astronauts.id/",
    "x-device": config.device,
  };
  if (config.deviceId) headers["x-device-id"] = config.deviceId;
  return headers;
}

async function getJson(path, fetchImpl = fetch) {
  const response = await fetchImpl(`${WMS_BASE_URL}${path}`, {
    method: "GET",
    headers: requestHeaders(),
  });
  if (response.status === 401) {
    const error = new Error("WMS authentication expired.");
    error.code = "WMS_UNAUTHORIZED";
    throw error;
  }
  if (!response.ok) {
    throw new Error(`WMS request gagal: HTTP ${response.status} ${path}`);
  }
  const payload = await response.json();
  if (payload?.error?.status) {
    throw new Error(`WMS error: ${clean(payload.error.message) || payload.error.code}`);
  }
  return payload;
}

async function fetchPutawayTasks({
  pageSize = 100,
  maxPages = 30,
  fetchImpl = fetch,
} = {}) {
  const rows = [];
  let complete = false;
  const pages = await Promise.all(Array.from({ length: maxPages }, async (_, index) => {
    const page = index + 1;
    const query = new URLSearchParams({
      "pagination.page_index": String(page),
      "pagination.page_size": String(pageSize),
      location_ids: String(CBT_LOCATION_ID),
    });
    const payload = await getJson(
      `/wims/internal/v1/putaway-tasks?${query}`,
      fetchImpl,
    );
    return Array.isArray(payload?.data) ? payload.data : [];
  }));
  for (const data of pages) {
    rows.push(...data);
    if (data.length < pageSize) {
      complete = true;
      break;
    }
  }
  return { rows, complete };
}

async function fetchPutawayDetail(taskId, fetchImpl = fetch) {
  return getJson(`/wims/internal/v1/putaway-tasks/${Number(taskId)}`, fetchImpl);
}

async function fetchPutawayItems(taskId, {
  pageSize = 20,
  maxPages = 20,
  fetchImpl = fetch,
} = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({
      "pagination.page_index": String(page),
      "pagination.page_size": String(pageSize),
    });
    const payload = await getJson(
      `/wims/internal/v2/putaway-tasks/${Number(taskId)}/items?${query}`,
      fetchImpl,
    );
    const data = Array.isArray(payload?.data) ? payload.data : [];
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

async function fetchPurchaseOrders({
  targetNumbers = [],
  pageSize = 50,
  maxPages = 30,
  fetchImpl = fetch,
} = {}) {
  const targets = new Set(targetNumbers.filter(Boolean));
  const found = new Map();
  let cursor = "";
  let complete = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({
      page_size: String(pageSize),
      location_types: "WAREHOUSE",
      destination_ids: String(CBT_LOCATION_ID),
    });
    if (cursor) query.set("cursor", cursor);
    const payload = await getJson(
      `/commercial/internal/v1/purchase-orders?${query}`,
      fetchImpl,
    );
    const data = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of data) {
      const poNumber = clean(row.purchase_order_number);
      if (!targets.size || targets.has(poNumber)) found.set(poNumber, row);
    }
    cursor = clean(payload?.pagination?.next_cursor);
    if (!cursor || data.length === 0) {
      complete = true;
      break;
    }
    if (targets.size && [...targets].every((target) => found.has(target))) {
      break;
    }
  }
  return { rows: [...found.values()], complete, unresolved: [...targets].filter((x) => !found.has(x)) };
}

async function fetchPurchaseOrderDetail(poId, fetchImpl = fetch) {
  return getJson(
    `/commercial/internal/v1/purchase-orders/${Number(poId)}`,
    fetchImpl,
  );
}

module.exports = {
  CBT_LOCATION_ID,
  fetchPutawayTasks,
  fetchPutawayDetail,
  fetchPutawayItems,
  fetchPurchaseOrders,
  fetchPurchaseOrderDetail,
  requestHeaders,
};
