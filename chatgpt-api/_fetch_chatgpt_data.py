#!/usr/bin/env python3
"""
_fetch_chatgpt_data.py

Gọi 3 API ChatGPT chính khi mở app, sử dụng curl_cffi để bypass Cloudflare.

Usage:
    python3 _fetch_chatgpt_data.py <auth_file.json> <output_dir>
"""
import json
import sys
import os
import re
import base64
import time
import math
import subprocess
from datetime import datetime, timezone
from pathlib import Path

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print("❌ Cần cài đặt curl_cffi: pip3 install --break-system-packages curl_cffi")
    sys.exit(1)

# ── Colors ──────────────────────────────────────────────────────────────────
C = "\033[36m"   # cyan
G = "\033[32m"   # green
Y = "\033[33m"   # yellow
R = "\033[31m"   # red
B = "\033[1m"    # bold
D = "\033[2m"    # dim
X = "\033[0m"    # reset

BASE_URL = "https://chatgpt.com"
BROWSER = "chrome"  # TLS fingerprint


def log_step(msg):  print(f"\n{B}{C}── {msg} ──{X}")
def log_info(msg):  print(f"{C}ℹ️  {msg}{X}")
def log_ok(msg):    print(f"{G}✅ {msg}{X}")
def log_warn(msg):  print(f"{Y}⚠️  {msg}{X}")
def log_error(msg): print(f"{R}❌ {msg}{X}", file=sys.stderr)


def jwt_decode(token: str) -> dict:
    """Decode JWT payload (no verification)."""
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload_b64 = parts[1] + "=" * (4 - len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return {}


def jwt_metadata(token: str) -> dict:
    """Extract useful metadata from JWT."""
    payload = jwt_decode(token)
    profile = payload.get("https://api.openai.com/profile", {})
    auth = payload.get("https://api.openai.com/auth", {})
    exp = payload.get("exp", 0)
    remaining = max(0, exp - time.time())
    return {
        "email": profile.get("email", ""),
        "name": profile.get("name", ""),
        "plan": auth.get("chatgpt_plan_type", ""),
        "account_id": auth.get("chatgpt_account_id", ""),
        "user_id": auth.get("chatgpt_user_id", ""),
        "org_id": auth.get("poid", ""),
        "exp": exp,
        "remaining_seconds": int(remaining),
        "remaining_hours": round(remaining / 3600, 1),
    }


def make_session() -> cffi_requests.Session:
    """Create a session with Chrome TLS fingerprint."""
    s = cffi_requests.Session(impersonate=BROWSER)
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/144.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": f"{BASE_URL}/",
        "Origin": BASE_URL,
    })
    return s


def api_link_session(session: cffi_requests.Session, token: str, expires_in: int) -> dict:
    """API 1: POST /api/auth/link-session"""
    url = f"{BASE_URL}/api/auth/link-session"
    payload = {"auth_token": token, "expires_in": expires_in}

    resp = session.post(url, json=payload, headers={
        "Content-Type": "application/json",
        "x-i-am-a-browser": "true",
    })

    # curl_cffi cookies: iterate as dict
    try:
        cookies = dict(session.cookies)
    except Exception:
        cookies = {}
        for k in session.cookies:
            cookies[k] = session.cookies[k]

    return {
        "status": resp.status_code,
        "body": resp.text[:200],
        "cookies": cookies,
        "cookie_names": list(cookies.keys()),
        "cookie_count": len(cookies),
    }


