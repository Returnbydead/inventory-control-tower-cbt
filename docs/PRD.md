# Inventory Control Tower — Product Requirements Document

**Version:** 0.2  
**Status:** Draft for business validation  
**Initial module:** SOH DETAIL — SKU Split Across Zones  
**Deferred module:** LOST DETAIL  
**Initial scope:** One warehouse

## 1. Product vision

Inventory Control Tower menjadi single source of truth (SSOT) operasional inventory untuk satu warehouse. Produk menyatukan report yang saat ini tersebar di banyak Google Sheets menjadi satu aplikasi yang cepat, dapat ditelusuri, dan membantu tim menentukan pekerjaan yang harus diprioritaskan.

## 2. Users and decisions

| Role | Main need | Decision supported |
|---|---|---|
| Inventory Manager | Melihat distribusi stock yang tidak efisien | SKU mana yang perlu dikonsolidasikan dan dari zona mana |
| Hoplly | Memantau kondisi operasional warehouse | Exception mana yang harus ditindaklanjuti lebih dahulu |

## 3. Current problems

- Report inventory tersebar di banyak Google Sheets.
- Stock satu SKU dapat tersebar di beberapa zone dan location.
- Belum ada satu tampilan yang membedakan persebaran normal dari SKU yang benar-benar perlu dikonsolidasikan.
- User harus menggabungkan report secara manual untuk menentukan prioritas.
- Pembacaan Google Sheets langsung dari web berpotensi lambat dan tidak stabil sebagai jalur query utama.

## 4. Product roadmap

1. **SOH DETAIL** — seluruh stock per zone dan L1; analisis SKU yang tersebar di banyak zone/location.
2. **LOST DETAIL** — detail LDP, LBH, dan koli hilang; prioritas lost berdasarkan value tertinggi; detail per SKU.
3. **PUTAWAY DETAIL** — SLA, pending detail, dan alert pelanggaran SLA.
4. **REPORT REPLENISH** — movement completion per SKU dan daily replenishment.
5. **TROUBLESHOOT** — jam cut-off, SLA, dan daily report.
6. **BTI DAILY REPORT** — barang masuk, barang keluar, dan detail movement.

Perubahan prioritas ke SOH tidak menghapus draft LOST. Modul LOST tetap berada di backlog dan dilanjutkan setelah struktur datanya siap.

## 5. MVP scope: SOH SKU Split Analysis

MVP harus memungkinkan user:

- melihat total SKU dengan SOH positif;
- melihat jumlah dan persentase SKU yang berada di lebih dari satu zone;
- melihat jumlah SKU yang berada di banyak location dalam zone yang sama;
- melihat jumlah zone dan location untuk setiap SKU;
- melihat total SOH dan distribusi quantity per zone/location;
- memprioritaskan SKU berdasarkan tingkat persebaran dan dampak operasional;
- membuka detail seluruh lokasi untuk satu SKU;
- memfilter berdasarkan snapshot time, zone, L1, SKU, product category, dan exception state;
- membedakan storage zone normal dari zone yang tidak seharusnya menampung SKU tersebut, jika mapping aturan tersedia;
- melihat kapan source dan dashboard terakhir diperbarui.

### Out of scope for SOH MVP

- Menjalankan movement atau consolidation otomatis ke WMS.
- Menentukan target zone tanpa rule/mapping resmi dari warehouse.
- Multi-warehouse.
- Forecasting kebutuhan lokasi.
- LOST, Putaway, Replenish, Troubleshoot, dan BTI selain navigasi roadmap.

## 6. Definition of “SKU pecah”

Definisi awal:

- **Cross-zone split:** satu SKU memiliki `soh_qty > 0` pada lebih dari satu `zone`.
- **Within-zone split:** satu SKU berada di lebih dari satu `location_code` dalam zone yang sama.
- **L1 split:** satu SKU berada di lebih dari satu kelompok L1, jika L1 merupakan klasifikasi yang berbeda dari zone.

SKU tidak otomatis dianggap bermasalah hanya karena tersebar. Exception perlu mempertimbangkan:

- zone/location yang memang diizinkan untuk SKU tersebut;
- pick face versus reserve/bulk storage;
- hold, damage, quarantine, inbound, staging, atau operational buffer;
- batch, expiry, inventory status, dan UOM;
- kapasitas lokasi dan kebutuhan replenishment;
- quantity yang sangat kecil atau residual stock.

## 7. Proposed KPI framework

### Primary KPIs

| KPI | Provisional definition | Decision supported |
|---|---|---|
| Cross-zone Split SKU | Jumlah SKU dengan SOH positif pada lebih dari satu zone | Besar backlog SKU yang perlu diperiksa |
| Actionable Split SKU | Split SKU setelah location/zone yang valid dikecualikan | Prioritas kerja konsolidasi yang lebih bersih |
| Fragmented SOH Quantity | Total quantity pada lokasi/zone non-dominan untuk actionable split SKU | Estimasi volume stock yang berpotensi dipindahkan |

### Driver metrics

