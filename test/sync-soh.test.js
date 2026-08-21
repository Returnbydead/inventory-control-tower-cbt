const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveRack,
  remarksZone,
  normalizeRow,
  supersetPayload,
  fetchSupersetRows,
  expireStaleSyncRuns,
} = require("../api/sync-soh")._test;

test("parses STL rack structure using aisle 33 and sequence 07", () => {
  assert.deepEqual(deriveRack("STL-SRA1-33-07-L2-C1"), {
    zone: "SRA1",
    aisle: "33",
    rack_sequence: "07",
    level: "L2",
  });
});

test("parses CBT mezzanine location", () => {
  assert.deepEqual(deriveRack("CBT-MZE1-03-05-L2-05"), {
    zone: "MZE1",
    aisle: "03",
    rack_sequence: "05",
    level: "L2",
  });
});

test("classifies storage and pickface", () => {
  assert.equal(remarksZone("STL-SRA1-33-07-L1-C1", "L1"), "PICKFACE");
  assert.equal(remarksZone("STL-SRA1-33-07-L2-C1", "L2"), "STORAGE");
  assert.equal(remarksZone("CBT-MZE1-03-05-L2-05", "L2"), "PICKFACE");
});

test("normalizes numeric inventory values", () => {
  const row = normalizeRow({
    location_name: "Cibitung",
    product_id: "123",
    sku_number: "SKU-1",
    rack_name: "STL-SRA1-33-07-L2-C1",
    stock: "12",
    stock_value: "45000",
  });
  assert.equal(row.stock, 12);
  assert.equal(row.stock_value, 45000);
  assert.equal(row.aisle, "33");
});

test("requests up to 100000 rows from Superset", () => {
  const payload = supersetPayload();
  assert.equal(payload.queries[0].row_limit, 100000);
  assert.equal(payload.form_data.row_limit, 100000);
});

test("SOH fetch recovers from transient CSRF 502 and chart 524 responses", async () => {
  const previousCookie = process.env.SUPERSET_SESSION_COOKIE;
  const previousBaseUrl = process.env.SUPERSET_BASE_URL;
  process.env.SUPERSET_SESSION_COOKIE = "test-session";
  process.env.SUPERSET_BASE_URL = "https://dash.example";

  const responses = [
    new Response("bad gateway", { status: 502 }),
    new Response('{"result":"csrf-token"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response("origin timeout", { status: 524 }),
    new Response('{"result":[{"data":[{"sku_number":"SKU-1"}]}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  let calls = 0;

  try {
    const rows = await fetchSupersetRows({
      fetchImpl: async () => responses[calls++],
      sleepImpl: async () => {},
      csrfTimeoutMs: 100,
      chartTimeoutMs: 100,
    });

    assert.deepEqual(rows, [{ sku_number: "SKU-1" }]);
    assert.equal(calls, 4);
  } finally {
    if (previousCookie === undefined) delete process.env.SUPERSET_SESSION_COOKIE;
    else process.env.SUPERSET_SESSION_COOKIE = previousCookie;
    if (previousBaseUrl === undefined) delete process.env.SUPERSET_BASE_URL;
    else process.env.SUPERSET_BASE_URL = previousBaseUrl;
  }
});

test("expires a RUNNING sync after the Vercel timeout window", async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rowCount: 1 };
    },
  };

  const expired = await expireStaleSyncRuns(client);

  assert.equal(expired, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /status = 'FAILED'/);
  assert.match(calls[0].sql, /INTERVAL '6 minutes'/);
  assert.match(calls[0].sql, /finished_at = CURRENT_TIMESTAMP/);
});
