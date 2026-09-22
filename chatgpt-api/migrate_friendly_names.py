#!/usr/bin/env python3
"""
migrate_friendly_names.py

One-time migration: rename existing conversations/*.json and assets/*/
from bare cid format to friendly date_title_cid8 format.

Usage:
    python3 migrate_friendly_names.py <data_dir>
    # e.g. python3 migrate_friendly_names.py chatgpt-api/data/xuanloc_centrix-asia
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path


def friendly_basename(title: str, create_time, cid: str) -> str:
    safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in (title or "Untitled")).strip()[:35]
    safe_title = re.sub(r"_+", "_", safe_title).strip("_")
    cid_short = cid[:8]
    try:
        if isinstance(create_time, (int, float)) and create_time > 0:
            date_prefix = datetime.fromtimestamp(create_time).strftime("%Y-%m-%d_%H%M")
        elif isinstance(create_time, str) and create_time:
            dt = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
            date_prefix = dt.strftime("%Y-%m-%d_%H%M")
        else:
            date_prefix = "0000-00-00_0000"
    except Exception:
        date_prefix = "0000-00-00_0000"
    return f"{date_prefix}_{safe_title}_{cid_short}"


def is_uuid(name: str) -> bool:
    """Check if name looks like a bare UUID (conversation id)."""
    return bool(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', name))


def migrate(data_dir: Path):
    conv_dir = data_dir / "conversations"
    assets_dir = data_dir / "assets"
    cid_map = {}

    # Load existing cid_map if any
    map_file = data_dir / "_cid_map.json"
    if map_file.exists():
        try:
            cid_map = json.loads(map_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    # Phase 1: Rename conversations/*.json
    renamed_conv = 0
    skipped = 0
    if conv_dir.exists():
        for jf in sorted(conv_dir.glob("*.json")):
            stem = jf.stem
            if not is_uuid(stem):
                skipped += 1
                continue

            cid = stem
            try:
                data = json.loads(jf.read_text(encoding="utf-8"))
                title = data.get("title", "Untitled")
                ct = data.get("create_time", 0)
            except Exception:
                title = "Untitled"
                ct = 0

            friendly = friendly_basename(title, ct, cid)
            cid_map[cid] = friendly

            new_path = conv_dir / f"{friendly}.json"
            if new_path.exists():
                print(f"  ⚠️  Skip (exists): {new_path.name}")
                continue

            jf.rename(new_path)
            renamed_conv += 1
            if renamed_conv % 50 == 0:
                print(f"  📄 Renamed {renamed_conv} conversations...")

    print(f"✅ Conversations: {renamed_conv} renamed, {skipped} already friendly")

    # Phase 2: Rename assets/*/
    renamed_assets = 0
    skipped_assets = 0
    if assets_dir.exists():
        for d in sorted(assets_dir.iterdir()):
            if not d.is_dir():
                continue
            if not is_uuid(d.name):
                skipped_assets += 1
                continue

            cid = d.name
            if cid not in cid_map:
                # Try to get title from conversation file
                conv_file = conv_dir / f"{cid}.json"
                if conv_file.exists():
                    try:
                        data = json.loads(conv_file.read_text(encoding="utf-8"))
                        friendly = friendly_basename(data.get("title", "Untitled"), data.get("create_time", 0), cid)
                        cid_map[cid] = friendly
                    except Exception:
                        cid_map[cid] = friendly_basename("Untitled", 0, cid)
                else:
                    # Check if already renamed conv exists in map
                    cid_map.setdefault(cid, friendly_basename("Untitled", 0, cid))

            friendly = cid_map[cid]
            new_path = assets_dir / friendly

            if new_path.exists():
                skipped_assets += 1
                continue

            d.rename(new_path)
            renamed_assets += 1
            if renamed_assets % 50 == 0:
                print(f"  📁 Renamed {renamed_assets} asset dirs...")

    print(f"✅ Assets: {renamed_assets} renamed, {skipped_assets} already friendly")

    # Save cid_map
    map_file.write_text(json.dumps(cid_map, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"✅ Saved _cid_map.json ({len(cid_map)} entries)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <data_dir>")
        sys.exit(1)

    data_dir = Path(sys.argv[1])
    if not data_dir.exists():
        print(f"❌ Directory not found: {data_dir}")
        sys.exit(1)

    print(f"\n🔄 Migrating {data_dir} to friendly filenames...\n")
    migrate(data_dir)
    print(f"\n🎉 Migration complete!")
