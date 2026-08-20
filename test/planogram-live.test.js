const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../lib/planogram-live");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function livePayload(category = "Minuman") {
  return {
    ok: true,
    rows: [{ category, zone: "SRA1", aisle_from: 1, aisle_to: 8 }],
  };
}

test("normalizes and deduplicates live Planogram API rows", () => {
  const rules = _test.normalizePlanogramRows([
    { category: " Minuman ", zone: "sra1", aisle_from: "1", aisle_to: "8" },
    { category: "Minuman", zone: "SRA1", aisle_from: 1, aisle_to: 8 },
    { category: "Vitamin", zone: "SRC1", aisle_from: 13, aisle_to: 13 },
  ]);

  assert.deepEqual(rules, [
    {
      category: "Minuman",
      zone: "SRA1",
      aisle_from: 1,
      aisle_to: 8,
      aisle_label: "01-08",
      source: "GSHEET_LIVE",
    },
    {
      category: "Vitamin",
      zone: "SRC1",
      aisle_from: 13,
      aisle_to: 13,
      aisle_label: "13",
      source: "GSHEET_LIVE",
    },
  ]);
});

test("rejects malformed or empty live Planogram data", () => {
  assert.throws(
    () => _test.normalizePlanogramRows([
      { category: "Minuman", zone: "SRA1", aisle_from: 8, aisle_to: 1 },
    ]),
    /rack suggestion tidak valid/i,
  );
  assert.throws(() => _test.normalizePlanogramRows([]), /aturan aktif/i);
  assert.throws(() => _test.normalizePlanogramRows(null), /array rows/i);
});

test("retries a transient Google HTML 404 before returning live rules", async () => {
  _test.resetLivePlanogramCache();
  const replies = [
    response(404, "<!DOCTYPE html><html>Google temporary page</html>"),
    response(200, livePayload()),
  ];
  let calls = 0;

  const result = await _test.fetchLivePlanogramRulesWith({
    fetchImpl: async () => {
      calls += 1;
      return replies.shift();
    },
    retries: 1,
    retryDelayMs: 0,
    cacheTtlMs: 0,
    gasUrlValue: "https://example.com/exec",
  });

  assert.equal(calls, 2);
  assert.equal(result.source, "GSHEET_LIVE");
  assert.equal(result.stale, false);
  assert.equal(result.rule_count, 1);
});

test("falls back to the last good in-memory snapshot when Google is unavailable", async () => {
  _test.resetLivePlanogramCache();
  await _test.fetchLivePlanogramRulesWith({
    fetchImpl: async () => response(200, livePayload("Vitamin")),
    retries: 0,
    cacheTtlMs: 0,
    gasUrlValue: "https://example.com/exec",
  });

  const result = await _test.fetchLivePlanogramRulesWith({
    fetchImpl: async () => response(404, "<!DOCTYPE html><html>Google temporary page</html>"),
    retries: 1,
    retryDelayMs: 0,
    cacheTtlMs: 0,
    gasUrlValue: "https://example.com/exec",
  });

  assert.equal(result.source, "GSHEET_CACHE");
  assert.equal(result.stale, true);
  assert.equal(result.rules[0].category, "Vitamin");
  assert.match(result.live_error, /HTTP 404/);
});

test("uses bundled last-known rules on a cold start but never for strict writes", async () => {
  _test.resetLivePlanogramCache();
  const unavailable = async () => response(404, "<!DOCTYPE html><html>Google temporary page</html>");

  const fallback = await _test.fetchLivePlanogramRulesWith({
    fetchImpl: unavailable,
    retries: 0,
    retryDelayMs: 0,
    cacheTtlMs: 0,
    gasUrlValue: "https://example.com/exec",
  });
  assert.equal(fallback.source, "GSHEET_LAST_KNOWN");
  assert.equal(fallback.stale, true);
  assert.ok(fallback.rule_count > 0);

  await assert.rejects(
    _test.fetchLivePlanogramRulesWith({
      fetchImpl: unavailable,
      retries: 0,
      retryDelayMs: 0,
      cacheTtlMs: 0,
      gasUrlValue: "https://example.com/exec",
      allowFallback: false,
    }),
    /HTTP 404/,
  );
});
