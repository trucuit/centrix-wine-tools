#!/usr/bin/env python3
"""
migrate_monthly_dirs.py

Move files from flat structure into monthly subdirs (YYYY-MM/).

Usage:
    python3 migrate_monthly_dirs.py <data_dir>
"""
import json
import re
import sys
from pathlib import Path


def extract_month(name: str) -> str:
    """Extract YYYY-MM from a filename like 2026-09-22_2100_Title..."""
    m = re.match(r'^(\d{4}-\d{2})', name)
    return m.group(1) if m else "0000-00"


def migrate_dir(dir_path: Path, is_file: bool = True):
    """Move items in dir_path into YYYY-MM/ subdirs."""
    if not dir_path.exists():
        return 0

    moved = 0
    items = sorted(dir_path.iterdir())
    for item in items:
        name = item.name
        # Skip already-in-month-dir items, hidden files, _cid_map.json, index.md
        if name.startswith((".", "_")) or name == "index.md":
            continue
        # Skip if this is already a month directory (YYYY-MM)
        if item.is_dir() and re.match(r'^\d{4}-\d{2}$', name):
            continue

        month = extract_month(name)
        month_dir = dir_path / month
        month_dir.mkdir(exist_ok=True)

        dest = month_dir / name
        if dest.exists():
            continue

        item.rename(dest)
        moved += 1
        if moved % 50 == 0:
            print(f"  📦 Moved {moved}...")

    return moved


def update_cid_map(data_dir: Path):
    """Update _cid_map.json: values stay as friendly basenames (no path change needed).
    The fetch script will add the month prefix when resolving paths."""
    pass  # cid_map stores basenames, not paths — no update needed


def main(data_dir: Path):
    print(f"\n🔄 Migrating to monthly subdirs: {data_dir}\n")

    # 1. conversations/
    conv_dir = data_dir / "conversations"
    n = migrate_dir(conv_dir, is_file=True)
    print(f"✅ conversations/: {n} files moved")

    # 2. assets/
    assets_dir = data_dir / "assets"
    n = migrate_dir(assets_dir, is_file=False)
    print(f"✅ assets/: {n} dirs moved")

    # 3. conversations_md/
    md_dir = data_dir / "conversations_md"
    n = migrate_dir(md_dir, is_file=True)
    print(f"✅ conversations_md/: {n} files moved")

    print(f"\n🎉 Migration to monthly subdirs complete!")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <data_dir>")
        sys.exit(1)

    data_dir = Path(sys.argv[1])
    if not data_dir.exists():
        print(f"❌ Not found: {data_dir}")
        sys.exit(1)

    main(data_dir)
