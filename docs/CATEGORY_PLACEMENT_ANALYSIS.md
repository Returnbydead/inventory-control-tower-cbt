# Category Placement Analysis — L1 and L2

**Version:** 0.1  
**Status:** Temporary L1 accuracy baseline calculated; L2 and SKU are visibility-only  
**Warehouse:** CBT - WH Cibitung  
**Sources:** SOH sample `20260723_133134.csv` and rack master `20260723_164604.csv`

## 1. Business objective

Identify which storage locations are least aligned with warehouse category grouping, summarize the problem at an actionable area level, and drill down to the exact physical rack cell.

The current warehouse grouping uses L1 category. A planned project will add L2 category grouping.

## 2. Analysis hierarchy

```text
Warehouse
→ storage role
→ zone floor
→ area_id
→ aisle
→ bay
→ rack level
→ position / SLOC
→ SKU and package detail
```

`area_id` is recommended as the primary summary unit because it is populated for 100% of the rack master. `picking_area_id` is retained as a filter or secondary grouping because it is populated for only 50.29% of master racks.

## 3. Metric language

### Category purity

Describes the actual category composition without assuming a target:

```text
L1 purity = quantity from the dominant actual L1 / total quantity
L2 purity = quantity from the dominant actual L2 / total quantity
```

Purity can be calculated from the current data.

### Category accuracy

Measures compliance against an approved placement plan:

```text
L1 accuracy = quantity matching expected L1 / total in-scope quantity
L2 accuracy = quantity matching expected L2 / total in-scope quantity
```

Accuracy requires an explicit target mapping. The temporary mapping will be hardcoded from `adadada.xlsx` after its physical interpretation is confirmed. The dominant current category will not be used as the target because that would hide systematic misplacement.

### Mixed-rack rate

```text
mixed-rack rate = occupied rack cells containing more than one category / occupied rack cells
```

This measures local mixing. It does not measure whether a single-category rack is placed in the correct category area.

### Misplaced quantity

```text
misplaced quantity = quantity whose actual category differs from the expected category
```

This should become the primary operational backlog after the expected-category mapping exists.

## 4. Master rack coverage

| Metric | Result |
|---|---:|
| Unique master racks | 98,303 |
| Standard addresses parsed | 98,217 |
| Non-standard addresses | 86 |
| Occupied master racks | 43,685 |
| Empty master racks | 54,618 |
| Master occupancy | 44.44% |
| SOH racks missing from master | 2 |
| SOH rows matched to master | 52,032 / 52,035 |

The master is sufficiently complete to render both empty and occupied physical locations.

## 5. Baseline rack-cell purity

| Metric | L1 | L2 |
|---|---:|---:|
| Occupied rack cells | 43,687 | 43,687 |
| Mixed-category rack cells | 49 | 191 |
| Mixed-category rate | 0.11% | 0.44% |
| Rack cells below 80% purity | 20 | 75 |
| Quantity-weighted purity | 99.30% | 99.17% |

Interpretation: category mixing inside one exact rack cell is uncommon. The bigger business question is likely whether single-category rack cells are positioned inside the correct category area.

## 6. Area-level baseline

### L1

- 49 occupied `area_id` groups are present in the SOH sample.
- 43 contain more than one L1 category.
- Median area-level L1 purity is 89.85%.
- 17 areas have L1 purity below 80%.

### L2

L2 naturally contains more valid categories within an L1 area. A low L2 purity is not automatically a problem until the intended L2 zoning design is defined.

## 6A. Confirmed temporary L1 accuracy baseline

| Metric | Result |
|---|---:|
| Quantity accuracy | 88.90% |
| COGS-value accuracy | 90.57% |
| SLOC accuracy | 97.28% |
| Wrong-L1 quantity | 385,198 |
| Wrong-L1 value | Rp7.10B |
| Wrong-L1 SLOC | 1,182 |

Largest wrong-L1 quantity by physical zone:

| Zone | Wrong qty | Wrong SLOC | SLOC accuracy |
|---|---:|---:|---:|
| SRA1 | 156,420 | 197 | 88.63% |
| SRC1 | 137,487 | 474 | 75.67% |
| SRB1 | 68,743 | 61 | 95.99% |
| HRB3 | 5,282 | 122 | 89.80% |
| MZF3 | 4,736 | 29 | 97.39% |

The difference between 88.90% quantity accuracy and 97.28% SLOC accuracy indicates that a relatively small number of non-compliant SLOCs contain a disproportionate amount of stock.

## 7. Provisional low-purity L1 areas

Special staging/quarantine areas are shown separately because mixed categories can be expected there.

