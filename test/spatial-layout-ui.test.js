const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "..", "public", "sra1-spatial-prototype.html"), "utf8");

test("renders one stacked live-SOH tower for all three mezzanine decks", () => {
  assert.match(page, /const moduleZones=isMezzanine\?\[1,2,3\]/);
  assert.match(page, /api\/rack-status\?zones=\$\{moduleZones\.join/);
  assert.match(page, /function mezzanineDeckY/);
  assert.match(page, /mezzanineRowsByDeckLevel/);
  assert.match(page, /mezzaninePositionsByDeckLevel/);
  assert.match(page, /for\(let floorIndex=1;floorIndex<=3;floorIndex\+\+\)/);
});

test("maps a physical MZ rack to two aisle sides instead of 36 isolated rack blocks", () => {
  assert.match(page, /const pair=Math\.floor\(\(aisle-1\)\/2\)/);
  assert.match(page, /side=\(row\.aisle-1\)%2/);
  assert.match(page, /Math\.ceil\(aisleValues\.length\/2\)\} rack fisik/);
  assert.match(page, /mezzanineRackColumns=18, mezzanineRackRows=1/);
  assert.match(page, /const slotIndex=sequenceIndex\*levelPositions\.length\+positionIndex/);
});
