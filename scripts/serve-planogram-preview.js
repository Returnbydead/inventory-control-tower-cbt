#!/usr/bin/env node
// Read-only local host for the L1 prototype. It intentionally proxies only
// the already-public rack-status GET endpoint so a static preview can use live
// data without changing Vercel CORS or the production UI.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const requestedPort = Number(process.argv.find((value, index, values) => values[index - 1] === "--port")) || 4188;
const publicDir = path.resolve(__dirname, "..", "public");
const remoteHost = "inventory-control-tower-cbt.vercel.app";
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function send(res, status, contentType, body) {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(body);
}

function proxyRackStatus(req, res) {
  let completed = false;
  const fail = (status, message) => {
    if (completed || res.writableEnded) return;
    completed = true;
    send(res, status, "application/json; charset=utf-8", JSON.stringify({ ok: false, message }));
  };
  const upstream = https.request({
    hostname: remoteHost,
    path: req.url,
    method: "GET",
    headers: { accept: "application/json" },
  }, upstreamRes => {
    if (completed) return upstreamRes.resume();
    completed = true;
    res.writeHead(upstreamRes.statusCode || 502, {
      "content-type": upstreamRes.headers["content-type"] || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    upstreamRes.pipe(res);
  });
  upstream.setTimeout(12000, () => upstream.destroy(new Error("Upstream request timed out after 12 seconds")));
  upstream.on("error", error => fail(504, error.message));
  req.on("aborted", () => upstream.destroy());
  upstream.end();
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/rack-status") return proxyRackStatus(req, res);
  if (req.method !== "GET") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");

  const relativePath = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "") || "preview/planogram-l1-monitoring-prototype.html";
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, "text/plain; charset=utf-8", "Not found");
  }
  res.writeHead(200, { "content-type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}).listen(requestedPort, "127.0.0.1", () => {
  console.log(`Planogram preview ready: http://127.0.0.1:${requestedPort}/preview/planogram-l1-monitoring-prototype.html?zone=SRC1`);
});
