# Temporary L1 Accuracy Mapping Specification

**Version:** 0.1  
**Status:** Confirmed temporary L1 rule set  
**Source of truth:** `adadada.xlsx`, Sheet1  
**Scope:** Temporary hardcoded L1 placement rules for CBT

## 1. Rule semantics

The workbook contains allowed L1 categories, not a single mandatory category in every row. When a cell contains multiple categories separated by line breaks or commas, all recognized categories are treated as allowed.

```text
COMPLIANT = actual L1 is included in the allowed L1 set
NON_COMPLIANT = actual L1 is not included in the allowed L1 set
UNMAPPED = no target row or no recognized allowed category exists
EMPTY = master SLOC has no SOH
```

L2 category and SKU have no placement target in this version. They are visibility-only dimensions and must not receive compliant/non-compliant status.

## 2. Proposed mezzanine mapping

Workbook dimensions:

- Mezzanine module A-F.
- Warehouse level/floor 1-3.
- Gangway 1-36, with a special split on module D floor 3.
- One or more allowed L1 categories.
- A business zone label for context.

Proposed physical mapping:

| Workbook block | Level | Physical zone-floor |
|---|---:|---|
| Mezzanine A | 1-3 | MZA1-MZA3 |
| Mezzanine B | 1-3 | MZB1-MZB3 |
| Mezzanine C | 1-3 | MZC1-MZC3 |
| Mezzanine D | 1-2 | MZD1-MZD2 |
| Mezzanine D, business zone HRB | 3 | HRB3 |
| Mezzanine D, business zone HRA | 3 | HRA3 |
| Mezzanine E | 1-3 | MZE1-MZE3 |
| Mezzanine F | 1-3 | MZF1-MZF3 |

The warehouse owner confirmed that Mezzanine A-F maps to physical MZA-MZF conceptually. Module D floor 3 is the high-value/HR area. Current physical rack codes remain HRA3 and HRB3 according to the master. The application uses the canonical term `Aisle`; it does not expose `Gangway`.

For standard mezzanine locations:

```text
workbook gangway = rack address aisle
allowed category applies to all bays, rack levels, and positions in that aisle
```

## 3. Proposed SPR mapping

The workbook SPR section contains:

- Gangway A-1 through A-14.
- Gangway B-1 through B-20.
- Gangway C-1 through C-24.

These counts exactly match the master rack aisle counts:

| Workbook gangway family | Physical zone | Aisle range |
|---|---|---|
| A | SRA1 | 01-14 |
| B | SRB1 | 01-20 |
| C | SRC1 | 01-24 |

For SPR:

```text
letter = physical SPR zone
numeric aisle = rack address aisle
allowed category applies to all bays, rack levels, and positions unless a bay exception is stated
```

## 4. Category normalization

Category matching will trim whitespace, normalize case, and apply explicit aliases without changing the source workbook.

Proposed aliases:

| Workbook text | Canonical SOH L1 |
|---|---|
| `Perawatan diri` | `Perawatan Diri` |
| `Bahan Masak & Bumbu` | `Bahan Masak & Bumbu` |
| `Tepung & Bahan kue` | `Tepung & Bahan Kue` |
| `Pelaratan ibu & Bayi` | `Peralatan Ibu & Bayi` |
| `kebutuhan ibadah` | `Kebutuhan Ibadah` |
| `Menu Praktis` | `Menu Praktis ` in the current SOH export, normalized by trimming |

`Non halal` has no matching actual L1 category in the current SOH sample. It remains a valid planned label but will not match stock unless a canonical product category is later supplied.

## 5. Special rules

### Multiple allowed categories

Confirmed: examples such as:

```text
Snack
Biskuit
```

mean either `Snack` or `Biskuit` is compliant.

### SRC1 aisle 18

The workbook states:

```text
Perawatan Rumah
Tata Rumah (only bay 13-17)
```

Confirmed interpretation:

- `Perawatan Rumah` is allowed across SRC1 aisle 18.
- `Tata Rumah` is allowed only on bays 13-17.
- `Tata Rumah` outside bays 13-17 is non-compliant.

### Blank SPR target rows

SPR C-4, C-5, and C-6 have no category target.

- A master SLOC with no SOH is `EMPTY`.
- An occupied SLOC in a blank target row is not empty.
- An occupied blank-target SLOC is `NO TARGET / NOT ASSESSED` and is excluded from the accuracy numerator and denominator.

### Non-halal

The planned non-halal zone remains visible in the layout. Non-halal is excluded from the L1 accuracy numerator and denominator until a canonical SOH L1 category is supplied.

## 6. Accuracy grain

Evaluation grain:

```text
snapshot + rack address + SKU + L1 category
```

Aggregations:

```text
L1 quantity accuracy = compliant quantity / mapped quantity
L1 SLOC accuracy = compliant occupied SLOC / mapped occupied SLOC
wrong L1 quantity = non-compliant quantity
wrong L1 value = sum(non-compliant quantity × COGS)
```

Mixed racks are evaluated per category quantity, so compliant and non-compliant stock can coexist in one SLOC.

## 7. Visibility-only fields

The following remain descriptive until future target mappings are supplied:

- L2 category.
- SKU placement.
- category/SKU count per SLOC.
- SKU fragmentation across zones, floors, aisles, and rack cells.

Dashboard language must use `distribution`, `mix`, or `visibility`, not `accuracy`, for L2 and SKU.

## 8. Required confirmations

Confirmed:

1. SPR A/B/C maps to SRA1/SRB1/SRC1.
2. Mezzanine A-F maps conceptually to MZA-MZF.
3. A workbook cell containing several categories means all listed categories are allowed.
4. On SRC1 aisle 18, Tata Rumah is allowed only on bays 13-17.
5. Non-halal is visibility-only and excluded from accuracy for now.

All temporary L1 mapping decisions required for the baseline calculation are confirmed.

## 9. Confirmed baseline result

Using the 2026-07-23 SOH snapshot and rack master:

| Metric | Result |
|---|---:|
| L1 quantity accuracy | 88.90% |
| L1 COGS-value accuracy | 90.57% |
| L1 SLOC accuracy | 97.28% |
| Mapped quantity | 3,469,626 |
| Compliant quantity | 3,084,428 |
| Wrong-L1 quantity | 385,198 |
| Wrong-L1 value | Rp7,096,897,764 |
| Mapped occupied SLOC | 43,461 |
| Compliant occupied SLOC | 42,279 |
| Wrong-L1 SLOC | 1,182 |
| No-target occupied SLOC | 164 |
| Excluded occupied SLOC | 60 |
| Empty master SLOC | 54,618 |

Non-halal is excluded. L2 and SKU remain visibility-only.
