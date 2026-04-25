#!/usr/bin/env python3
"""
Boston Street Names Game - Data Pipeline
Fetches street data from OpenStreetMap via Overpass API,
filters and processes it into per-section GeoJSON files.

Usage:
    python fetch.py           # fetch + process all sections
    python fetch.py --fresh   # ignore cached raw data and re-fetch
"""

import argparse
import json
import re
import time
import requests
from pathlib import Path
from collections import Counter

SECTIONS = {
    "boston":    2315704,
    "cambridge": 1933745,
    "brookline": 2306361,
    "somerville": 1933746,
}

INCLUDE_HIGHWAY = "|".join([
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "residential",
    "unclassified",
    "living_street",
])

# Boston proper has a lot of tiny alleys and service roads — stricter filter
MIN_SEGMENTS = {
    "boston":    3,
    "cambridge": 2,
    "brookline": 2,
    "somerville": 2,
}

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
RAW_DIR  = Path("data/raw")
OUT_DIR  = Path("../data")

SECTION_NAME_TO_ID = {
    "Boston":    "boston",
    "Cambridge": "cambridge",
    "Brookline": "brookline",
    "Somerville": "somerville",
}

BOUNDARIES_URL = (
    "https://raw.githubusercontent.com/codeforgermany/click_that_hood"
    "/main/public/data/boston.geojson"
)

# Fallback: build boundaries from individual Nominatim lookups if the above
# doesn't have the right sections. We'll detect this at runtime.
NOMINATIM_IDS = {
    "boston":    "R2315704",
    "cambridge": "R1933745",
    "brookline": "R2306361",
    "somerville": "R1933746",
}


def fetch_boundaries() -> None:
    out_path = OUT_DIR / "sections.geojson"
    if out_path.exists():
        print("  boundaries: using cached sections.geojson")
        return

    print("  boundaries: fetching from Nominatim...")
    features = []
    for i, (section_id, osm_id) in enumerate(NOMINATIM_IDS.items()):
        url = f"https://nominatim.openstreetmap.org/lookup?osm_ids={osm_id}&format=json&polygon_geojson=1"
        resp = requests.get(url, headers={"User-Agent": "boston-street-names-game/1.0"}, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            print(f"  WARNING: no data for {section_id}")
            continue
        item = data[0]
        feature = {
            "type": "Feature",
            "id": i,
            "properties": {
                "name": SECTION_NAME_TO_ID.get(item.get("name", ""), section_id),
                "section_id": section_id,
                "borough_id": section_id,   # shared key with NYC frontend
            },
            "geometry": item["geojson"],
        }
        features.append(feature)
        print(f"  boundaries: fetched {section_id}")
        time.sleep(1)

    out = {"type": "FeatureCollection", "features": features}
    out_path.write_text(json.dumps(out))
    print(f"  boundaries: saved {len(features)} section polygons")


def build_query(relation_id: int) -> str:
    area_id = 3600000000 + relation_id
    return f"""
[out:json][timeout:180];
area(id:{area_id})->.b;
way["highway"~"^({INCLUDE_HIGHWAY})$"]
   ["name"]
   ["bridge"!~"yes"]
   ["tunnel"!~"yes"]
   (area.b);
out geom;
"""


def fetch_section(name: str, relation_id: int, fresh: bool = False) -> dict:
    raw_path = RAW_DIR / f"{name}.json"
    if raw_path.exists() and not fresh:
        print(f"  {name}: using cached raw data ({raw_path.stat().st_size // 1024}KB)")
        return json.loads(raw_path.read_text())

    print(f"  {name}: querying Overpass API...")
    resp = requests.post(
        OVERPASS_URL,
        data={"data": build_query(relation_id)},
        headers={"User-Agent": "boston-street-names-game/1.0"},
        timeout=200,
    )
    resp.raise_for_status()
    data = resp.json()
    raw_path.write_text(json.dumps(data))
    print(f"  {name}: fetched {len(data['elements'])} ways")
    return data


_DIRECTIONAL_STREET = re.compile(
    r"^(?:East|West)\s+(\d+\w*\s+(?:Street|Avenue|Drive|Place|Road|Boulevard|Lane|Court|Way|Terrace))$",
    re.IGNORECASE,
)

_EXCLUDE_SUFFIXES = (" Bridge", " Tunnel", " Viaduct", " Mall", " Overpass", " Underpass")
_EXCLUDE_PATTERNS = re.compile(
    r"("
    r"\b(Loop Road|Tunnel Approach|Tunnel Exit)\b|"
    r"\b(Street|Avenue|Ave)\s+Loop$|"
    r"\bRoundabout\b|"
    r"\b(State Route|State Highway|Route)\s+\d|"
    r"\bTerminal\b.*(Loop|Lane|Road)|"
    r"\bReservation$"
    r")",
    re.IGNORECASE,
)


def normalize_name(name: str) -> str | None:
    if "/" in name:
        return None
    for suffix in _EXCLUDE_SUFFIXES:
        if name.endswith(suffix):
            return None
    if _EXCLUDE_PATTERNS.search(name):
        return None
    m = _DIRECTIONAL_STREET.match(name)
    if m:
        return m.group(1)
    return name


def process_section(name: str, raw: dict, min_segments: int = 2) -> tuple[dict, list[str]]:
    features = []
    for way in raw.get("elements", []):
        if way.get("type") != "way":
            continue
        tags = way.get("tags", {})
        raw_name = tags.get("name", "").strip()
        if not raw_name:
            continue
        raw_name = re.sub(r"\s*\(.*?\)\s*$", "", raw_name).strip()
        street_name = normalize_name(raw_name)
        if not street_name:
            continue
        coords = [[n["lon"], n["lat"]] for n in way.get("geometry", [])]
        if len(coords) < 2:
            continue
        features.append({
            "type": "Feature",
            "properties": {"name": street_name, "highway": tags.get("highway")},
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    if min_segments > 1:
        seg_counts = Counter(f["properties"]["name"] for f in features)
        features = [f for f in features if seg_counts[f["properties"]["name"]] >= min_segments]

    seen_names = {f["properties"]["name"] for f in features}
    geojson = {"type": "FeatureCollection", "features": features}
    names = sorted(seen_names, key=str.lower)
    return geojson, names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fresh", action="store_true")
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("\n── boundaries ──")
    fetch_boundaries()

    summary = {}
    for section_name, relation_id in SECTIONS.items():
        print(f"\n── {section_name} ──")
        raw = fetch_section(section_name, relation_id, fresh=args.fresh)
        geojson, names = process_section(section_name, raw, min_segments=MIN_SEGMENTS[section_name])
        print(f"  {len(names)} unique street names across {len(geojson['features'])} segments")

        (OUT_DIR / f"{section_name}.geojson").write_text(json.dumps(geojson))
        (OUT_DIR / f"{section_name}_names.json").write_text(json.dumps(names, indent=2))
        summary[section_name] = {"street_count": len(names), "segment_count": len(geojson["features"])}
        time.sleep(2)

    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2))

    print("\n── Summary ──")
    total = 0
    for section, stats in summary.items():
        print(f"  {section:12s} {stats['street_count']:>4} streets  ({stats['segment_count']} segments)")
        total += stats["street_count"]
    print(f"  {'TOTAL':12s} {total:>4} streets")
    print(f"\nOutput written to {OUT_DIR}/")


if __name__ == "__main__":
    main()
