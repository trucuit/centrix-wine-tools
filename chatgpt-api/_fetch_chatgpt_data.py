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


def api_conversation_detail(session: cffi_requests.Session, token: str,
                            account_id: str, conversation_id: str,
                            max_retries: int = 5) -> dict:
    """API 4: GET /backend-api/conversation/{id} — full conversation detail (with 429 retry)."""
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
            wait_time = int(retry_after) if retry_after and retry_after.isdigit() else (30 * (attempt + 1))
            log_warn(f"Rate limited (429). Chờ {wait_time}s hồi phục trước khi thử lại ({attempt+1}/{max_retries})...")
            time.sleep(wait_time)
        else:
            time.sleep(1)

    return {"status": getattr(resp, "status_code", 500), "conversation_id": conversation_id, "body": getattr(resp, "text", "")[:500]}


def api_file_download_url(session: cffi_requests.Session, token: str,
                          account_id: str, file_id: str,
                          max_retries: int = 3) -> dict | None:
    """Get download URL for a file/image asset (with 429 retry)."""
    url = f"{BASE_URL}/backend-api/files/{file_id}/download"
    headers = {
        "Authorization": f"Bearer {token}",
        "ChatGPT-Account-Id": account_id,
    }
    for attempt in range(max_retries):
        resp = session.get(url, headers=headers)
        if resp.status_code == 200:
            try:
                return resp.json()
            except Exception:
                return None
        elif resp.status_code == 429:
            time.sleep(3 * (attempt + 1))
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


def fetch_conversation_details(
    session: cffi_requests.Session, token: str, account_id: str,
    conversations: list[dict], out_dir: Path,
) -> dict:
    """Fetch detail + download assets for all conversations."""
    conv_dir = out_dir / "conversations"
    conv_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = out_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    stats = {"total": len(conversations), "ok": 0, "fail": 0,
             "assets_found": 0, "assets_downloaded": 0, "skipped": 0}

    for i, conv in enumerate(conversations):
        cid = conv.get("id", "")
        title = (conv.get("title") or "Untitled")[:40]
        idx = f"[{i+1}/{len(conversations)}]"
        detail_file = conv_dir / f"{cid}.json"

        # Check if already downloaded and valid
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

        # Fetch detail
        r = api_conversation_detail(session, token, account_id, cid)

        if r["status"] != 200:
            print(f"  {R}✗{X} {idx} {title} — HTTP {r['status']}")
            stats["fail"] += 1
            time.sleep(0.3)
            continue

        detail = r.get("data", {})
        msg_count = len(detail.get("mapping", {}))

        # Save detail JSON
        detail_file.write_text(json.dumps(detail, indent=2, ensure_ascii=False), encoding="utf-8")

        # Extract and download assets
        assets = extract_assets_from_detail(detail)
        stats["assets_found"] += len(assets)

        downloaded = 0
        for asset in assets:
            file_id = asset.get("file_id", "")
            if not file_id:
                continue

            # Get download URL
            dl_info = api_file_download_url(session, token, account_id, file_id)
            if not dl_info:
                continue

            dl_url = dl_info.get("download_url", "")
            file_name = dl_info.get("file_name") or f"{file_id}"
            mime = dl_info.get("mime_type", "")

            # Determine extension
            if "." not in file_name:
                ext_map = {
                    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
                    "image/webp": ".webp", "application/pdf": ".pdf",
                    "text/plain": ".txt", "text/csv": ".csv",
                }
                file_name += ext_map.get(mime, "")

            dest = assets_dir / cid / file_name
            if dl_url and download_file(session, dl_url, dest):
                downloaded += 1
                asset["local_path"] = str(dest)
            time.sleep(0.2)

        stats["assets_downloaded"] += downloaded
        stats["ok"] += 1

        asset_info = f", {len(assets)} assets ({downloaded} ⬇)" if assets else ""
        print(f"  {G}✓{X} {idx} {title} — {msg_count} msgs{asset_info}")

        # Save asset manifest for this conversation
        if assets:
            manifest = assets_dir / cid / "_manifest.json"
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps(assets, indent=2, ensure_ascii=False), encoding="utf-8")

        # Rate limit: safe delay between conversations
        time.sleep(0.8)

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
    log_step("API 2: GET /backend-api/conversations")
    log_info("Tải danh sách hội thoại...")

    r2 = api_conversations(session, token, account_id)

    if r2["status"] == 200:
        total = r2.get("total", "?")
        count = r2.get("items_count", 0)
        log_ok(f"{total} conversations (hiển thị {count}) → conversations.json")

        items = r2.get("data", {}).get("items", [])
        for item in items[:10]:
            title = (item.get("title") or "Untitled")[:50]
            cid = item.get("id", "?")[:12]
            updated = (item.get("update_time") or "?")[:19]
            print(f"  📝 {title}  │  {cid}…  │  {updated}")

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

    r_proj = api_conversations(session, token, account_id, limit=100)
    if r_proj["status"] == 200:
        proj_items = r_proj.get("data", {}).get("items", [])
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
    # ── Convert conversations to Markdown ────────────────────────────────
    md_converter = Path(__file__).resolve().parent / "convert_conversations_to_md.py"
    if md_converter.exists():
        log_step("Convert all conversations to Markdown")
        try:
            subprocess.run([sys.executable, str(md_converter), str(out_dir / "conversations"), str(out_dir / "assets")], check=False)
        except Exception as e:
            log_warn(f"Convert MD warning: {e}")

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