def api_conversations(session: cffi_requests.Session, token: str, account_id: str,
                       limit: int = 100) -> dict:
    """API 2: GET /backend-api/conversations (with pagination)"""
    url = f"{BASE_URL}/backend-api/conversations"
    all_items = []
    offset = 0

    while True:
        params = {"offset": str(offset), "limit": str(min(limit, 100)), "order": "updated"}
        resp = session.get(url, params=params, headers={
            "Authorization": f"Bearer {token}",
            "ChatGPT-Account-Id": account_id,
        })

        if resp.status_code != 200:
            return {"status": resp.status_code, "body": resp.text[:500]}

        try:
            data = resp.json()
            items = data.get("items", [])
            reported_total = data.get("total", 0)
            all_items.extend(items)

            print(f"  📑 Phân trang: offset={offset:4d}, nhận {len(items):3d} items (tổng: {len(all_items)})")

            if not items or len(items) < min(limit, 100):
                break
            offset += len(items)
            time.sleep(0.2)
        except Exception:
            return {"status": resp.status_code, "body": resp.text[:500]}

    return {
        "status": 200,
        "data": {"items": all_items, "total": len(all_items)},
        "total": len(all_items),
        "items_count": len(all_items),
    }


def api_accounts_check(session: cffi_requests.Session, token: str, account_id: str) -> dict:
    """API 3: GET /backend-api/accounts/check"""
    url = f"{BASE_URL}/backend-api/accounts/check/v4-2023-04-27"

    resp = session.get(url, headers={
        "Authorization": f"Bearer {token}",
        "ChatGPT-Account-Id": account_id,
    })

    result = {"status": resp.status_code}
    if resp.status_code == 200:
        try:
            result["data"] = resp.json()
        except Exception:
            result["body"] = resp.text[:500]
    else:
        result["body"] = resp.text[:500]
    return result


RATE_LIMIT_DELAYS = [60, 120, 300, 600]


def api_conversation_detail(session: cffi_requests.Session, token: str,
                            account_id: str, conversation_id: str,
                            max_retries: int = 5) -> dict:
    """API 4: GET /backend-api/conversation/{id} — full conversation detail (with 429 backoff)."""
    url = f"{BASE_URL}/backend-api/conversation/{conversation_id}"
    headers = {
        "Authorization": f"Bearer {token}",
        "ChatGPT-Account-Id": account_id,
    }
    for attempt in range(max_retries):
        try:
            resp = session.get(url, headers=headers, timeout=20)
        except Exception as e:
            time.sleep(2)
            continue

        if resp.status_code == 200:
            try:
                return {"status": 200, "conversation_id": conversation_id, "data": resp.json()}
            except Exception:
                return {"status": 200, "conversation_id": conversation_id, "body": resp.text[:500]}
        elif resp.status_code == 429:
            retry_after = resp.headers.get("retry-after")
            wait_time = int(retry_after) if retry_after and retry_after.isdigit() else RATE_LIMIT_DELAYS[min(attempt, len(RATE_LIMIT_DELAYS) - 1)]
            log_warn(f"Rate limited (429). Chờ {wait_time}s hồi phục trước khi thử lại ({attempt+1}/{max_retries})...")
            time.sleep(wait_time)
        else:
            time.sleep(1)

    return {"status": getattr(resp, "status_code", 500), "conversation_id": conversation_id, "body": getattr(resp, "text", "")[:500]}


def api_file_download_url(session: cffi_requests.Session, token: str,
                          account_id: str, file_id: str,
                          max_retries: int = 4) -> dict | None:
    """Get download URL for a file/image asset (with 429 backoff)."""
    url = f"{BASE_URL}/backend-api/files/{file_id}/download"
    headers = {
        "Authorization": f"Bearer {token}",
        "ChatGPT-Account-Id": account_id,
    }
    for attempt in range(max_retries):
        try:
            resp = session.get(url, headers=headers, timeout=20)
        except Exception:
            time.sleep(2)
            continue

        if resp.status_code == 200:
            try:
                return resp.json()
            except Exception:
                return None
        elif resp.status_code == 429:
            wait_time = RATE_LIMIT_DELAYS[min(attempt, len(RATE_LIMIT_DELAYS) - 1)]
            log_warn(f"Asset rate limited (429). Chờ {wait_time}s hồi phục ({attempt+1}/{max_retries})...")
            time.sleep(wait_time)
        else:
            break
    return None


