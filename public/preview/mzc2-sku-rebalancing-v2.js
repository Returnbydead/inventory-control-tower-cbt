(() => {
  const legacyDetail = document.querySelector('.workbench #detail');
  if (legacyDetail) legacyDetail.id = 'legacyDetail';
  const dialog = document.createElement('dialog');
  dialog.id = 'skuDialog';
  dialog.className = 'sku-dialog';
  dialog.setAttribute('aria-labelledby', 'skuDialogTitle');
  dialog.innerHTML = `
    <div class="dialog-top">
      <div><p class="dialog-kicker">Preview detail SKU</p><h2 id="skuDialogTitle">Detail SKU</h2></div>
      <button id="closeDetail" type="button">Tutup</button>
    </div>
    <div id="detail" class="dialog-body"></div>`;
  document.body.append(dialog);

  const byId = (id) => document.getElementById(id);
  const text = (value) => String(value ?? '');
  const zoneName = (zone) => zone === 'zone1' ? 'Zone 1 · aisle 01–18' : 'Zone 2 · aisle 19–36';
  const clusterRows = (rows) => {
    const clusters = new Map();
    rows.forEach((row) => {
      const aisle = text(row.Aisle).padStart(2, '0') || '—';
      const rack = row['SLOC / Rack'] || 'Rack belum terbaca';
      const key = `${aisle}|${rack}`;
      const current = clusters.get(key) || { aisle, rack, qty: 0 };
      current.qty += Number(row.parsedQty || 0);
      clusters.set(key, current);
    });
    return [...clusters.values()].sort((a, b) => b.qty - a.qty || a.aisle.localeCompare(b.aisle));
  };
  const recommendationFor = (group) => {
    if (!group.isSplit) {
      return { code: 'SATU ZONA', target: '', anchorAisle: '—', candidateRack: '—', moveQty: 0, reason: 'SKU hanya berada di satu zona; tidak ada kandidat konsolidasi.', capacity: 'Tidak diperlukan.' };
    }
    const largest = Math.max(group.zone1Qty, group.zone2Qty);
    const share = group.totalQty ? largest / group.totalQty : 0;
    if (share < 0.7) {
      return { code: 'REVIEW MANUAL', target: 'Belum ditentukan', anchorAisle: '—', candidateRack: '—', moveQty: group.minorQty, reason: `Sebaran masih ${percentFormat.format((group.zone1Qty / group.totalQty) * 100)}% / ${percentFormat.format((group.zone2Qty / group.totalQty) * 100)}%; belum cukup dominan untuk menyarankan satu zona.`, capacity: 'Pilih zona dan cek kapasitas manual sebelum movement.' };
    }
    const destination = group.zone1Qty >= group.zone2Qty ? 'zone1' : 'zone2';
    const targetRows = group.raw.filter((row) => row.placementZone === destination);
    const candidates = clusterRows(targetRows);
    const anchor = candidates[0];
    return {
      code: 'KANDIDAT KONSOLIDASI',
      target: zoneName(destination),
      anchorAisle: anchor ? `Aisle ${anchor.aisle}` : 'Belum terbaca',
      candidateRack: anchor ? anchor.rack : 'Belum ada rack anchor',
      candidates,
      moveQty: group.minorQty,
      reason: `${percentFormat.format(share * 100)}% qty SKU sudah berada di ${zoneName(destination)}. Gunakan cluster SKU yang sudah ada sebagai titik awal review.`,
      capacity: 'Belum divalidasi. Cek kapasitas, kondisi picking, dan aturan L1 sebelum membuat task movement.'
    };
  };
  const visibleV2 = () => {
    const query = normalize(byId('search').value);
    const view = byId('view').value;
    const sort = byId('sort').value;
    const visible = groups.filter((group) => (view === 'all' || group.isSplit) && (!query || normalize(`${group.sku} ${group.product} ${group.l1}`).includes(query)));
    return visible.sort((a, b) => sort === 'sku' ? a.sku.localeCompare(b.sku) : sort === 'total' ? b.totalQty - a.totalQty : b.minorQty - a.minorQty);
  };
  const statusClass = (suggestion) => suggestion.code === 'KANDIDAT KONSOLIDASI' ? 'split' : suggestion.code === 'REVIEW MANUAL' ? 'manual' : '';
  const statusText = (suggestion) => suggestion.code === 'KANDIDAT KONSOLIDASI' ? 'KANDIDAT' : suggestion.code;

  function renderLedgerV2() {
    if (!Array.isArray(groups)) return;
    const rows = visibleV2();
    renderKpis(rows);
    byId('count').textContent = `${qty(rows.length)} SKU`;
    byId('helper').textContent = `${qty(rows.length)} SKU tampil · ${qty(rows.filter((group) => group.isSplit).length)} SKU muncul di kedua zona.`;
    const table = byId('ledger').closest('table');
    table.querySelector('thead').innerHTML = '<tr><th class="left">SKU / Produk</th><th class="left">L1</th><th>Zone 1<br><span class="muted">qty · SLOC</span></th><th>Zone 2<br><span class="muted">qty · SLOC</span></th><th>Qty kandidat</th><th class="left">Saran cluster</th><th>Status</th></tr>';
    byId('ledger').innerHTML = rows.length ? rows.map((group) => {
      const suggestion = recommendationFor(group);
      const label = suggestion.code === 'KANDIDAT KONSOLIDASI' ? `${suggestion.target}<br><span class="muted">${suggestion.anchorAisle}</span>` : suggestion.code === 'REVIEW MANUAL' ? 'Pilih zona manual' : 'Tidak perlu pindah';
      return `<tr><td class="left"><button class="sku-button" type="button" data-sku="${escapeHtml(group.sku)}">${escapeHtml(group.sku)}<br><span class="muted">${escapeHtml(group.product)}</span></button></td><td class="left">${escapeHtml(group.l1)}</td><td>${qty(group.zone1Qty)}<br><span class="muted">${qty(group.zone1Sloc)} SLOC</span></td><td>${qty(group.zone2Qty)}<br><span class="muted">${qty(group.zone2Sloc)} SLOC</span></td><td class="${group.isSplit ? 'qty-danger' : 'qty-safe'}">${group.isSplit ? qty(suggestion.moveQty) : '—'}</td><td class="left">${label}</td><td><span class="status ${statusClass(suggestion)}">${statusText(suggestion)}</span></td></tr>`;
    }).join('') : '<tr><td class="empty" colspan="7">Tidak ada SKU pada filter ini.</td></tr>';
  }

  const listRacks = (rows) => {
    const clusters = clusterRows(rows);
    return clusters.map((item) => `<div class="rack-row"><span>${escapeHtml(`Aisle ${item.aisle} · ${item.rack}`)}</span><b>${qty(item.qty)}</b></div>`).join('') || '<div class="rack-row"><span>Tidak ada qty</span><b>0</b></div>';
  };
  const rawRowsHtml = (group, suggestion) => group.raw
    .sort((a, b) => a.placementZone.localeCompare(b.placementZone) || Number(a.Aisle) - Number(b.Aisle) || b.parsedQty - a.parsedQty)
    .map((row) => `<tr><td>${escapeHtml(zoneName(row.placementZone))}</td><td>${escapeHtml(row.Aisle)}</td><td class="left">${escapeHtml(row['SLOC / Rack'])}</td><td>${qty(row.parsedQty)}</td><td class="left">${escapeHtml(row['L1 Aktual'])}</td><td>${escapeHtml(row['Status L1'])}</td><td class="left">${escapeHtml(suggestion.target || '—')}</td><td class="left">${escapeHtml(suggestion.candidateRack || '—')}</td></tr>`).join('');

  function openDetail(group) {
    if (!group) return;
    const suggestion = recommendationFor(group);
    const width1 = group.totalQty ? (group.zone1Qty / group.totalQty) * 100 : 0;
    const width2 = group.totalQty ? (group.zone2Qty / group.totalQty) * 100 : 0;
    byId('skuDialogTitle').textContent = `${group.sku} · ${group.product}`;
    byId('detail').className = 'dialog-body detail-content';
    byId('detail').innerHTML = `
      <div class="detail-summary">
        <div class="detail-stat"><span>Qty Zone 1</span><strong>${qty(group.zone1Qty)}</strong></div>
        <div class="detail-stat"><span>Qty Zone 2</span><strong>${qty(group.zone2Qty)}</strong></div>
        <div class="detail-stat"><span>Qty kandidat review</span><strong class="qty-danger">${qty(suggestion.moveQty)}</strong></div>
        <div class="detail-stat"><span>SLOC total</span><strong>${qty(group.zone1Sloc + group.zone2Sloc)}</strong></div>
      </div>
      <div class="detail-grid">
        <div class="distribution">
          <h3>Sebaran qty SKU</h3>
          <div class="distribution-row"><span>Zone 1</span><div class="bar"><i style="width:${width1}%"></i></div><strong>${qty(group.zone1Qty)}</strong></div>
          <div class="distribution-row"><span>Zone 2</span><div class="bar"><i style="width:${width2}%"></i></div><strong>${qty(group.zone2Qty)}</strong></div>
          <div class="rack-list"><h3>Cluster yang sudah ada</h3>${listRacks(group.raw)}</div>
        </div>
        <div class="review-note">
          <strong>${escapeHtml(statusText(suggestion))}</strong>
          <p>${escapeHtml(suggestion.reason)}</p>
          <p><strong>Tujuan review:</strong> ${escapeHtml(suggestion.target || 'Tidak ada')}</p>
          <p><strong>Anchor:</strong> ${escapeHtml(suggestion.anchorAisle)} · ${escapeHtml(suggestion.candidateRack)}</p>
          <p><strong>Validasi kapasitas:</strong> ${escapeHtml(suggestion.capacity)}</p>
        </div>
      </div>
      <section class="raw-panel">
        <div class="raw-heading"><h3>Raw lokasi SKU</h3><span>${qty(group.raw.length)} baris SLOC</span></div>
        <div class="raw-table-shell"><table><thead><tr><th>Area</th><th>Aisle</th><th class="left">SLOC / Rack</th><th>Qty</th><th class="left">L1 Aktual</th><th>Status L1</th><th class="left">Zona saran</th><th class="left">Rack anchor</th></tr></thead><tbody>${rawRowsHtml(group, suggestion)}</tbody></table></div>
      </section>`;
    if (!dialog.open) dialog.showModal();
  }

  function exportDetailed() {
    const headers = ['SKU', 'Product Name', 'L1 Aktual', 'Current Zone', 'Aisle', 'SLOC / Rack', 'Current Qty', 'Status L1', 'Target L1', 'Recommended Zone', 'Anchor Aisle', 'Suggested Rack Cluster', 'Suggested Move Qty', 'Recommendation Status', 'Reason', 'Capacity Check'];
    const output = [headers];
    visibleV2().forEach((group) => {
      const suggestion = recommendationFor(group);
      group.raw.forEach((row) => output.push([group.sku, group.product, group.l1, zoneName(row.placementZone), row.Aisle, row['SLOC / Rack'], row.parsedQty, row['Status L1'], row['Target L1'], suggestion.target, suggestion.anchorAisle, suggestion.candidateRack, suggestion.moveQty, suggestion.code, suggestion.reason, suggestion.capacity]));
    });
    const csv = `\uFEFF${output.map((line) => line.map((value) => `"${text(value).replaceAll('"', '""')}"`).join(',')).join('\r\n')}`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `mzc2-sku-rebalancing-detail-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
  }

  function upgrade() {
    if (!Array.isArray(groups) || !byId('ledger')) return;
    const heading = byId('ledger').closest('.section').querySelector('.section-heading span');
    if (heading) heading.textContent = 'Klik SKU untuk melihat raw SLOC dan saran review';
    const lead = byId('ledger').closest('.section').querySelector('.ledger-head span');
    if (lead) lead.textContent = 'Saran hanya kandidat konsolidasi, bukan instruksi pindah.';
    const notice = byId('snapshot').previousElementSibling;
    if (notice) notice.innerHTML = '<strong>Aturan prototype:</strong> Kandidat tujuan hanya muncul bila minimal 70% qty SKU sudah berada di satu zona. Di bawah itu perlu review manual. Kapasitas rack belum divalidasi.';
    renderLedgerV2();
  }

  byId('closeDetail').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  document.addEventListener('input', (event) => { if (event.target.id === 'search') { event.stopImmediatePropagation(); renderLedgerV2(); } }, true);
  document.addEventListener('change', (event) => { if (event.target.id === 'view' || event.target.id === 'sort') { event.stopImmediatePropagation(); renderLedgerV2(); } }, true);
  document.addEventListener('click', (event) => {
    const skuButton = event.target.closest('[data-sku]');
    if (skuButton) { event.preventDefault(); event.stopImmediatePropagation(); openDetail(groups.find((group) => group.sku === skuButton.dataset.sku)); return; }
    if (event.target.id === 'download') { event.preventDefault(); event.stopImmediatePropagation(); exportDetailed(); }
  }, true);

  let lastSignature = '';
  setInterval(() => {
    const signature = Array.isArray(sourceRows) ? `${sourceRows.length}:${snapshotAt}` : '';
    if (signature && signature !== lastSignature) { lastSignature = signature; upgrade(); }
  }, 300);
})();
