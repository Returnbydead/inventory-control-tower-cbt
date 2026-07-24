# SOH SKU Split Analysis — Data Requirements

**Version:** 0.1  
**Status:** Sample received; waiting for zone-rule validation

## Master rack received on 2026-07-23

The master rack file contains 98,303 unique locations and allows the layout to render empty and occupied rack cells. Relevant fields are:

| Master field | Use |
|---|---|
| `rack_name` | Unique physical SLOC and join key to SOH |
| `REMAKS_ZONE` | Storage role such as PICKFACE, STORAGE, STAGING, or QUARANTINE |
| `ZONE` | Zone-floor code |
| `LVL` | Rack level |
| `picking_area_id` | Secondary grouping; only partly populated |
| `area_id` | Primary summary/grouping candidate; fully populated |

Two additional planning fields are required to calculate placement accuracy rather than only observed purity:

- `expected_l1_category`
- `expected_l2_category`

## Sample mapping received on 2026-07-23

The received CSV supports the following mapping:

| Required concept | Source / derivation |
|---|---|
| Warehouse | `location_name` |
| SKU | `sku_number` |
| Product key | `product_id` |
| Rack/location | `rack_name` |
| Zone | Alphabetic portion of the second `rack_name` token, e.g. `MZE` |
| Warehouse floor | Trailing number of the second token, e.g. `1` in `MZE1` |
| Aisle | Third `rack_name` token |
| Bay / rack row | Fourth `rack_name` token |
| Rack level | Numeric portion of the fifth token, e.g. `2` in `L2` |
| Position / slot | Sixth token; operational name pending confirmation |
| SOH | `stock` |
| Product category | `l1_category_name`, `l2_category_name` |
| Package reference | `package_label` |
| Record status | `product_detail_status_name` |
| Product source status | `source_status` |
| Unit value | `cogs` |
| Record updated time | `product_detail_updated_at` |

The source does not contain a shared `snapshot_at`. The ingestion layer must add it. `l1_category_name` is a product category and must not be interpreted as rack level `L1`. Likewise, the warehouse floor in `MZE1` must not be confused with rack level `L2`.

## 1. Minimum viable dataset

Untuk membuktikan SKU pecah antar-zone, minimum kolom yang dibutuhkan:

| Field | Required | Purpose |
|---|---:|---|
| `snapshot_at` | Yes | Memastikan hanya satu kondisi waktu yang dibandingkan |
| `warehouse_id` | Yes | Membatasi scope warehouse |
| `sku` | Yes | Business key produk |
| `zone` | Yes | Menentukan cross-zone split |
| `location_code` | Yes | Menentukan within-zone fragmentation |
| `soh_qty` | Yes | Menghitung placement aktif dan distribusi stock |
| `inventory_status` | Recommended | Memisahkan available, hold, damage, quarantine, dan status lain |

Dengan tujuh field tersebut, kita sudah dapat membuat analisis dasar. Namun “actionable split” yang akurat memerlukan konteks tambahan.

## 2. Strongly recommended fields

| Field | Why it matters |
|---|---|
| `l1` | Memvalidasi analisis berdasarkan L1 |
| `sku_name` | Membuat hasil dapat dibaca operator |
| `product_category` | Segmentasi dan prioritas |
| `uom` | Mencegah quantity dengan satuan berbeda digabung |
| `batch` / `lot` | Menjelaskan split yang valid karena batch |
| `expiry_date` | Menjelaskan split yang valid karena expiry/FEFO |
| `storage_type` | Membedakan pick face, reserve, bulk, staging, dan lainnya |
| `location_status` | Mengecualikan blocked/temporary location |
| `hu_or_lpn` | Menentukan apakah stock terikat handling unit |
| `updated_at` | Mengukur freshness record |

## 3. Optional enrichment

- Unit value untuk memprioritaskan stock bernilai tinggi.
- Unit volume/dimensi untuk memperkirakan dampak kapasitas.
- Velocity atau outbound frequency untuk mempertimbangkan pick-face needs.
- Target/home zone SKU untuk mendeteksi wrong-zone placement.
- Location capacity untuk menilai apakah konsolidasi benar-benar feasible.

## 4. Provisional calculation

Pada satu `snapshot_at`:

```text
active placement = soh_qty > 0 dan inventory_status termasuk status aktif
zone_count = distinct zone per SKU pada active placement
location_count = distinct location_code per SKU pada active placement
cross_zone_split = zone_count > 1
dominant_zone = zone dengan total soh_qty terbesar
dominant_zone_share = dominant_zone_qty / total_sku_soh
fragmented_qty = total_sku_soh - dominant_zone_qty
```

`actionable_split` baru ditetapkan setelah allowed-zone, inventory-status, storage-type, batch/expiry, dan threshold residual divalidasi.

## 5. Source grain assumption

Grain yang diharapkan:

`snapshot_at + warehouse_id + sku + zone + location_code + inventory_status + batch/lot + uom`

Jika source lebih detail, misalnya per HU/LPN, data boleh diagregasi setelah uniqueness dan join coverage diperiksa. Jika source sudah lebih agregat dari location, analisis persebaran lokasi tidak dapat dilakukan dengan aman.

## 6. First profiling checks

Saat sample data tersedia, pemeriksaan pertama adalah:

1. Row count, columns, types, dan rentang snapshot.
2. Duplicate pada candidate grain.
3. Null/blank SKU, zone, location, status, dan SOH.
4. Negative dan zero SOH.
5. Distinct zone/location/status/L1.
6. Total SOH sebelum dan sesudah agregasi.
7. Persentase SKU pada 1, 2, 3, dan lebih banyak zone.
8. Distribusi location count dan dominant-zone share.
9. Zone/status combinations yang kemungkinan merupakan exception valid.
10. Konsistensi UOM, batch, expiry, serta join ke master SKU bila tersedia.

## 7. Sample requested

Kirim salah satu:

- export CSV/XLSX dari report SOH; atau
- copy GSheet ke file XLSX/CSV; atau
- minimal header dan 50–200 baris contoh.

Sample ideal mencakup:

- SKU yang hanya berada pada satu zone;
- SKU yang benar-benar pecah antar-zone;
- SKU yang berada di pick face dan reserve;
- stock hold/damage/quarantine;
- zero atau negative SOH jika ada;
- satu SKU dengan beberapa batch atau UOM.
