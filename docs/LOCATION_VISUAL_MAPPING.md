# Warehouse Location Visual Mapping

**Version:** 0.1  
**Status:** Phase 2 PDF received; address-to-drawing bridge still required

## Layout reference received

`WH Cibitung Layout Plan_Phase 2.pdf` provides the warehouse footprint, Phase 2 floor layouts, SPR left/right footprints, SPR rack types, and pickface mezzanine modules 1-7. It is sufficient to seed the physical shell and reusable rack templates.

The PDF does not directly label operational address codes such as `MZE1`. The remaining gap is a small mapping from zone-floor/aisle ranges to modules and coordinates on the drawing.

## 1. Confirmed address structure

Example:

```text
CBT-MZE1-03-05-L2-05
```

| Token | Confirmed meaning | Parsed value |
|---|---|---|
| `CBT` | Warehouse code | `CBT` |
| `MZE1` | Zone `MZE`, warehouse floor `1` | zone=`MZE`, floor=`1` |
| `03` | Aisle | `03` |
| `05` | Rack row/bay | `05` |
| `L2` | Vertical rack level | `2` |
| final `05` | Pending confirmation; provisional position/slot | `05` |

The parser must preserve the original `rack_name` and also create normalized fields. It must not confuse warehouse floor `1` in `MZE1` with rack level `L2`.

## 2. Visuals we can build

### A. Warehouse zone overview

- Floor selector: floor 1, floor 2, floor 3.
- Zone cards or floor-plan polygons for MZA, MZB, MZC, MZD, MZE, MZF, HR, SR, and special areas.
- Color by total SOH, active SKU count, fragmented SKU count, value, or exception severity.
- Clicking a zone opens its aisle view.

Without coordinates, this can be a logical ordered map. With physical X/Y coordinates or a warehouse layout image, it can match the real floor plan.

### B. Zone and aisle heatmap

- Columns represent aisle and bay.
- Rows represent rack level.
- Each cell represents a rack position.
- Cell color can represent occupied quantity, number of SKU, COGS value, expiry risk, or fragmentation.
- Hover/click reveals SKU, package label, SOH, expiry, and updated time.

### C. SKU placement map

- Search one SKU.
- Highlight every rack cell containing the SKU.
- Show zone, floor, aisle, bay, rack level, and position.
- Mark the dominant placement and non-dominant placements.
- Suggest candidate consolidation only after warehouse rules are validated.

### D. Fragmentation map

- Rank SKU by number of zones, floors, aisles, bays, and rack cells.
- Separate cross-zone, cross-floor, cross-aisle, and within-bay fragmentation.
- Allow drill-down from warehouse to zone floor to rack cell.

## 3. Normalized location fields

| Field | Example | Required for |
|---|---|---|
| `warehouse_code` | `CBT` | Warehouse filter |
| `zone_code` | `MZE` | True cross-zone analysis |
| `warehouse_floor` | `1` | Floor selector |
| `zone_floor_code` | `MZE1` | Zone-floor display |
| `aisle_no` | `03` | Aisle map |
| `bay_no` | `05` | Horizontal rack section |
| `rack_level_no` | `2` | Vertical heatmap axis |
| `position_no` | `05` | Final cell subdivision; name pending |
| `rack_address` | full original string | Traceability |
| `storage_role` | pick/reserve/staging/quarantine | Actionable rules |
| `layout_x`, `layout_y` | numeric coordinates | Real floor-plan placement |
| `display_order` | integer | Stable logical map |
| `capacity_qty` or `capacity_volume` | numeric | Capacity/occupancy analysis |
| `is_active` | boolean | Exclude retired locations |

## 4. Parser rules

For standard addresses:

```text
warehouse_code = token 1
zone_floor_code = token 2
zone_code = alphabetic portion of token 2
warehouse_floor = trailing numeric portion of token 2
aisle_no = token 3
bay_no = token 4
rack_level_no = numeric portion of token 5
position_no = token 6
```

Non-standard addresses such as consumable, staging, quarantine, or adjustment locations must use an explicit location master mapping and must not be silently forced into the standard pattern.

## 5. What the SOH file already enables

The current sample already enables a logical rack visual because it contains:

- complete `rack_name`;
- SKU and product name;
- SOH quantity;
- expiry;
- package label;
- COGS;
- record update time.

It does not establish real-world adjacency, aisle direction, left/right rack side, geometry, or capacity. Therefore it can produce a logical heatmap immediately, but a faithful floor-plan map requires a small location-master dataset.

## 6. Location master needed for a physical map

One row per rack address or map cell:

```text
rack_address
warehouse_code
zone_code
warehouse_floor
aisle_no
bay_no
rack_level_no
position_no
storage_role
side
layout_x
layout_y
display_order
capacity
is_active
```

If an existing warehouse map is available as an image, PDF, Excel, or PowerPoint, it can be used to seed `layout_x`, `layout_y`, zone boundaries, and display order.

## 7. Recommended MVP

Start with the logical map because it can be generated from the current SOH data:

1. Floor selector.
2. Zone summary cards.
3. Aisle × bay heatmap.
4. Rack-level drill-down.
5. SKU search and placement highlighting.

Add the true floor-plan map after location coordinates or a warehouse layout reference is available.
