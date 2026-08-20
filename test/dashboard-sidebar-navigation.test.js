const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const readPage = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

const dashboardPages = [
  ["Putaway", readPage("public", "preview", "putaway-superset-ledger.html")],
  ["Planogram", readPage("public", "preview", "planogram-l1-monitoring-prototype.html")],
  ["Occupancy", readPage("public", "preview", "occupancy-dashboard-preview.html")],
  ["Spatial", readPage("public", "sra1-spatial-prototype.html")],
];

test("every operational dashboard keeps the full navigation list", () => {
  for (const [name, html] of dashboardPages) {
    for (const label of [
      "Putaway Monitoring",
      "3D Rack View",
      "Planogram Accuracy",
      "Occupancy",
      "Lost Monitoring",
    ]) {
      assert.match(html, new RegExp(label), `${label} is missing from ${name}`);
    }
  }
});

test("Replenishment returns as a static page without a Vercel Function", () => {
  assert.equal(fs.existsSync(path.join(root, "api", "replenishment-calculator.js")), false);
  assert.equal(fs.existsSync(path.join(root, "public", "preview", "replenishment-calculator.html")), true);

  const vercel = JSON.parse(readPage("vercel.json"));
  assert.equal(vercel.rewrites.some((rewrite) => rewrite.source === "/replenishment"), true);
  assert.equal(Object.hasOwn(vercel.functions, "api/replenishment-calculator.js"), false);
});
