const test = require("node:test");
const assert = require("node:assert/strict");

const { requestWithTransientRetry } = require("../lib/superset-request");

test("retries a transient Superset 524 response and returns the next success", async () => {
  const responses = [
    new Response("upstream timeout", { status: 524 }),
    new Response('{"result":"ok"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  let calls = 0;

  const response = await requestWithTransientRetry("https://dash.example/api", {}, {
    attempts: 2,
    timeoutMs: 100,
    retryDelaysMs: [0],
    fetchImpl: async () => responses[calls++],
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("does not retry a Superset authentication failure", async () => {
  let calls = 0;
  const response = await requestWithTransientRetry("https://dash.example/api", {}, {
    attempts: 3,
    timeoutMs: 100,
    retryDelaysMs: [0, 0],
    fetchImpl: async () => {
      calls += 1;
      return new Response("unauthorized", { status: 401 });
    },
  });

  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test("aborts a hung attempt before retrying", async () => {
  let calls = 0;
  const response = await requestWithTransientRetry("https://dash.example/api", {}, {
    attempts: 2,
    timeoutMs: 10,
    retryDelaysMs: [0],
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 2) return new Response("ok", { status: 200 });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});
