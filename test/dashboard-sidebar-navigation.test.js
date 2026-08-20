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

test("retired Replenishment calculator is absent from runtime and navigation", () => {
  for (const [name, html] of dashboardPages) {
    assert.doesNotMatch(html, /Replenishment Calculator/i, `retired menu is still present in ${name}`);
    assert.doesNotMatch(html, /href=["']\/replenishment["']/i, `retired route is still linked in ${name}`);
  }

  assert.equal(fs.existsSync(path.join(root, "api", "replenishment-calculator.js")), false);
  assert.equal(fs.existsSync(path.join(root, "public", "preview", "replenishment-calculator.html")), false);

  const vercel = JSON.parse(readPage("vercel.json"));
  assert.equal(vercel.rewrites.some((rewrite) => rewrite.source === "/replenishment"), false);
  assert.equal(Object.hasOwn(vercel.functions, "api/replenishment-calculator.js"), false);
});