def download_file(session: cffi_requests.Session, url: str, dest: Path) -> bool:
    """Download a file from URL to local path."""
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code == 200:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(resp.content)
            return True
    except Exception:
        pass
    return False


def extract_assets_from_detail(detail: dict) -> list[dict]:
    """Extract all file/image references from a conversation detail."""
    assets = []
    seen_ids = set()

    for _mid, node in detail.get("mapping", {}).items():
        msg = node.get("message")
        if not msg:
            continue

        # Check content parts for image_asset_pointer
        content = msg.get("content", {})
        for part in content.get("parts", []):
            if isinstance(part, dict):
                ct = part.get("content_type", "")
                pointer = part.get("asset_pointer", "")
                if ct == "image_asset_pointer" and pointer:
                    # sediment://file_xxxx
                    file_id = pointer.replace("sediment://", "")
                    if file_id and file_id not in seen_ids:
                        seen_ids.add(file_id)
                        assets.append({
                            "type": "image",
                            "file_id": file_id,
                            "content_type": ct,
                            "mime_type": part.get("mime_type", "image/png"),
                            "width": part.get("width"),
                            "height": part.get("height"),
                            "size_bytes": part.get("size_bytes"),
                        })
                elif ct == "multimodal_text":
                    # DALL-E generated images
                    for sub in part.get("parts", []):
                        if isinstance(sub, dict) and sub.get("asset_pointer"):
                            fid = sub["asset_pointer"].replace("sediment://", "")
                            if fid and fid not in seen_ids:
                                seen_ids.add(fid)
                                assets.append({
                                    "type": "generated_image",
                                    "file_id": fid,
                                    "content_type": sub.get("content_type", "image"),
                                    "mime_type": sub.get("mime_type", "image/png"),
                                    "width": sub.get("width"),
                                    "height": sub.get("height"),
                                    "size_bytes": sub.get("size_bytes"),
                                })

        # Check metadata attachments
        meta = msg.get("metadata", {})
        for att in meta.get("attachments", []):
            file_id = att.get("id", "")
            if file_id and file_id not in seen_ids:
                seen_ids.add(file_id)
                assets.append({
                    "type": "attachment",
                    "file_id": file_id,
                    "name": att.get("name", ""),
                    "mime_type": att.get("mime_type", ""),
                    "size": att.get("size"),
                })

        # Check DALL-E metadata
        dalle_meta = meta.get("dalle", {})
        if isinstance(dalle_meta, dict):
            gen_id = dalle_meta.get("gen_id", "")
            file_id = dalle_meta.get("file_id", "")
            if file_id and file_id not in seen_ids:
                seen_ids.add(file_id)
                assets.append({
                    "type": "dalle_generated",
                    "file_id": file_id,
                    "gen_id": gen_id,
                    "prompt": dalle_meta.get("prompt", "")[:100],
                })

    return assets


def _friendly_basename(title: str, create_time, cid: str) -> str:
    """Generate friendly basename: 2026-09-22_2218_Title_cid8.
    Same naming convention as conversations_md."""
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