| Area ID | Zones | Dominant L1 | L1 categories | SOH | Purity | Non-dominant qty | Occupancy |
|---|---|---|---:|---:|---:|---:|---:|
| 279 | MZE1, MZE3 | Permen | 16 | 40,723 | 27.24% | 29,631 | 29.13% |
| 197 | HRA3, SRB1 | Obat-obatan | 12 | 119,485 | 27.51% | 86,609 | 86.44% |
| 261 | SRC1 | Gas & Air Galon | 6 | 23,548 | 36.84% | 14,874 | 76.27% |
| 180 | MZF3 | Mainan & Hobi | 9 | 16,927 | 41.48% | 9,906 | 41.76% |
| 238 | SRC1 | Astro Kitchen - Packaging Outer | 5 | 41,747 | 42.36% | 24,062 | 78.57% |
| 192 | SRC1 | Perawatan Mulut | 11 | 34,930 | 46.46% | 18,702 | 83.93% |
| 482 | SRC1 | Kebersihan Badan | 6 | 12,396 | 46.72% | 6,604 | 92.59% |
| 184 | MZF3, SRC1 | Kebersihan Wajah | 9 | 19,276 | 50.29% | 9,583 | 39.18% |
| 181 | MZF3, SRC1 | Perawatan Rumah | 7 | 39,480 | 53.44% | 18,381 | 19.14% |
| 240 | MZC3, SRB1 | Tepung & Bahan Kue | 5 | 41,038 | 58.88% | 16,874 | 7.19% |

These are purity findings, not confirmed placement errors.

## 8. Example mixed rack cells

Among normal PICKFACE/STORAGE locations, the largest observed L1 minority quantities include:

| Rack | Area | Type | Total qty | L1 categories | Purity | Minority qty |
|---|---:|---|---:|---:|---:|---:|
| CBT-SRB1-02-08-L2-01 | 240 | STORAGE | 2,080 | 2 | 76.92% | 480 |
| CBT-SRB1-02-09-L3-01 | 240 | STORAGE | 3,560 | 2 | 86.52% | 480 |
| CBT-SRB1-01-13-L1-01 | 230 | PICKFACE | 1,894 | 2 | 78.41% | 409 |
| CBT-SRA1-06-02-L2-02 | 188 | STORAGE | 853 | 2 | 53.58% | 396 |
| CBT-SRA1-11-16-L5-02 | 237 | STORAGE | 2,571 | 2 | 86.81% | 339 |
| CBT-SRC1-11-13-L2-01 | 482 | STORAGE | 758 | 3 | 60.29% | 301 |

## 9. Recommended dashboard

### Summary

- L1 placement accuracy, after target mapping exists.
- L2 placement accuracy, after the L2 design exists.
- Misplaced quantity and misplaced COGS value.
- Non-compliant SLOC count.
- Empty versus occupied rack capacity.
- Ranking by `area_id`, zone, floor, and storage role.

### Area drill-down

- Expected versus actual L1/L2 distribution.
- Dominant and minority categories.
- Occupancy, misplaced quantity, mixed-rack count, and category count.
- Aisle/bay heatmap colored by compliance.

### Physical rack detail

- Render all master rack cells, including empty cells.
- Empty: neutral.
- Correct category: green.
- Wrong L1: red.
- Correct L1 but wrong L2: amber.
- Mixed category: striped or split marker.
- Special/staging/quarantine: separate visual state.
- Click to show SKU, L1, L2, quantity, package, expiry, and target category.

## 10. Target mapping

The temporary L1 target is supplied by `adadada.xlsx`. Its normalized interpretation is documented in `L1_ACCURACY_MAPPING_SPEC.md`.

L2 and SKU targets do not exist yet. Those dimensions remain visibility-only until the future Google Sheet source is available.

### Future maintained target table

Minimum target table:

| Field | Required | Example |
|---|---:|---|
| `mapping_level` | Yes | `AREA`, `AISLE`, or `RACK` |
| `mapping_key` | Yes | `area_id=279` |
| `expected_l1_category` | Yes for current model | `Permen` |
| `expected_l2_category` | Required for L2 project | `Gummy Candy` |
| `effective_from` | Yes | `2026-08-01` |
| `effective_to` | No | null |
| `exception_rule` | No | staging/overflow/temporary |
| `approved_by` | Recommended | operational owner |

Mapping precedence should be:

```text
rack override → aisle override → area target → no target
```

Records without an approved target must be labeled `UNMAPPED`, not inaccurate.

## 11. Priority recommendation

Use a transparent ordered priority rather than an arbitrary composite score:

1. Wrong-L1 quantity.
2. Wrong-L1 COGS value.
3. Wrong-L2 quantity among L1-compliant stock.
4. Number of non-compliant SLOCs.
5. Mixed-rack quantity.

Empty rack capacity should be shown as context for remediation, not counted as category inaccuracy.

## 12. Open decisions

1. Is `area_id` the official category-grouping unit?
2. Is there an existing mapping from `area_id`, aisle, or rack to planned L1?
3. Should reserve/storage and pickface share the same category target?
4. Which storage roles are excluded from accuracy: staging, quarantine, parking, adjustment?
5. Can one area legitimately contain multiple L1 categories?
6. For L2, will each L1 area be subdivided by aisle, bay, or exact rack range?
