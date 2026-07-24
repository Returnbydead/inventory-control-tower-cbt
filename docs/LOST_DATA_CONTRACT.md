# LOST Detail — Draft Data Contract

**Version:** 0.1  
**Status:** Draft; requires sample data and business validation

## 1. Recommended grain

Satu baris merepresentasikan **satu SKU pada satu lokasi dalam satu kasus LOST**.

Jika satu kasus mencakup tiga SKU, kasus tersebut memiliki tiga baris dengan `lost_case_id` yang sama dan `lost_line_id` yang berbeda. Grain ini dipilih sementara agar prioritas per SKU dan detail lokasi dapat dihitung tanpa menyimpan array atau data gabungan dalam satu cell.

## 2. Required source columns

| Field | Type | Required | Description / rule |
|---|---|---:|---|
| `lost_line_id` | text | Yes | ID unik dan stabil untuk satu baris. Tidak boleh dibuat dari nomor row saja. |
| `lost_case_id` | text | Yes | ID kasus yang mengelompokkan satu atau lebih SKU. |
| `warehouse_id` | text | Yes | Kode warehouse. Walau MVP satu warehouse, field tetap disimpan. |
| `detected_at` | datetime | Yes | Waktu kejadian pertama kali diketahui, dengan timezone. |
| `lost_type` | enum | Yes | Nilai awal: `LDP`, `LBH`, `KOLI_HILANG`; menunggu validasi. |
| `sku` | text | Yes | Kode SKU sebagai text agar leading zero tidak hilang. |
| `sku_name` | text | No | Nama barang; idealnya diambil dari master SKU. |
| `zone` | text | Conditional | Zone terkait kejadian jika diketahui. |
| `location_code` | text | Conditional | Lokasi/bin terkait kejadian jika diketahui. |
| `missing_qty` | decimal | Yes | Quantity hilang; harus lebih besar dari 0. |
| `uom` | text | Yes | Unit of measure quantity, misalnya `EA`, `PCS`, atau `KOLI`. |
| `unit_value` | decimal | Conditional | Nilai per unit dalam currency yang disepakati. |
| `currency` | text | Conditional | Contoh `IDR`; wajib jika `unit_value` terisi. |
| `status` | enum | Yes | Draft awal: `OPEN`, `INVESTIGATING`, `FOUND`, `ADJUSTED`, `CLOSED`, `CANCELLED`. |
| `owner` | text | No | PIC tindak lanjut. |
| `notes` | text | No | Catatan singkat; jangan gunakan sebagai pengganti field terstruktur. |
| `source_reference` | text | Yes | ID task/report atau referensi yang dapat ditelusuri. |
| `created_at` | datetime | Yes | Waktu baris dibuat di source. |
| `updated_at` | datetime | Yes | Waktu business record terakhir berubah. |
| `updated_by` | text | Yes | User/process yang terakhir mengubah data. |
| `resolved_at` | datetime | Conditional | Wajib jika status dianggap resolved/closed. |

## 3. Derived application fields

| Field | Formula / meaning |
|---|---|
| `lost_value` | `missing_qty × unit_value` |
| `case_age_minutes` | Menit dari `detected_at` ke `resolved_at`, atau waktu sekarang jika masih open |
| `sla_due_at` | `detected_at + configured SLA` |
| `sla_state` | `ON_TRACK`, `AT_RISK`, `OVERDUE`, atau `NOT_APPLICABLE` |
| `source_updated_at` | Timestamp perubahan bisnis terakhir dari source |
| `ingested_at` | Timestamp worker berhasil menyimpan record |
| `freshness_seconds` | Selisih `ingested_at - source_updated_at` untuk record/snapshot |
| `row_checksum` | Hash field bisnis untuk mendeteksi perubahan dan menghindari update kosong |

## 4. Validation rules

- Kombinasi `lost_line_id` harus unik.
- `lost_case_id`, SKU, warehouse, detected time, lost type, quantity, UOM, status, dan source reference tidak boleh kosong.
- `missing_qty` harus lebih besar dari 0.
- `unit_value` tidak boleh negatif.
- `resolved_at` tidak boleh lebih awal daripada `detected_at`.
- Record dengan currency berbeda tidak boleh langsung dijumlahkan tanpa conversion rule.
- Enum yang tidak dikenal masuk quarantine dan tidak otomatis dipetakan.
- Timestamp tanpa timezone ditafsirkan sebagai Asia/Jakarta hanya jika source contract sudah menyatakannya secara eksplisit.
- Record dengan ID sama dan checksum sama dilewati; record dengan ID sama dan checksum berbeda di-update.

## 5. Recommended workbook structure

### Sheet `lost_input`

Tempat data manual atau hasil automation dimasukkan. Gunakan header persis seperti kontrak final, satu header row, tanpa merged cell, subtotal, atau baris kosong dekoratif.

### Sheet `reference_values`

Berisi enum yang diizinkan, warehouse, zone, location, status, UOM, dan mapping lain untuk data validation dropdown.

### Sheet `sync_status`

Read-only untuk user biasa. Menampilkan last attempt, last success, rows processed, rejected rows, dan error terakhir.

### Sheet `rejected_rows`

Opsional pada MVP. Menampilkan ID dan alasan penolakan tanpa menjadi sumber input kedua.

## 6. Sync contract

- Worker membaca source setiap 1 menit.
- Sync harus memiliki distributed lock agar dua invocation tidak memproses snapshot yang sama bersamaan.
- Worker membaca data secara batch dan menghitung checksum.
- Upsert memakai `lost_line_id` sebagai conflict key.
- Penghapusan source tidak langsung menghapus data aplikasi; gunakan soft-delete atau rekonsiliasi terkontrol.
- Satu sync gagal tidak boleh menggantikan snapshot sukses terakhir.
- Setiap run menulis audit record dengan jumlah read, inserted, updated, skipped, rejected, dan duration.

## 7. Information required before implementation

1. Contoh 20–50 baris data LOST yang sudah dianonimkan bila perlu.
2. Arti LDP dan LBH serta workflow masing-masing.
3. Contoh satu kasus yang memiliki lebih dari satu SKU/lokasi.
4. Sumber quantity, UOM, dan unit value.
5. Status aktual yang dipakai tim dan transisi yang diperbolehkan.
6. Target SLA per tipe LOST.
7. Cara automation/manual task menulis ke GSheet dan apakah `updated_at` tersedia.