| Metric | Provisional definition |
|---|---|
| Zone Count per SKU | Jumlah distinct zone dengan SOH positif |
| Location Count per SKU | Jumlah distinct location dengan SOH positif |
| Dominant Zone Share | SOH pada zone terbesar dibagi total SOH SKU |
| Residual Location Count | Jumlah location non-dominan dengan quantity di bawah threshold |
| Split Severity Score | Skor prioritas berbasis zone count, location count, fragmented quantity, dan rule violation |

### Initial priority logic

Urutan prioritas provisional:

1. SKU berada di zone terlarang atau tidak sesuai mapping.
2. SKU berada pada banyak zone dengan fragmented quantity besar.
3. SKU berada pada banyak location dan dominant-zone share rendah.
4. SKU memiliki banyak residual quantity kecil di lokasi non-dominan.

Bobot dan threshold belum boleh dianggap final sebelum data SOH diprofilkan.

## 8. Data source and freshness

### Required source

Analisis aktual membutuhkan snapshot SOH pada grain minimal:

`snapshot_at + warehouse_id + sku + zone + location_code + inventory_status`

Sumber dapat berasal dari export Superset ke GSheet. Akses database Astro langsung tidak diperlukan.

### Service-level objective

- Target dashboard: perubahan yang sudah masuk ke GSheet terlihat di web dalam maksimal 2 menit.
- Sinkronisasi target setiap 1 menit.
- Dashboard membaca database serving layer, bukan GSheet pada setiap page request.

### Initial flow

`Superset SOH report → GSheet → sync worker → Postgres → dashboard`

Jika API Superset tersedia di masa depan:

`Superset API → sync worker → Postgres → dashboard`

## 9. Proposed user experience

### SOH overview

- KPI cards: Total Active SKU, Cross-zone Split SKU, Actionable Split SKU, Fragmented SOH.
- Priority table: SKU dengan severity tertinggi beserta dominant zone, zone count, location count, dan fragmented quantity.
- Distribution: jumlah exception berdasarkan zone dan severity.
- Data quality panel: missing zone/location, duplicate grain, negative SOH, dan freshness.

### SKU detail

- Total SOH dan jumlah zone/location.
- Breakdown quantity per zone dan location.
- Penanda dominant zone/location.
- Inventory status, L1, batch/expiry jika tersedia.
- Alasan SKU diklasifikasikan sebagai exception.
- Candidate consolidation quantity sebagai rekomendasi analitis, bukan perintah movement.

## 10. Functional requirements

- Sistem menghitung distinct zone/location hanya untuk record yang lolos aturan SOH aktif.
- Sistem tidak mencampur snapshot time berbeda dalam satu analisis.
- Filter dashboard diterapkan konsisten pada KPI, visual, dan detail.
- Setiap exception memiliki reason code yang dapat dijelaskan.
- Sistem menyimpan source identifier dan snapshot timestamp untuk rekonsiliasi.
- Sistem mencatat setiap sync dan mempertahankan snapshot valid terakhir jika sync gagal.

## 11. Data-quality guardrails

- Grain source harus diuji sebelum agregasi; duplicate composite key tidak boleh menggandakan SOH.
- Null SKU, zone, location, SOH, atau snapshot time dilaporkan terpisah.
- Negative SOH dan zero SOH tidak otomatis dihitung sebagai active placement.
- Zone/status operasional yang dikecualikan harus menggunakan mapping resmi, bukan hard-code tersembunyi.
- Total SOH dashboard harus dapat direkonsiliasi dengan source pada snapshot dan filter yang sama.
- Snapshot parsial atau stale tidak boleh ditampilkan sebagai kondisi warehouse lengkap.

## 12. MVP acceptance criteria

- Total SOH per SKU/zone/location dapat direkonsiliasi dengan source.
- Sistem mengidentifikasi SKU dengan lebih dari satu zone secara benar pada data uji.
- User dapat membuka seluruh detail lokasi dari priority table.
- Exception yang dikecualikan memiliki reason code yang terlihat.
- Priority score dapat dijelaskan dari komponennya.
- Dashboard menampilkan snapshot time dan freshness status.
- Inventory Manager menyetujui definisi actionable split dan urutan prioritas.

## 13. Delivery stages

1. Terima satu atau lebih snapshot SOH dan data dictionary source.
2. Profiling grain, completeness, uniqueness, status, zone, dan distribusi SOH.
3. Validasi definisi cross-zone, L1, location, serta exclusion rules.
4. Finalisasi KPI dan priority score berdasarkan distribusi nyata.
5. Buat wireframe SOH overview dan SKU detail.
6. Proof of concept ingestion GSheet/Superset export ke Postgres.
7. Implementasi dashboard dan reconciliation tests.
8. UAT, deployment Vercel, dan monitoring.

## 14. Open decisions

- Definisi field L1 dan hubungannya dengan zone/location.
- Zone/status mana yang merupakan placement normal, temporary, hold, damage, atau quarantine.
- Apakah SKU memang boleh berada di pick face dan reserve zone secara bersamaan.
- Threshold residual quantity yang layak ditindaklanjuti.
- Apakah batch, expiry, HU/LPN, dan UOM harus membedakan placement.
- Sumber master SKU, product category, unit volume, dan unit value.
- Cadence snapshot Superset dan apakah report merupakan full snapshot atau incremental.
- Cara menentukan target/dominant zone yang benar.