def _load_cid_map(out_dir: Path) -> dict:
    """Load cid → friendly_basename map."""
    map_file = out_dir / "_cid_map.json"
    if map_file.exists():
        try:
            return json.loads(map_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_cid_map(out_dir: Path, cid_map: dict):
    """Save cid → friendly_basename map."""
    map_file = out_dir / "_cid_map.json"
    map_file.write_text(json.dumps(cid_map, indent=2, ensure_ascii=False), encoding="utf-8")


def _day_prefix(friendly: str) -> str:
    """Extract YYYY-MM-DD from friendly basename like 2026-09-22_2100_Title_cid8."""
    m = re.match(r'^(\d{4}-\d{2}-\d{2})', friendly)
    return m.group(1) if m else "0000-00-00"


def _resolve_conv_file(conv_dir: Path, cid: str, cid_map: dict) -> Path:
    """Resolve conversation file path: try monthly/friendly, flat/friendly, flat/cid."""
    if cid in cid_map:
        friendly = cid_map[cid]
        month = _day_prefix(friendly)
        # Monthly subdir (new format)
        monthly = conv_dir / month / f"{friendly}.json"
        if monthly.exists():
            return monthly
        # Flat friendly (old format)
        flat = conv_dir / f"{friendly}.json"
        if flat.exists():
            return flat
    # Legacy: bare cid
    legacy = conv_dir / f"{cid}.json"
    if legacy.exists():
        return legacy
    return None


def _resolve_assets_dir(assets_dir: Path, cid: str, cid_map: dict) -> Path:
    """Resolve assets subdirectory: try monthly/friendly, flat/friendly, flat/cid."""
    if cid in cid_map:
        friendly = cid_map[cid]
        month = _day_prefix(friendly)
        monthly = assets_dir / month / friendly
        if monthly.exists():
            return monthly
        flat = assets_dir / friendly
        if flat.exists():
            return flat
    legacy = assets_dir / cid
    if legacy.exists():
        return legacy
    return None


def fetch_conversation_details(
    session: cffi_requests.Session, token: str, account_id: str,
    conversations: list[dict], out_dir: Path,
) -> dict:
    """Fetch detail for all conversations (Phase 1) then download assets (Phase 2)."""
    conv_dir = out_dir / "conversations"
    conv_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = out_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    # Load cid → friendly name map
    cid_map = _load_cid_map(out_dir)

    stats = {"total": len(conversations), "ok": 0, "fail": 0,
             "assets_found": 0, "assets_downloaded": 0, "skipped": 0}

    # ── Phase 1: Fetch all conversation detail JSONs ──────────────────────
    base_delay = float(os.environ.get("FETCH_DELAY", "55.0"))
    current_delay = base_delay
    consecutive_ok = 0

    print(f"\n{B}── Pha 1: Tải chi tiết {len(conversations)} cuộc hội thoại (JSON) ──{X}")
    print(f"{D}   Pacing: {current_delay:.1f}s/req (chống 429 triệt để theo chu kỳ hồi phục token){X}")

    pending_assets_manifests = []

    for i, conv in enumerate(conversations):
        cid = conv.get("id", "")
        title = (conv.get("title") or "Untitled")[:40]
        ct = conv.get("create_time", "")
        idx = f"[{i+1}/{len(conversations)}]"

        # Generate friendly basename and register in map
        friendly = _friendly_basename(title, ct, cid)
        cid_map[cid] = friendly
        day = _day_prefix(friendly)
        conv_day_dir = conv_dir / day
        conv_day_dir.mkdir(parents=True, exist_ok=True)
        detail_file = conv_day_dir / f"{friendly}.json"

        # Check if already downloaded (monthly, flat, or legacy cid name)
        existing = _resolve_conv_file(conv_dir, cid, cid_map)
        if existing and existing != detail_file:
            # Move legacy/flat file to monthly subdir
            existing.rename(detail_file)
        if detail_file.exists() and detail_file.stat().st_size > 100:
            try:
                detail = json.loads(detail_file.read_text(encoding="utf-8"))
                msg_count = len(detail.get("mapping", {}))
                stats["ok"] += 1
                stats["skipped"] += 1
                if (i + 1) % 25 == 0 or (i + 1) == len(conversations):
                    print(f"  {G}⚡{X} {idx} {title} (đã có - {msg_count} msgs)")
                continue
            except Exception:
                pass

        # Fetch detail with 429 backoff
        r = api_conversation_detail(session, token, account_id, cid)

        if r["status"] != 200:
            print(f"  {R}✗{X} {idx} {title} — HTTP {r['status']}")
            stats["fail"] += 1
            time.sleep(2.0)
            continue

        detail = r.get("data", {})
        msg_count = len(detail.get("mapping", {}))

        # Save detail JSON into monthly subdir
        detail_file.write_text(json.dumps(detail, indent=2, ensure_ascii=False), encoding="utf-8")

        # Extract assets & save manifest (delay actual file download to Phase 2)
        assets = extract_assets_from_detail(detail)
        stats["assets_found"] += len(assets)
        stats["ok"] += 1

        # Assets dir also uses monthly subdir
        asset_day_dir = assets_dir / day
        asset_day_dir.mkdir(parents=True, exist_ok=True)
        asset_subdir = asset_day_dir / friendly
        # Move legacy asset dir if exists
        legacy_asset_dir = _resolve_assets_dir(assets_dir, cid, cid_map)
        if legacy_asset_dir and legacy_asset_dir != asset_subdir:
            legacy_asset_dir.rename(asset_subdir)

        if assets:
            asset_subdir.mkdir(parents=True, exist_ok=True)
            manifest = asset_subdir / "_manifest.json"
            manifest.write_text(json.dumps(assets, indent=2, ensure_ascii=False), encoding="utf-8")
            pending_assets_manifests.append((cid, manifest))

        asset_info = f", {len(assets)} assets detected" if assets else ""
        print(f"  {G}✓{X} {idx} {title} — {msg_count} msgs{asset_info}")

        # Safe delay between conversation details to let Token Bucket refill
        print(f"  {D}⏳ Chờ {current_delay:.0f}s hồi phục token trước hội thoại tiếp theo...{X}")
        time.sleep(current_delay)

    # Save cid_map after Phase 1
    _save_cid_map(out_dir, cid_map)

    # ── Phase 2: Download pending assets (images, attachments) ───────────
    print(f"\n{B}── Pha 2: Tải các file đính kèm & hình ảnh (Assets) ──{X}")
    # Collect manifests ONLY from conversations processed in this run (Phase 1)
    filtered_friendly_names = {cid_map.get(conv.get("id", ""), "") for conv in conversations}
    manifest_files = []
    for day_dir in assets_dir.iterdir():
        if day_dir.is_dir() and re.match(r'^\d{4}-\d{2}-\d{2}$', day_dir.name):
            for cid_dir in day_dir.iterdir():
                if cid_dir.is_dir() and cid_dir.name in filtered_friendly_names:
                    m = cid_dir / "_manifest.json"
                    if m.exists():
                        manifest_files.append(m)
    # Also add any new manifests from Phase 1
    for cid, m_path in pending_assets_manifests:
        if m_path.exists() and m_path not in manifest_files:
            manifest_files.append(m_path)

    total_assets_to_check = 0
    missing_assets = []

    ext_map = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
        "image/webp": ".webp", "application/pdf": ".pdf",
        "text/plain": ".txt", "text/csv": ".csv",
    }

    for m_path in manifest_files:
        try:
            m_data = json.loads(m_path.read_text(encoding="utf-8"))
            cid = m_path.parent.name
            for item in m_data:
                total_assets_to_check += 1
                fid = item.get("file_id", "")
                if not fid:
                    continue
                file_name = item.get("name") or fid
                mime = item.get("mime_type", "")
                # Default extension for images without mime
                if "." not in file_name:
                    if mime in ext_map:
                        file_name += ext_map[mime]
                    elif item.get("type") in ("image", "generated_image", "dalle_generated"):
                        file_name += ".png"  # safe default
                dest = assets_dir / cid / file_name
                # Rename extensionless legacy file if it exists
                bare_file = assets_dir / cid / fid
                if bare_file.exists() and bare_file != dest and not dest.exists():
                    bare_file.rename(dest)
                if not dest.exists() or dest.stat().st_size == 0:
                    missing_assets.append((cid, item, m_path, dest))
                else:
                    stats["assets_downloaded"] += 1
        except Exception:
            pass

    if missing_assets:
        print(f"ℹ️  Phát hiện {len(missing_assets)} assets cần tải (đã có {stats['assets_downloaded']}/{total_assets_to_check})...")
        print(f"{D}   Pacing: 2.0s/asset để giữ an toàn tuyệt đối{X}")
        for j, (cid, item, m_path, dest) in enumerate(missing_assets):
            fid = item.get("file_id", "")
            dl_info = api_file_download_url(session, token, account_id, fid)
            if dl_info:
                dl_url = dl_info.get("download_url", "")
                if dl_url and download_file(session, dl_url, dest):
                    stats["assets_downloaded"] += 1
                    item["local_path"] = str(dest)
                    print(f"  {G}⬇{X} [{j+1}/{len(missing_assets)}] {dest.name} ({dest.stat().st_size:,} bytes)")
            time.sleep(2.0)
    else:
        print(f"✅ Toàn bộ {stats['assets_downloaded']} assets đã có sẵn đầy đủ.")

    return stats


