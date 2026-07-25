from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


SOURCE_PATH = Path(r"C:\Users\M. Pandu Kurnia\Downloads\20260723_164604.csv")
OUTPUT_PATH = Path(
    r"C:\Users\M. Pandu Kurnia\Documents\INVENTORY CONTROL TOWER"
    r"\public\data\master-rack-index.json"
)

LOCATION_PATTERN = re.compile(
    r"^(?P<warehouse>[^-]+)-"
    r"(?P<zone>[A-Z]+[0-9]+)-"
    r"(?P<rack_sequence>[^-]+)-"
    r"(?P<aisle>[^-]+)-"
    r"(?P<level>L[^-]+)-"
    r"(?P<position>[^-]+)$",
    re.IGNORECASE,
)


def clean(value: object) -> str:
    return str(value or "").strip()


class DictionaryEncoder:
    def __init__(self) -> None:
        self.values: list[str | None] = [None]
        self.index: dict[str | None, int] = {None: 0}

    def encode(self, value: object) -> int:
        normalized = clean(value) or None
        if normalized not in self.index:
            self.index[normalized] = len(self.values)
            self.values.append(normalized)
        return self.index[normalized]


def main() -> None:
    if not SOURCE_PATH.exists():
        raise FileNotFoundError(f"Master rack source not found: {SOURCE_PATH}")

    source_sha256 = hashlib.sha256(SOURCE_PATH.read_bytes()).hexdigest()
    dictionaries = {
        "warehouse": DictionaryEncoder(),
        "zone": DictionaryEncoder(),
        "rack_sequence": DictionaryEncoder(),
        "aisle": DictionaryEncoder(),
        "level": DictionaryEncoder(),
        "position": DictionaryEncoder(),
        "remarks_zone": DictionaryEncoder(),
        "picking_area_id": DictionaryEncoder(),
        "area_id": DictionaryEncoder(),
    }

    locations: list[list[object]] = []
    seen: set[str] = set()
    duplicates: list[str] = []
    malformed: list[str] = []
    zone_counts: Counter[str] = Counter()
    remarks_counts: Counter[str] = Counter()

    with SOURCE_PATH.open("r", encoding="utf-8-sig", newline="") as source_file:
        reader = csv.DictReader(source_file)
        required = {
            "rack_name",
            "REMAKS_ZONE",
            "ZONE",
            "LVL",
            "picking_area_id",
            "area_id",
        }
        missing = sorted(required.difference(reader.fieldnames or []))
        if missing:
            raise ValueError(f"Missing master columns: {', '.join(missing)}")

        for source_row in reader:
            rack_name = clean(source_row["rack_name"])
            if not rack_name:
                malformed.append("<blank>")
                continue
            if rack_name in seen:
                duplicates.append(rack_name)
                continue
            seen.add(rack_name)

            match = LOCATION_PATTERN.match(rack_name)
            parsed = match.groupdict() if match else {}
            if not match:
                malformed.append(rack_name)

            source_zone = clean(source_row["ZONE"])
            zone = clean(parsed.get("zone")) or source_zone
            source_level = clean(source_row["LVL"])
            level = clean(parsed.get("level")) or source_level
            remarks_zone = clean(source_row["REMAKS_ZONE"])

            zone_counts[zone or "<blank>"] += 1
            remarks_counts[remarks_zone or "<blank>"] += 1

            locations.append(
                [
                    rack_name,
                    dictionaries["warehouse"].encode(parsed.get("warehouse")),
                    dictionaries["zone"].encode(zone),
                    dictionaries["rack_sequence"].encode(parsed.get("rack_sequence")),
                    dictionaries["aisle"].encode(parsed.get("aisle")),
                    dictionaries["level"].encode(level),
                    dictionaries["position"].encode(parsed.get("position")),
                    dictionaries["remarks_zone"].encode(remarks_zone),
                    dictionaries["picking_area_id"].encode(source_row["picking_area_id"]),
                    dictionaries["area_id"].encode(source_row["area_id"]),
                ]
            )

    locations.sort(key=lambda row: (row[2], row[4], row[3], row[5], row[6], row[0]))

    payload = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "file": SOURCE_PATH.name,
            "sha256": source_sha256,
        },
        "schema": {
            "location_fields": [
                "rack_name",
                "warehouse_id",
                "zone_id",
                "rack_sequence_id",
                "aisle_id",
                "level_id",
                "position_id",
                "remarks_zone_id",
                "picking_area_id",
                "area_id",
            ],
            "dictionary_zero": None,
        },
        "summary": {
            "location_count": len(locations),
            "duplicate_count": len(duplicates),
            "malformed_count": len(malformed),
            "zone_counts": dict(sorted(zone_counts.items())),
            "remarks_zone_counts": dict(sorted(remarks_counts.items())),
        },
        "dictionaries": {
            name: encoder.values for name, encoder in dictionaries.items()
        },
        "locations": locations,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "output": str(OUTPUT_PATH),
                "location_count": len(locations),
                "duplicate_count": len(duplicates),
                "malformed_count": len(malformed),
                "malformed_examples": malformed[:10],
                "output_bytes": OUTPUT_PATH.stat().st_size,
                "source_sha256": source_sha256,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
