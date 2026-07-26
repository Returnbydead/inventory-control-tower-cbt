const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchPutawayTasks,
  fetchPutawayItems,
  fetchPurchaseOrders,
  requestHeaders,
} = require("../lib/wms-client");

test("builds server-side WMS authorization headers", () => {
  process.env.WMS_ACCESS_TOKEN = "test-token";
  process.env.WMS_DEVICE = "desktop-admin";
  process.env.WMS_DEVICE_ID = "123";
  const headers = requestHeaders();
  assert.equal(headers.authorization, "Bearer test-token");
  assert.equal(headers["x-device"], "desktop-admin");
  assert.equal(headers["x-device-id"], "123");
});

test("paginates CBT putaway list until a short page", async () => {
  process.env.WMS_ACCESS_TOKEN = "test-token";
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get("pagination.page_index");
    const count = page === "1" ? 2 : 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ error: { status: false }, data: Array(count).fill({ id: 1 }) }),
    };
  };
  const result = await fetchPutawayTasks({
    pageSize: 2,
    maxPages: 5,
    fetchImpl: fakeFetch,
  });
  assert.equal(result.rows.length, 3);
  assert.equal(result.complete, true);
  assert.match(calls[0], /location_ids=819/);
});

test("paginates task items on the WIMS v2 endpoint", async () => {
  process.env.WMS_ACCESS_TOKEN = "test-token";
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ error: { status: false }, data: [] }),
    };
  };
  const rows = await fetchPutawayItems(1015162, { fetchImpl: fakeFetch });
  assert.deepEqual(rows, []);
  assert.match(calls[0], /\/wims\/internal\/v2\/putaway-tasks\/1015162\/items/);
});

test("follows commercial PO next_cursor until target PO is found", async () => {
  process.env.WMS_ACCESS_TOKEN = "test-token";
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const cursor = new URL(url).searchParams.get("cursor");
    return {
      ok: true,
      status: 200,
      json: async () => cursor
        ? {
          error: { status: false },
          pagination: { next_cursor: "" },
          data: [{ id: 2, purchase_order_number: "ID1/POR/TARGET" }],
        }
        : {
          error: { status: false },
          pagination: { next_cursor: "NEXT-CURSOR" },
          data: [{ id: 1, purchase_order_number: "ID1/POR/OTHER" }],
        },
    };
  };
  const result = await fetchPurchaseOrders({
    targetNumbers: ["ID1/POR/TARGET"],
    fetchImpl: fakeFetch,
  });
  assert.equal(result.rows[0].id, 2);
  assert.deepEqual(result.unresolved, []);
  assert.match(calls[1], /cursor=NEXT-CURSOR/);
});