def fetch_for_auth(auth_file: str, base_output_dir: str) -> bool:
    """Fetch all 3 APIs for a single auth file."""
    # ── Load auth ────────────────────────────────────────────────────────
    with open(auth_file) as f:
        auth = json.load(f)

    token = auth.get("access_token", "")
    account_id_file = auth.get("account_id", "")
    email_file = auth.get("email", "")

    if not token:
        log_error(f"File '{auth_file}' không chứa access_token hợp lệ.")
        return False

    meta = jwt_metadata(token)
    email = meta["email"] or email_file
    plan = meta["plan"] or "unknown"
    account_id = meta["account_id"] or account_id_file
    expires_in = meta["remaining_seconds"]

    if expires_in <= 0:
        log_error(f"Token cho '{email}' đã hết hạn!")
        return False

    print()
    print(f"{B}{C}{'═' * 64}{X}")
    print(f"{B}🔑 {email}{X} {D}({plan} plan, token còn {meta['remaining_hours']}h){X}")
    print(f"{B}{C}{'═' * 64}{X}")

    # ── Output directory ─────────────────────────────────────────────────
    safe_email = email.replace("@", "_").replace(".", "-")
    out_dir = Path(base_output_dir) / safe_email
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Create session ───────────────────────────────────────────────────
    session = make_session()

    # ── API 1: link-session ──────────────────────────────────────────────
    log_step("API 1: POST /api/auth/link-session")
    log_info("Đổi OAuth token → web session cookies...")

    r1 = api_link_session(session, token, expires_in)

    if r1["status"] == 200:
        log_ok(f"link-session thành công (HTTP {r1['status']}, {r1['cookie_count']} cookies)")
        for name in r1["cookie_names"]:
            print(f"  🍪 {name}")
    else:
        log_error(f"link-session thất bại (HTTP {r1['status']}): {r1.get('body', '')[:100]}")
        # Save error and bail
        (out_dir / "session.json").write_text(json.dumps(r1, indent=2, ensure_ascii=False))
        return False

    (out_dir / "session.json").write_text(json.dumps(r1, indent=2, ensure_ascii=False))

    # ── API 2: conversations ─────────────────────────────────────────────
    conv_cache = out_dir / "conversations.json"
    r2 = None
    if conv_cache.exists() and conv_cache.stat().st_size > 1000:
        try:
            cached_data = json.loads(conv_cache.read_text(encoding="utf-8"))
            items = cached_data.get("items", [])
            if len(items) > 50:
                log_step("API 2: conversations.json (Sử dụng cache có sẵn)")
                r2 = {"status": 200, "data": cached_data, "total": len(items), "items_count": len(items)}
                log_ok(f"{len(items)} conversations đã có trong cache → bỏ qua re-fetch danh sách")
        except Exception:
            r2 = None

    if not r2 or r2.get("status") != 200:
        log_step("API 2: GET /backend-api/conversations")
        log_info("Tải danh sách hội thoại...")
        r2 = api_conversations(session, token, account_id)
        if r2["status"] == 200:
            total = r2.get("total", "?")
            count = r2.get("items_count", 0)
            log_ok(f"{total} conversations (hiển thị {count}) → conversations.json")
            (out_dir / "conversations.json").write_text(
                json.dumps(r2.get("data", {}), indent=2, ensure_ascii=False))
        else:
            log_error(f"Conversations thất bại (HTTP {r2['status']})")
            (out_dir / "conversations.json").write_text(
                json.dumps(r2, indent=2, ensure_ascii=False))

    # ── API 3: accounts/check ────────────────────────────────────────────
    log_step("API 3: GET /backend-api/accounts/check")
    log_info("Check thông tin tài khoản & gói...")

    r3 = api_accounts_check(session, token, account_id)

    if r3["status"] == 200:
        log_ok(f"Accounts info → accounts.json")
        accounts = r3.get("data", {}).get("accounts", {})
        for aid, info in accounts.items():
            acct = info.get("account", {})
            acct_plan = acct.get("plan_type", "?")
            can_access = info.get("can_access_with_session", "?")
            print(f"  🏷️  {aid[:12]}…  │  plan={acct_plan}  │  access={can_access}")

        (out_dir / "accounts.json").write_text(
            json.dumps(r3.get("data", {}), indent=2, ensure_ascii=False))
    else:
        log_error(f"Accounts check thất bại (HTTP {r3['status']})")
        (out_dir / "accounts.json").write_text(
            json.dumps(r3, indent=2, ensure_ascii=False))

    # ── API 4: Conversation Details + Assets ──────────────────────────────
    conv_items = []
    if r2["status"] == 200:
        conv_items = r2.get("data", {}).get("items", [])

    # ── Filter by FETCH_DAYS ──────────────────────────────────────────────
    fetch_days = int(os.environ.get("FETCH_DAYS", "3"))
    if conv_items and fetch_days > 0:
        from datetime import timedelta
        cutoff = datetime.now(timezone.utc) - timedelta(days=fetch_days)
        original_count = len(conv_items)
        filtered = []
        for item in conv_items:
            ut = item.get("update_time") or item.get("create_time") or ""
            if not ut:
                filtered.append(item)
                continue
            try:
                item_time = datetime.fromisoformat(ut.replace("Z", "+00:00"))
                if item_time >= cutoff:
                    filtered.append(item)
            except Exception:
                filtered.append(item)
        conv_items = filtered
        log_info(f"Lọc {len(conv_items)}/{original_count} conversations trong {fetch_days} ngày gần nhất")

    detail_stats = {"total": 0, "ok": 0, "fail": 0, "assets_found": 0, "assets_downloaded": 0}
    if conv_items:
        log_step(f"API 4: Fetch {len(conv_items)} conversation details + assets")
        log_info("Tải chi tiết từng cuộc hội thoại (bao gồm hình ảnh, file)...")
        detail_stats = fetch_conversation_details(
            session, token, account_id, conv_items, out_dir)
        log_ok(f"Details: {detail_stats['ok']}/{detail_stats['total']} thành công")
        log_ok(f"Assets: {detail_stats['assets_found']} found, {detail_stats['assets_downloaded']} downloaded")

    # ── API 5: (Skipped: focus on primary account conversations only) ─────
    other_account_stats = {}

    # ── API 6: Fetch Project-scoped conversations ─────────────────────────
    project_stats = {"total": 0, "projects": []}
    log_step("API 6: Discover ChatGPT Projects")
    log_info("Tìm kiếm conversations thuộc Projects...")

    proj_items = conv_items
    if proj_items:
        # Extract unique project_ids (from context_scopes_v2 or conversation fields)
        project_map = {}  # project_id -> list of conversation items
        for item in proj_items:
            # Check context_scopes_v2 for project info
            scopes = item.get("context_scopes_v2", {})
            if isinstance(scopes, dict):
                for scope in scopes.get("context_scopes", []):
                    ns = scope.get("scope_namespace", "")
                    scope_id = scope.get("scope_id", "")
                    if ns == "project" and scope_id:
                        project_map.setdefault(scope_id, []).append(item)

        if project_map:
            log_ok(f"Tìm thấy {len(project_map)} projects!")
            proj_dir = out_dir / "projects"
            proj_dir.mkdir(parents=True, exist_ok=True)

            for pid, p_convs in project_map.items():
                # Try to get project info via PATCH (will fail but reveals structure)
                # For now just save the grouped conversations
                proj_sub = proj_dir / pid[:12]
                proj_sub.mkdir(parents=True, exist_ok=True)

                (proj_sub / "conversations.json").write_text(
                    json.dumps(p_convs, indent=2, ensure_ascii=False))

                project_stats["projects"].append({
                    "id": pid,
                    "conversation_count": len(p_convs),
                    "titles": [c.get("title", "?")[:40] for c in p_convs],
                })
                print(f"  📁 Project {pid[:12]}… ({len(p_convs)} conversations)")
                for c in p_convs[:3]:
                    print(f"      └─ {c.get('title', '?')[:40]}")

            project_stats["total"] = len(project_map)
            (proj_dir / "_projects_index.json").write_text(
                json.dumps(project_stats, indent=2, ensure_ascii=False))
        else:
            log_info("Không tìm thấy Projects (tài khoản chưa dùng tính năng Projects)")

    # ── Summary ──────────────────────────────────────────────────────────
    now = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    summary = f"""╔══════════════════════════════════════════════════════════════╗
║  ChatGPT API Fetch Summary                                  ║
╚══════════════════════════════════════════════════════════════╝

  📧 Email:          {email}
  👤 Name:           {meta['name']}
  💎 Plan:           {plan}
  🏢 Account ID:     {account_id}
  🆔 User ID:        {meta['user_id']}
  ⏰ Token expires:  {meta['remaining_hours']}h remaining
  📅 Fetched at:     {now}
  📁 Auth file:      {auth_file}

── API Results ────────────────────────────────────────────────
  1. link-session:     HTTP {r1['status']} ({r1['cookie_count']} cookies)
  2. conversations:    HTTP {r2['status']} ({r2.get('total', '?')} items)
  3. accounts:         HTTP {r3['status']}
  4. conv details:     {detail_stats['ok']}/{detail_stats['total']} ok
     assets found:     {detail_stats['assets_found']}
     assets downloaded:{detail_stats['assets_downloaded']}

── Output Files ───────────────────────────────────────────────
  {out_dir}/session.json
  {out_dir}/conversations.json
  {out_dir}/accounts.json
  {out_dir}/conversations/<id>.json    (full detail per conversation)
  {out_dir}/assets/<id>/<filename>     (downloaded images & files)
  {out_dir}/assets/<id>/_manifest.json (asset manifest per conversation)
  {out_dir}/summary.txt
"""
    (out_dir / "summary.txt").write_text(summary)
    # ── Convert conversations to HTML ─────────────────────────────────
    html_converter = Path(__file__).resolve().parent / "convert_conversations_to_html.py"
    if html_converter.exists():
        log_step("Convert all conversations to HTML")
        try:
            subprocess.run([sys.executable, str(html_converter), str(out_dir / "conversations"), str(out_dir / "assets")], check=False)
        except Exception as e:
            log_warn(f"Convert HTML warning: {e}")

    print()
    print(f"{B}{G}🎉 Hoàn tất fetch cho {email}!{X}")
    print(f"{D}   Output: {out_dir}/{X}")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <auth_file.json> <output_dir>")
        sys.exit(1)

    auth_file = sys.argv[1]
    output_dir = sys.argv[2]

    if not os.path.isfile(auth_file):
        log_error(f"File không tồn tại: {auth_file}")
        sys.exit(1)

    success = fetch_for_auth(auth_file, output_dir)
    sys.exit(0 if success else 1)
