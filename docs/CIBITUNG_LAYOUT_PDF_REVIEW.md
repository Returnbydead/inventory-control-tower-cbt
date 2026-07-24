# WH Cibitung Phase 2 Layout Review

**Source:** `WH Cibitung Layout Plan_Phase 2.pdf`  
**Pages:** 79  
**Review date:** 2026-07-23  
**Purpose:** Assess suitability as the spatial reference for a warehouse rack visualization

## 1. Verdict

The PDF is suitable as the geometric and visual reference for a 2D floor plan and a staged 3D warehouse model. It contains:

- warehouse block plans and operational areas;
- Phase 2 floor layouts;
- SPR left and right rack footprints;
- SPR 5-level, 6-level, and bridge rack dimensions;
- pickface mezzanine modules 1-7;
- perspective drawings for mezzanine racks;
- capacity and dimensional annotations.

The PDF does not directly map operational rack addresses such as `CBT-MZE1-03-05-L2-05` to the drawn rack coordinates. A small address-to-layout mapping table is still required.

## 2. Relevant pages

| Pages | Content | Use in control tower |
|---|---|---|
| 3-5 | Warehouse block plan, Phase 1/2 zoning | Warehouse overview and major-area polygons |
| 6-8 | Floor layouts, including Phase 2 L1 and L2 | Floor selector, footprint, orientation, access areas |
| 24-25 | SPR right footprint and rack types | SPR rack placement and 3D rack template |
| 26-27 | Pickface modules 1-6 and perspective | Mezzanine geometry and repeated module template |
| 38-39 | SPR left footprint and rack types | Phase 2 SPR placement |
| 40-41 | Pickface module 7 and perspective | Module 7 geometry and rack population |

Warehouse flow pages 9-10 can later enrich movement overlays, but they are not required for the first SOH rack map.

## 3. Physical structures identified

### SPR storage

- 6-level SPR.
- 5-level SPR.
- SPR bridge.
- Separate SPR right and SPR left footprints.
- Capacity is expressed in pallet positions and rack units.

### Pickface mezzanine

- Modules 1-6 plus module 7.
- Multiple warehouse/mezzanine floors.
- Repeated rack rows with stairs, VRC lift, spiral conveyor, and forklift bay.
- Rack templates differ between module 7 levels and the earlier modules.

### Operational areas

- inbound and putaway staging;
- outbound modules and packing;
- crossdock;
- RFM/high-value cage;
- quarantine and special-use areas;
- loading gates, office, and support areas.

These operational polygons should exist in the map even when they do not contain normal SOH rack cells.

## 4. Recommended visual model

### Layer 1 - Physical shell

- Simplified warehouse footprint based on pages 5-8.
- Major operational polygons with stable IDs.
- Floor-level visibility controls.

### Layer 2 - Reusable rack templates

- `spr_5_level`
- `spr_6_level`
- `spr_bridge`
- `pickface_standard`
- `pickface_module_7`
- `staging_cell`
- `special_area`

Each template is instantiated many times instead of modeling every rack manually.

### Layer 3 - Address binding

Bind every normalized rack address to:

```text
layout_area_id
module_id
floor
aisle
bay
rack_level
position
side
```

### Layer 4 - SOH overlay

Color and interaction are driven by the latest SOH snapshot:

- occupancy;
- quantity;
- distinct SKU count;
- fragmented SKU;
- stock value;
- expiry;
- source freshness.

## 5. Required mapping bridge

The smallest useful mapping table is:

| Field | Example |
|---|---|
| `zone_floor_code` | `MZE1` |
| `layout_area_id` | `PF_MODULE_3_F1` |
| `aisle_start` / `aisle_end` | `01` / `17` |
| `drawing_direction` | north-to-south |
| `side_rule` | odd-left/even-right, if applicable |
| `layout_x` / `layout_y` | anchor coordinate |
| `rotation_deg` | rack-row orientation |
| `rack_template` | `pickface_standard` |

Once this bridge is available, the system can generate most rack cells from address ranges rather than manually positioning tens of thousands of locations.

## 6. MVP recommendation

1. Digitize only the major polygons from pages 5-8.
2. Select one pilot zone, preferably MZE across floors 1-3.
3. Map its aisle ranges to one pickface module.
4. Generate rack cells from the address parser.
5. Overlay the SOH sample and validate positions with an operator.
6. Add 3D extrusion after the 2D address binding is proven.

The 3D version should reuse the same normalized location model and coordinates as the 2D map. It must not become a separate manually maintained dataset.

## 7. Open questions

1. Which pickface module on the PDF corresponds to MZE?
2. Do MZA-MZF map one-to-one to pickface modules 1-6?
3. Do HRA/HRB and SRA/SRB/SRC correspond to high-rack and SPR areas?
4. How are odd/even aisle or rack sides encoded?
5. What is the operational name and direction of the final address token?
6. Is there a CAD/DWG, editable PowerPoint, or Excel location master behind this PDF?

