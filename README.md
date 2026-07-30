# Inventory Control Tower · CBT

Dashboard operasional warehouse CBT untuk memantau Putaway, akurasi Planogram L1, occupancy rack, dan 3D Rack View. Aplikasi ini berjalan sebagai static dashboard + Vercel Serverless Functions; credential dan query sumber data selalu berada di server.

## Halaman utama

| Menu | URL | Fungsi |
| --- | --- | --- |
| Putaway Monitoring | `/putaway` | Output completed, SLA, vendor, manpower, dan priority queue Putaway. |
| 3D Rack View | `/sra1-spatial-prototype.html` | Tampilan visual rack/SLOC per zone. |
| Planogram Accuracy | `/preview/planogram-l1-monitoring-prototype.html?zone=ALL` | Kepatuhan kategori L1 terhadap aturan rack. |
| Occupancy | `/occupancy` | Kapasitas rack, SOH, serta occupancy Qty dan SLOC per target L1. |
| Lost Monitoring | `/sra1-spatial-prototype.html#lost-monitoring` | Titik awal monitoring lost stock. |

`/` otomatis mengarah ke Putaway Monitoring.

## Struktur project

```text
api/       Vercel Functions: sync dan API dashboard
lib/       Logika WMS, SLA Putaway, placement L1, occupancy
public/    Halaman yang dipublish ke Vercel dan data rules aktif
scripts/   Utility untuk membangun ulang data master/rules lokal
test/      Regression test Node.js
docs/      PRD, kontrak data, dan referensi mapping warehouse
```

File runtime penting:

- `public/preview/putaway-superset-ledger.html` — Putaway Monitoring.
- `public/preview/planogram-l1-monitoring-prototype.html` — Planogram Accuracy.
- `public/preview/occupancy-dashboard-preview.html` — Occupancy.
- `public/sra1-spatial-prototype.html` — 3D Rack View.
- `public/data/l1-placement-rules.json` — aturan target kategori L1 yang aktif.
- `public/data/master-rack-index.json` — master capacity/rack yang aktif.

## Menjalankan lokal

Prasyarat: Node.js 24 dan akun Vercel yang punya environment variable project.

```powershell
npm ci
npm test
npx vercel dev
```

Buka `http://localhost:3000/putaway`. Untuk melihat Planogram statis tanpa Vercel Functions, jalankan `node scripts/serve-planogram-preview.js`.

## Environment variable

Salin `.env.example` menjadi `.env.local`; jangan pernah commit nilai rahasia.

| Kelompok | Variable |
| --- | --- |
| MotherDuck | `MOTHERDUCK_POSTGRES_HOST`, `MOTHERDUCK_POSTGRES_URL`, `MOTHERDUCK_TOKEN`, `MOTHERDUCK_DATABASE` |
| WMS | `WMS_ACCESS_TOKEN`, `WMS_DEVICE`, `WMS_DEVICE_ID` |
| Superset | `SUPERSET_BASE_URL`, `SUPERSET_SESSION_COOKIE` |
| Sinkronisasi | `SYNC_SECRET` |
| Putaway tuning (opsional) | `WMS_PUTAWAY_MAX_PAGES`, `WMS_ACTIVE_DETAIL_LIMIT`, `WMS_NEW_COMPLETED_DETAIL_LIMIT`, `WMS_STALE_ACTIVE_DETAIL_LIMIT`, `WMS_ACTIVE_DETAIL_MAX_AGE_MINUTES`, `WMS_PO_REFRESH_LIMIT`, `WMS_PO_MAX_PAGES` |

Endpoint `/api/sync-putaway` dan `/api/sync-soh` membutuhkan header `X-Sync-Secret`; gunakan hanya dari scheduler terpercaya seperti cron-job.org.

## Data dan definisi ringkas

- **L1 Correct / Wrong L1 / No Target** dihitung berdasarkan SLOC terisi. `No Target` tidak masuk denominator akurasi sampai mapping rack diset.
- **Occupancy Qty** membandingkan SOH terhadap capacity quantity; **Occupancy SLOC** membandingkan SLOC yang terisi terhadap total SLOC di area tersebut.
- **Putaway SLA** memakai SLA enam jam. Completed dihitung memakai timestamp selesai; task aktif dihitung dari DONE GRN/Putaway pending fallback sampai waktu sekarang.

Detail aturan dan sumber data ada di [`docs/`](docs/).

## Testing dan deploy

```powershell
npm test
git push origin master
```

Push ke branch `master` memicu deployment production Vercel secara otomatis. Setelah deploy, cek halaman live dan timestamp snapshot, bukan hanya status deployment.
