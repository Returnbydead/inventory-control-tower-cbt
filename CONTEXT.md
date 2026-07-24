# Inventory Control Tower

Domain language for inventory placement, stock fragmentation, and the warehouse location hierarchy used by the control tower.

## Language

**Warehouse**:
A physical fulfillment facility identified by a warehouse code such as `CBT`.
_Avoid_: Location

**Zone**:
A named storage area within a warehouse, such as `MZE`. A zone can span multiple warehouse floors.
_Avoid_: Zone-floor code

**Zone Floor**:
The combination of a zone and warehouse floor encoded as a token such as `MZE1`, meaning zone `MZE` on warehouse floor `1`.
_Avoid_: Zone

**Aisle**:
A numbered passage or rack grouping within a zone floor, represented by the third location token such as `03`.

**Bay**:
A numbered rack section within an aisle, represented provisionally by the fourth location token such as `05`.
_Avoid_: Row, location

**Rack Level**:
The vertical shelf level within a bay, encoded as a token such as `L2`. This is different from the warehouse floor in `MZE1`.
_Avoid_: Floor, product L1

**Position**:
The final subdivision within a rack level, represented provisionally by the last location token such as `05`. The operational name still requires confirmation.
_Avoid_: Location

**Rack Address**:
The complete structured storage address, for example `CBT-MZE1-03-05-L2-05`.
_Avoid_: Rack name

**Product L1 Category**:
The top-level product classification in `l1_category_name`. It is unrelated to rack level `L1`.
_Avoid_: L1

**Cross-zone SKU**:
A SKU with positive SOH in more than one canonical zone at the same snapshot.

**Cross-floor SKU**:
A SKU with positive SOH on more than one warehouse floor at the same snapshot.

**Fragmented SKU**:
A SKU with positive SOH across multiple physical placements at the same snapshot. Fragmentation is descriptive and is not automatically actionable.

**Actionable Fragmentation**:
Fragmentation that violates an approved placement rule or consolidation threshold.

