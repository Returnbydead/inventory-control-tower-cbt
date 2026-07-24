# SOH Sample Profile — 2026-07-23

**Source:** `20260723_133134.csv`  
**Purpose:** Validate whether the sample supports SKU split analysis  
**Status:** Address hierarchy partly confirmed; storage-role rules not yet applied

## 1. Verdict

The sample is sufficient to:

- calculate SOH by SKU, rack, and derived zone;
- identify SKUs present in more than one zone code;
- calculate dominant-zone share and provisional fragmented quantity;
- drill from SKU to package/rack detail.

The sample is not yet sufficient to classify every split as actionable. Zone hierarchy, allowed zone combinations, staging/quarantine treatment, and storage-role rules still need business validation.

## 2. Dataset profile

| Check | Result |
|---|---:|
| Rows | 52,035 |
| Columns | 16 |
| Warehouse | CBT - WH Cibitung |
| Distinct product IDs | 8,575 |
| Distinct SKU numbers | 8,575 |
| Distinct rack names | 43,687 |
| Total positive stock | 3,547,247 |
| Zero stock rows | 0 |
| Negative stock rows | 0 |
| Exact duplicate rows | 0 |

All rows have `product_detail_status_name = Available`. Source status contains `SOURCE`, `DISCONTINUED`, `TEMP_DISCONTINUED`, and `NOT_SOURCE`.

## 3. Source field interpretation

| Source field | Interpretation |
|---|---|
| `location_name` | Warehouse name, not bin/location detail |
| `product_id` | Internal product key |
| `sku_number` | SKU/business identifier |
| `rack_name` | Physical placement and the only available source for zone derivation |
| `stock` | SOH quantity at the row grain |
| `package_label` | Package/handling reference; not globally unique |
| `product_detail_status_name` | Inventory detail status; only `Available` in this sample |
| `source_status` | Product sourcing/lifecycle status, not inventory status |
| `l1_category_name` | Product category, not rack L1 level |
| `cogs` | Unit COGS, usable for provisional value prioritization |
| `product_detail_updated_at` | Record update timestamp, not a reliable snapshot timestamp |

## 4. Confirmed zone hierarchy

For standard rack names, the second token contains both the canonical zone and warehouse floor:

```text
CBT-MZE1-03-05-L2-05 → zone MZE, warehouse floor 1
CBT-HRB3-03-02-L1-04 → zone HRB, warehouse floor 3
CBT-SRC1-19-01-L2-03 → zone SRC, warehouse floor 1
```

The third token is aisle, the fourth is rack row/bay, and `L2` is the vertical rack level. The final token remains provisionally named position/slot pending confirmation.

The previously reported exact-code split treats different floors as different placements. It should now be separated into canonical cross-zone and cross-floor metrics in the next analysis run.

## 5. Revised split findings

The confirmed address hierarchy allows zone and floor fragmentation to be measured separately. Standard address parsing covers 52,030 rows and 8,571 SKUs; five non-standard rows require explicit mapping.

### Canonical zone

| Zone count per SKU | SKU count |
|---:|---:|
| 1 | 7,168 |
| 2 | 1,332 |
| 3 | 71 |

- Cross-zone SKU: **1,403 / 8,571 (16.37%)**

### Warehouse floor

| Floor count per SKU | SKU count |
|---:|---:|
| 1 | 7,820 |
| 2 | 747 |
| 3 | 4 |

- Cross-floor SKU: **751 / 8,571 (8.76%)**
- Cross zone-floor SKU: **1,425 / 8,571 (16.63%)**
- Multi-aisle SKU: **5,951 / 8,571 (69.43%)**
- Multi-rack-cell SKU: **6,439 / 8,571 (75.13%)**

Multi-aisle and multi-rack-cell placement are common and should be used as diagnostic detail, not as an exception by themselves.

## 6. Example provisional priorities

These are examples, not final action recommendations.

| SKU | Product | Zones | Families | Total SOH | Fragmented qty | Dominant share |
|---|---|---:|---:|---:|---:|---:|
| 8993496107068 | Sovia Minyak Goreng Pouch | 2 | 1 | 22,199 | 11,051 | 50.22% |
| 8993496001076 | Sania Minyak Goreng Pouch | 3 | 2 | 14,188 | 6,687 | 52.87% |
| 8999898962540 | Diamond Milk Full Cream Susu UHT | 3 | 2 | 15,477 | 6,521 | 57.87% |
| 8997203820035 | Jujur Minyak Goreng Pouch | 2 | 1 | 9,908 | 4,568 | 53.90% |
| 8993351121307 | Greenfields Full Cream Susu UHT | 3 | 2 | 18,938 | 3,677 | 80.58% |

`Fragmented qty = total SKU SOH - quantity in the largest derived exact zone`.

## 7. Data-quality findings

### High — Snapshot timestamp is absent

The file contains record update timestamps, but no shared `snapshot_at`. Mixing multiple exports later could double-count SOH unless the ingestion process adds an explicit extraction/snapshot timestamp.

**Required fix:** add `snapshot_at` at ingestion and keep snapshots isolated.

### High — Zone is encoded, not explicit

Zone is inferred from `rack_name`. Three rows use non-standard rack labels, and several special codes such as `STG1`, `QRT1`, `PLA1`, and `ADJ` likely require different treatment.

**Required fix:** create a maintained rack-to-zone/storage-role mapping.

### Medium — Package label is not a unique key

- 145 non-null package labels occur more than once.
- Some repeated labels belong to different SKUs.
- 52 rows have no package label.

**Required fix:** do not use `package_label` alone as the ingestion primary key. Preserve a source row identifier or use a validated composite key.

### Medium — Product detail timestamps vary widely

`product_detail_updated_at` ranges from November 2025 to July 2026. This is likely the last update of each record rather than freshness of the full SOH snapshot.

**Required fix:** use export/snapshot time for dashboard freshness and keep record timestamp only for lineage.

### Medium — Inventory exception coverage is incomplete

All rows are `Available`. There is no sample coverage for hold, damage, quarantine, or other inventory statuses, even though some rack codes appear to represent staging/quarantine.

**Required fix:** confirm whether the source report filters out non-available stock and whether that matches the business question.

### Medium — Expired stock exists

As of 2026-07-23, 33 rows across 31 SKUs have expiry dates in the past, totaling 211 units. Expiry treatment could change whether those placements count as actionable SOH.

**Required fix:** define whether expired stock is included, excluded, or shown as a separate exception.

## 8. Business rules still required

1. Is `MZF1` versus `MZF2` a real zone split or a sub-zone/aisle distinction?
2. Are `MZ`, `SR`, and `HR` separate operational storage families?
3. Which rack codes represent pick face, reserve, staging, quarantine, adjustment, or other temporary areas?
4. Is it normal for one SKU to be in both pick and reserve areas?
5. Should `DISCONTINUED`, `TEMP_DISCONTINUED`, and `NOT_SOURCE` products remain in the queue?
6. Is COGS approved for value-based prioritization?
7. Should expired stock be excluded from the normal split queue?

## 9. Recommended next analysis

After the zone mapping is confirmed:

1. classify every rack into `zone`, `zone_family`, and `storage_role`;
2. define allowed storage-role combinations;
3. calculate descriptive split and actionable split separately;
4. rank actionable split by rule violation, fragmented quantity, fragmented value, and rack count;
5. design the SOH overview and per-SKU drill-down from the validated outputs.
