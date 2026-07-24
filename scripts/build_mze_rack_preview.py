from __future__ import annotations

import csv
import json
import math
import re
from collections import defaultdict
from pathlib import Path


SOURCE = Path(r"C:\Users\M. Pandu Kurnia\Downloads\20260723_133134.csv")
OUTPUT = Path(
    r"C:\Users\M. Pandu Kurnia\Documents\INVENTORY CONTROL TOWER\preview\cibitung-mze-rack-preview.html"
)


def number(value: str | None) -> float:
    try:
        return float(value or 0)
    except ValueError:
        return 0.0


cells: dict[tuple[int, int, int, int, int], dict] = {}

with SOURCE.open("r", encoding="utf-8-sig", newline="") as source_file:
    reader = csv.DictReader(source_file)
    for row in reader:
        match = re.fullmatch(
            r"CBT-MZE([123])-(\d+)-(\d+)-L(\d+)-(\d+)", row["rack_name"].strip()
        )
        if not match:
            continue

        floor, aisle, bay, level, position = map(int, match.groups())
        key = (floor, aisle, bay, level, position)
        qty = number(row["stock"])
        cogs = number(row["cogs"])
        sku = row["sku_number"].strip()

        if key not in cells:
            cells[key] = {
                "floor": floor,
                "aisle": aisle,
                "bay": bay,
                "level": level,
                "position": position,
                "rack": row["rack_name"].strip(),
                "qty": 0,
                "value": 0,
                "sku_qty": defaultdict(float),
                "sku_name": {},
                "nearest_expiry": None,
            }

        cell = cells[key]
        cell["qty"] += qty
        cell["value"] += qty * cogs
        cell["sku_qty"][sku] += qty
        cell["sku_name"][sku] = row["product_name"].strip()
        expiry = row["expiry_date"].strip()
        if expiry and (cell["nearest_expiry"] is None or expiry < cell["nearest_expiry"]):
            cell["nearest_expiry"] = expiry


payload_cells = []
for cell in cells.values():
    skus = sorted(cell["sku_qty"].items(), key=lambda item: item[1], reverse=True)
    payload_cells.append(
        {
            "f": cell["floor"],
            "a": cell["aisle"],
            "b": cell["bay"],
            "l": cell["level"],
            "p": cell["position"],
            "r": cell["rack"],
            "q": round(cell["qty"], 2),
            "v": round(cell["value"]),
            "e": cell["nearest_expiry"],
            "s": [
                [sku, cell["sku_name"][sku], round(qty, 2)]
                for sku, qty in skus
            ],
        }
    )

payload_cells.sort(key=lambda item: (item["f"], item["a"], item["b"], item["l"], item["p"]))
payload = json.dumps(payload_cells, ensure_ascii=False, separators=(",", ":"))

html = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CBT MZE Rack Twin Preview</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07110f;
      --panel: rgba(16, 32, 28, .86);
      --panel-strong: #10241f;
      --line: rgba(166, 213, 197, .16);
      --text: #edf8f3;
      --muted: #93aea4;
      --mint: #73f2bf;
      --lime: #c9f46f;
      --orange: #ffb86b;
      --red: #ff6f70;
      --cyan: #73d7f2;
      --shadow: 0 24px 80px rgba(0,0,0,.38);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background:
        radial-gradient(circle at 18% 0%, rgba(49, 151, 111, .18), transparent 34rem),
        radial-gradient(circle at 90% 10%, rgba(61, 110, 97, .14), transparent 40rem),
        linear-gradient(180deg, #091613, var(--bg));
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select { font: inherit; }
    button, select, input {
      color: var(--text);
      background: rgba(255,255,255,.04);
      border: 1px solid var(--line);
      border-radius: 10px;
    }
    button { cursor: pointer; }
    button:hover { border-color: rgba(115, 242, 191, .5); }
    button:focus-visible, select:focus-visible, input:focus-visible {
      outline: 2px solid var(--mint);
      outline-offset: 2px;
    }
    .shell { max-width: 1600px; margin: 0 auto; padding: 22px; }
    .topbar {
      display: flex; justify-content: space-between; gap: 18px; align-items: flex-start;
      margin-bottom: 18px;
    }
    .eyebrow {
      color: var(--mint); font-size: 11px; font-weight: 700; letter-spacing: .15em;
      text-transform: uppercase; margin-bottom: 7px;
    }
    h1 { font-size: clamp(24px, 3vw, 42px); line-height: 1.05; margin: 0; letter-spacing: -.04em; }
    .subtitle { color: var(--muted); margin: 9px 0 0; max-width: 760px; font-size: 14px; }
    .freshness {
      display: flex; align-items: center; gap: 9px; white-space: nowrap;
      color: var(--muted); font-size: 12px; padding-top: 5px;
    }
    .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 16px var(--mint); }
    .metrics {
      display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; margin-bottom: 12px;
    }
    .metric {
      background: linear-gradient(145deg, rgba(22,49,41,.82), rgba(12,27,23,.82));
      border: 1px solid var(--line); border-radius: 14px; padding: 15px 16px; box-shadow: 0 12px 30px rgba(0,0,0,.16);
    }
    .metric-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; }
    .metric-value { font-size: clamp(22px, 2.4vw, 34px); font-weight: 720; margin-top: 5px; letter-spacing: -.04em; }
    .metric-note { color: var(--muted); font-size: 11px; margin-top: 4px; }
    .workspace {
      display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 12px; align-items: stretch;
    }
    .map-panel, .detail-panel {
      background: linear-gradient(160deg, rgba(16, 36, 31, .93), rgba(8, 20, 17, .95));
      border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow);
    }
    .map-panel { min-width: 0; overflow: hidden; }
    .toolbar {
      min-height: 58px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 10px 12px; border-bottom: 1px solid var(--line);
    }
    .segmented { display: flex; gap: 4px; padding: 3px; border-radius: 12px; background: rgba(255,255,255,.025); }
    .segmented button { padding: 7px 11px; border-color: transparent; font-size: 12px; }
    .segmented button.active {
      background: var(--mint); color: #062016; font-weight: 750; box-shadow: 0 4px 16px rgba(115,242,191,.16);
    }
    .toolbar label { color: var(--muted); font-size: 11px; display: flex; align-items: center; gap: 6px; }
    .toolbar select { padding: 7px 28px 7px 9px; font-size: 12px; }
    .search { margin-left: auto; min-width: min(250px,100%); position: relative; }
    .search input { width: 100%; padding: 8px 10px 8px 32px; font-size: 12px; }
    .search::before {
      content: ""; position: absolute; left: 11px; top: 10px; width: 10px; height: 10px;
      border: 1.5px solid var(--muted); border-radius: 50%;
    }
    .search::after {
      content: ""; position: absolute; left: 21px; top: 21px; width: 6px; height: 1.5px;
      background: var(--muted); transform: rotate(45deg); transform-origin: left;
    }
    .canvas-wrap { position: relative; min-height: 620px; }
    canvas { display: block; width: 100%; height: 620px; }
    .map-label {
      position: absolute; left: 16px; bottom: 14px; color: var(--muted); font-size: 11px;
      padding: 7px 9px; border: 1px solid var(--line); border-radius: 9px; background: rgba(5,14,12,.78);
      pointer-events: none;
    }
    .legend {
      position: absolute; right: 16px; bottom: 14px; width: min(260px, 42%); pointer-events: none;
    }
    .legend-bar {
      height: 7px; border-radius: 10px;
      background: linear-gradient(90deg, #173a33, #2f8c6b, #73f2bf, #c9f46f, #ffb86b);
    }
    .legend-text { display:flex; justify-content:space-between; color: var(--muted); font-size: 10px; margin-top:5px; }
    .tooltip {
      position: absolute; display: none; pointer-events: none; z-index: 10;
      background: #10241f; border: 1px solid rgba(115,242,191,.28); border-radius: 10px;
      padding: 9px 10px; color: var(--text); font-size: 11px; box-shadow: 0 12px 30px rgba(0,0,0,.35);
      max-width: 250px;
    }
    .tooltip strong { display:block; color:var(--mint); margin-bottom:4px; }
    .detail-panel { padding: 16px; min-height: 680px; }
    .detail-kicker { color: var(--mint); font-size: 10px; text-transform: uppercase; letter-spacing: .12em; }
    .detail-title { font-size: 20px; margin: 5px 0 4px; }
    .detail-sub { color: var(--muted); font-size: 12px; margin-bottom: 15px; }
    .detail-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .mini { border-top: 1px solid var(--line); padding-top: 9px; }
    .mini span { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .mini strong { display:block; margin-top:3px; font-size:16px; }
    .section-title { color: var(--muted); font-size: 10px; text-transform:uppercase; letter-spacing:.09em; margin: 16px 0 8px; }
    .rack-grid { display:grid; grid-template-columns:repeat(10,1fr); gap:3px; }
    .rack-cell {
      aspect-ratio: 1; border-radius: 4px; border:1px solid var(--line); background:rgba(255,255,255,.025);
      display:grid; place-items:center; color:var(--muted); font-size:8px;
    }
    .rack-cell.occupied { background:rgba(115,242,191,.22); color:var(--text); border-color:rgba(115,242,191,.38); }
    .sku-list { display:flex; flex-direction:column; gap:7px; max-height:280px; overflow:auto; padding-right:3px; }
    .sku-row {
      display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:8px 0;
      border-bottom:1px solid var(--line);
    }
    .sku-code { color: var(--text); font-size:11px; font-variant-numeric:tabular-nums; }
    .sku-name { color: var(--muted); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
    .sku-qty { color:var(--mint); font-size:12px; font-weight:700; }
    .empty-state { color:var(--muted); font-size:12px; line-height:1.6; padding-top:8px; }
    .source-note { margin-top:16px; color:var(--muted); font-size:10px; line-height:1.5; }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: 1fr; }
      .detail-panel { min-height: auto; }
    }
    @media (max-width: 700px) {
      .shell { padding: 12px; }
      .topbar { flex-direction: column; }
      .metrics { grid-template-columns: 1fr 1fr; }
      .search { width:100%; margin-left:0; }
      .canvas-wrap, canvas { min-height: 500px; height: 500px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <div class="eyebrow">Inventory Control Tower · Rack Twin</div>
        <h1>CBT / MZE placement map</h1>
        <p class="subtitle">Logical 3D prototype generated from the SOH snapshot. Use it to locate fragmented SKU across floor, aisle, bay, rack level, and position.</p>
      </div>
      <div class="freshness"><span class="pulse"></span>SOH sample · 23 Jul 2026</div>
    </header>

    <section class="metrics" aria-label="Floor summary">
      <article class="metric"><div class="metric-label">Total SOH</div><div class="metric-value" id="kpi-soh">—</div><div class="metric-note" id="kpi-soh-note">MZE floor 1</div></article>
      <article class="metric"><div class="metric-label">Active SKU</div><div class="metric-value" id="kpi-skus">—</div><div class="metric-note">Distinct SKU on selected floor</div></article>
      <article class="metric"><div class="metric-label">Occupied cells</div><div class="metric-value" id="kpi-cells">—</div><div class="metric-note">Rack level × position</div></article>
      <article class="metric"><div class="metric-label">Multi-aisle SKU</div><div class="metric-value" id="kpi-split">—</div><div class="metric-note">Diagnostic, not automatically actionable</div></article>
    </section>

    <section class="workspace">
      <div class="map-panel">
        <div class="toolbar">
          <div class="segmented" id="floor-buttons" aria-label="Warehouse floor">
            <button class="active" data-floor="1">Floor 1</button>
            <button data-floor="2">Floor 2</button>
            <button data-floor="3">Floor 3</button>
          </div>
          <div class="segmented" id="view-buttons" aria-label="Map view">
            <button class="active" data-view="3d">3D</button>
            <button data-view="2d">2D</button>
          </div>
          <label>Color
            <select id="metric-select">
              <option value="qty">SOH quantity</option>
              <option value="skus">SKU count</option>
              <option value="value">COGS value</option>
            </select>
          </label>
          <label id="angle-label">Angle
            <input id="angle-range" type="range" min="-55" max="20" value="-22" step="1">
          </label>
          <div class="search">
            <input id="sku-search" type="search" placeholder="Search SKU or product…" aria-label="Search SKU or product">
          </div>
        </div>
        <div class="canvas-wrap" id="canvas-wrap">
          <canvas id="rack-canvas" aria-label="Interactive MZE rack placement map"></canvas>
          <div class="map-label" id="map-label">Zone MZE · Floor 1 · logical coordinates</div>
          <div class="legend"><div class="legend-bar"></div><div class="legend-text"><span>Low</span><span id="legend-metric">SOH quantity</span><span>High</span></div></div>
          <div class="tooltip" id="tooltip"></div>
        </div>
      </div>

      <aside class="detail-panel" id="detail-panel">
        <div class="detail-kicker">Selected rack stack</div>
        <h2 class="detail-title" id="detail-title">Choose an aisle / bay</h2>
        <div class="detail-sub" id="detail-sub">Click a rack stack to inspect its levels and positions.</div>
        <div id="detail-content" class="empty-state">Search a SKU to highlight every rack stack containing it, or select any stack in the map.</div>
        <div class="source-note">Prototype scope: zone MZE only. Geometry is logical until MZE is linked to the exact module coordinates in the Phase 2 layout plan.</div>
      </aside>
    </section>
  </main>

  <script>
    const cells = __PAYLOAD__;
    const state = { floor: 1, view: "3d", metric: "qty", angle: -22, query: "", selected: null, hover: null };
    const canvas = document.getElementById("rack-canvas");
    const wrap = document.getElementById("canvas-wrap");
    const ctx = canvas.getContext("2d");
    const tooltip = document.getElementById("tooltip");
    let hitboxes = [];
    let floorData = [];
    let stacks = [];

    const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
    const money = new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 });
    const metricLabel = { qty: "SOH quantity", skus: "SKU count", value: "COGS value" };

    function aggregate() {
      floorData = cells.filter(c => c.f === state.floor);
      const byStack = new Map();
      floorData.forEach(cell => {
        const key = `${cell.a}-${cell.b}`;
        if (!byStack.has(key)) byStack.set(key, { key, a: cell.a, b: cell.b, qty: 0, value: 0, levels: new Set(), skus: new Map(), cells: [] });
        const stack = byStack.get(key);
        stack.qty += cell.q;
        stack.value += cell.v;
        stack.levels.add(cell.l);
        stack.cells.push(cell);
        cell.s.forEach(([sku,name,qty]) => {
          const current = stack.skus.get(sku) || { sku, name, qty: 0 };
          current.qty += qty;
          stack.skus.set(sku, current);
        });
      });
      stacks = [...byStack.values()].sort((x,y) => x.a-y.a || x.b-y.b);
      updateKpis();
    }

    function updateKpis() {
      const allSkus = new Map();
      floorData.forEach(cell => cell.s.forEach(([sku,name,qty]) => {
        if (!allSkus.has(sku)) allSkus.set(sku, { aisles: new Set(), qty: 0 });
        const item = allSkus.get(sku); item.aisles.add(cell.a); item.qty += qty;
      }));
      const total = floorData.reduce((sum,c) => sum+c.q,0);
      const split = [...allSkus.values()].filter(x => x.aisles.size > 1).length;
      document.getElementById("kpi-soh").textContent = fmt.format(total);
      document.getElementById("kpi-skus").textContent = fmt.format(allSkus.size);
      document.getElementById("kpi-cells").textContent = fmt.format(floorData.length);
      document.getElementById("kpi-split").textContent = fmt.format(split);
      document.getElementById("kpi-soh-note").textContent = `MZE floor ${state.floor}`;
      document.getElementById("map-label").textContent = `Zone MZE · Floor ${state.floor} · ${state.view === "3d" ? "logical 3D" : "aisle × bay"}`;
    }

    function metricValue(stack) {
      if (state.metric === "skus") return stack.skus.size;
      if (state.metric === "value") return stack.value;
      return stack.qty;
    }

    function color(t, alpha=1) {
      t = Math.max(0, Math.min(1, t));
      const stops = [
        [23,58,51], [47,140,107], [115,242,191], [201,244,111], [255,184,107]
      ];
      const pos = t * (stops.length - 1);
      const i = Math.min(stops.length-2, Math.floor(pos));
      const f = pos-i;
      const rgb = stops[i].map((v,j) => Math.round(v+(stops[i+1][j]-v)*f));
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    }

    function matches(stack) {
      if (!state.query) return false;
      const q = state.query.toLowerCase();
      return [...stack.skus.values()].some(x => x.sku.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(rect.width*dpr);
      canvas.height = Math.floor(rect.height*dpr);
      ctx.setTransform(dpr,0,0,dpr,0,0);
      draw();
    }

    function draw() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0,0,w,h);
      const gradient = ctx.createRadialGradient(w*.5,h*.35,20,w*.5,h*.45,w*.75);
      gradient.addColorStop(0,"rgba(31,76,63,.23)");
      gradient.addColorStop(1,"rgba(5,14,12,0)");
      ctx.fillStyle=gradient; ctx.fillRect(0,0,w,h);
      hitboxes=[];
      if (!stacks.length) return;
      state.view === "3d" ? draw3d(w,h) : draw2d(w,h);
    }

    function draw3d(w,h) {
      const maxVal = Math.max(...stacks.map(metricValue),1);
      const theta = state.angle*Math.PI/180;
      const cos=Math.cos(theta), sin=Math.sin(theta);
      const raw=stacks.map(s => {
        const x=s.a-18, y=(s.b-3)*4.2;
        return {s, rx:x*cos-y*sin, ry:x*sin+y*cos};
      });
      const xs=raw.map(p=>p.rx-p.ry), ys=raw.map(p=>p.rx+p.ry);
      const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
      const scale=Math.min((w-100)/(maxX-minX+10),(h-170)/(maxY-minY+15));
      const sx=Math.max(7,Math.min(16,scale));
      const sy=sx*.42;
      const centerX=w*.5-(minX+maxX)*sx*.5;
      const centerY=85-minY*sy;
      const ordered=[...raw].sort((p,q)=>(p.rx+p.ry)-(q.rx+q.ry));
      ordered.forEach(({s,rx,ry})=>{
        const baseX=centerX+(rx-ry)*sx, baseY=centerY+(rx+ry)*sy;
        const t=Math.sqrt(metricValue(s)/maxVal);
        const height=26+t*70;
        const bw=Math.max(8,sx*1.12), depth=Math.max(4,sy*1.9);
        const highlighted=matches(s), selected=state.selected===s.key;
        drawCube(baseX,baseY,bw,depth,height,color(t,.92),highlighted,selected,s.levels.size);
        hitboxes.push({s,x:baseX-bw*.7,y:baseY-height-depth,w:bw*1.5,h:height+depth*1.6});
      });
      drawAxis(w,h);
    }

    function drawCube(x,y,w,d,h,fill,highlighted,selected,levels) {
      ctx.beginPath(); ctx.moveTo(x,y-h); ctx.lineTo(x+w,y-h-d); ctx.lineTo(x+w,y-d); ctx.lineTo(x,y); ctx.closePath();
      ctx.fillStyle=fill; ctx.fill();
      ctx.beginPath(); ctx.moveTo(x+w,y-h-d); ctx.lineTo(x+w+d,y-h); ctx.lineTo(x+w+d,y); ctx.lineTo(x+w,y-d); ctx.closePath();
      ctx.fillStyle="rgba(9,24,20,.88)"; ctx.fill();
      ctx.beginPath(); ctx.moveTo(x,y-h); ctx.lineTo(x+d,y-h+d); ctx.lineTo(x+w+d,y-h); ctx.lineTo(x+w,y-h-d); ctx.closePath();
      ctx.fillStyle=highlighted ? "rgba(255,184,107,.95)" : "rgba(201,244,111,.75)"; ctx.fill();
      ctx.strokeStyle=selected ? "#ffffff" : highlighted ? "#ffb86b" : "rgba(176,219,205,.2)";
      ctx.lineWidth=selected ? 2.4 : highlighted ? 2 : 1; ctx.stroke();
      for(let i=1;i<levels;i++){
        const yy=y-h+(h*i/levels);
        ctx.beginPath();ctx.moveTo(x,yy);ctx.lineTo(x+w,yy-d);ctx.strokeStyle="rgba(4,14,11,.42)";ctx.lineWidth=.7;ctx.stroke();
      }
    }

    function draw2d(w,h) {
      const maxA=Math.max(...stacks.map(s=>s.a)), maxB=Math.max(...stacks.map(s=>s.b));
      const pad={l:48,r:24,t:36,b:45};
      const cw=(w-pad.l-pad.r)/maxA, ch=(h-pad.t-pad.b)/Math.max(5,maxB);
      const maxVal=Math.max(...stacks.map(metricValue),1);
      ctx.font="10px system-ui"; ctx.textAlign="center"; ctx.textBaseline="middle";
      for(let a=1;a<=maxA;a++){ctx.fillStyle="rgba(147,174,164,.75)";ctx.fillText(String(a).padStart(2,"0"),pad.l+(a-.5)*cw,h-22);}
      for(let b=1;b<=Math.max(5,maxB);b++){ctx.fillStyle="rgba(147,174,164,.75)";ctx.fillText(`B${b}`,24,pad.t+(b-.5)*ch);}
      stacks.forEach(s=>{
        const x=pad.l+(s.a-1)*cw+1, y=pad.t+(s.b-1)*ch+1, ww=cw-2, hh=ch-2;
        const t=Math.sqrt(metricValue(s)/maxVal), highlighted=matches(s), selected=state.selected===s.key;
        ctx.fillStyle=color(t,.86);ctx.fillRect(x,y,ww,hh);
        ctx.strokeStyle=selected?"#fff":highlighted?"#ffb86b":"rgba(166,213,197,.16)";
        ctx.lineWidth=selected?2.5:highlighted?2:1;ctx.strokeRect(x,y,ww,hh);
        hitboxes.push({s,x,y,w:ww,h:hh});
      });
    }

    function drawAxis(w,h){
      ctx.font="10px system-ui";ctx.fillStyle="rgba(147,174,164,.72)";ctx.textAlign="left";
      ctx.fillText("Aisle 01",22,h-58);ctx.textAlign="right";ctx.fillText("Aisle 36",w-22,h-58);
      ctx.strokeStyle="rgba(166,213,197,.18)";ctx.beginPath();ctx.moveTo(22,h-48);ctx.lineTo(w-22,h-48);ctx.stroke();
    }

    function stackAtEvent(event){
      const rect=canvas.getBoundingClientRect(), x=event.clientX-rect.left, y=event.clientY-rect.top;
      for(let i=hitboxes.length-1;i>=0;i--){const b=hitboxes[i];if(x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h)return {stack:b.s,x,y};}
      return null;
    }

    function showTooltip(event){
      const hit=stackAtEvent(event);
      if(!hit){tooltip.style.display="none";return;}
      const s=hit.stack;
      tooltip.innerHTML=`<strong>MZE${state.floor} · Aisle ${String(s.a).padStart(2,"0")} · Bay ${String(s.b).padStart(2,"0")}</strong>${fmt.format(s.qty)} units · ${s.skus.size} SKU · ${s.cells.length} occupied cells`;
      tooltip.style.display="block";
      const tw=tooltip.offsetWidth, th=tooltip.offsetHeight;
      tooltip.style.left=Math.min(canvas.clientWidth-tw-12,hit.x+15)+"px";
      tooltip.style.top=Math.max(8,Math.min(canvas.clientHeight-th-12,hit.y-10))+"px";
    }

    function renderDetail(stack){
      const title=document.getElementById("detail-title"), sub=document.getElementById("detail-sub"), content=document.getElementById("detail-content");
      if(!stack){title.textContent="Choose an aisle / bay";sub.textContent="Click a rack stack to inspect its levels and positions.";content.className="empty-state";content.innerHTML="Search a SKU to highlight every rack stack containing it, or select any stack in the map.";return;}
      title.textContent=`MZE${state.floor} / A${String(stack.a).padStart(2,"0")} / B${String(stack.b).padStart(2,"0")}`;
      sub.textContent=`${stack.cells.length} occupied rack cells across ${stack.levels.size} levels`;
      const byPos=new Map(stack.cells.map(c=>[`${c.l}-${c.p}`,c]));
      let grid="";
      for(let l=5;l>=1;l--)for(let p=1;p<=10;p++){const c=byPos.get(`${l}-${p}`);grid+=`<div class="rack-cell ${c?"occupied":""}" aria-label="Level ${l}, position ${p}${c?`, ${fmt.format(c.q)} units`:", empty"}">${c?fmt.format(c.q):""}</div>`;}
      const skuRows=[...stack.skus.values()].sort((a,b)=>b.qty-a.qty).slice(0,16).map(x=>`<div class="sku-row"><div><div class="sku-code">${x.sku}</div><div class="sku-name">${escapeHtml(x.name)}</div></div><div class="sku-qty">${fmt.format(x.qty)}</div></div>`).join("");
      content.className="";
      content.innerHTML=`<div class="detail-stats"><div class="mini"><span>SOH</span><strong>${fmt.format(stack.qty)}</strong></div><div class="mini"><span>COGS value</span><strong>Rp ${money.format(stack.value)}</strong></div><div class="mini"><span>SKU</span><strong>${fmt.format(stack.skus.size)}</strong></div><div class="mini"><span>Levels</span><strong>${stack.levels.size}</strong></div></div><div class="section-title">Rack face · L5 to L1 / positions 01–10</div><div class="rack-grid">${grid}</div><div class="section-title">Top SKU in stack</div><div class="sku-list">${skuRows}</div>`;
    }

    function escapeHtml(text){const d=document.createElement("div");d.textContent=text;return d.innerHTML;}

    document.getElementById("floor-buttons").addEventListener("click",e=>{
      const b=e.target.closest("button");if(!b)return;state.floor=+b.dataset.floor;state.selected=null;
      [...e.currentTarget.children].forEach(x=>x.classList.toggle("active",x===b));aggregate();renderDetail(null);draw();
    });
    document.getElementById("view-buttons").addEventListener("click",e=>{
      const b=e.target.closest("button");if(!b)return;state.view=b.dataset.view;
      [...e.currentTarget.children].forEach(x=>x.classList.toggle("active",x===b));
      document.getElementById("angle-label").style.display=state.view==="3d"?"flex":"none";updateKpis();draw();
    });
    document.getElementById("metric-select").addEventListener("change",e=>{
      state.metric=e.target.value;document.getElementById("legend-metric").textContent=metricLabel[state.metric];draw();
    });
    document.getElementById("angle-range").addEventListener("input",e=>{state.angle=+e.target.value;draw();});
    document.getElementById("sku-search").addEventListener("input",e=>{state.query=e.target.value.trim();draw();});
    canvas.addEventListener("mousemove",showTooltip);
    canvas.addEventListener("mouseleave",()=>tooltip.style.display="none");
    canvas.addEventListener("click",e=>{
      const hit=stackAtEvent(e);if(!hit)return;state.selected=hit.stack.key;renderDetail(hit.stack);draw();
    });
    window.addEventListener("resize",resize);
    aggregate();renderDetail(null);requestAnimationFrame(resize);
  </script>
</body>
</html>
"""

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(html.replace("__PAYLOAD__", payload), encoding="utf-8")
print(OUTPUT)
print(f"cells={len(payload_cells)} bytes={OUTPUT.stat().st_size}")
