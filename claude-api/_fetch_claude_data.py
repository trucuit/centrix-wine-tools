#!/usr/bin/env python3
"""
claude-api/_fetch_claude_data.py

Tải toàn bộ các cuộc hội thoại Claude trực tiếp từ Cloud (claude.ai / Anthropic API)
bằng file xác thực (OAuth JSON hoặc Cookie sessionKey JSON).

Usage:
    python3 _fetch_claude_data.py <auth_or_cookie_file.json> <output_dir>
"""

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
import subprocess

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print("❌ Cần cài đặt curl_cffi: pip3 install --break-system-packages curl_cffi")
    sys.exit(1)

# ── ANSI Colors ──────────────────────────────────────────────────────────────
C = "\033[36m"   # cyan
G = "\033[32m"   # green
Y = "\033[33m"   # yellow
R = "\033[31m"   # red
B = "\033[1m"    # bold
D = "\033[2m"    # dim
X = "\033[0m"    # reset

BASE_URL = "https://claude.ai"
BROWSER = "chrome"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

def log_step(msg):  print(f"\n{B}{C}── {msg} ──{X}")
def log_info(msg):  print(f"{C}ℹ️  {msg}{X}")
def log_ok(msg):    print(f"{G}✅ {msg}{X}")
def log_warn(msg):  print(f"{Y}⚠️  {msg}{X}")
def log_error(msg): print(f"{R}❌ {msg}{X}", file=sys.stderr)


def extract_session_credentials(auth_data: dict | list) -> dict:
    """
    Trích xuất sessionKey (Web Cookie) hoặc OAuth access_token/refresh_token từ file json.
    """
    creds = {
        "type": "",
        "session_key": "",
        "access_token": "",
        "refresh_token": "",
        "email": "",
        "org_id": "",
        "org_name": "",
        "account_id": "",
    }

    # Trường hợp 1: Cookie array (J2Team, EditThisCookie)
    if isinstance(auth_data, list):
        for c in auth_data:
            if isinstance(c, dict) and c.get("name") in ("sessionKey", "sessionKeyV3"):
                creds["type"] = "session_key"
                creds["session_key"] = c.get("value", "")
                return creds

    # Trường hợp 2: Format dict
    if isinstance(auth_data, dict):
        if "cookies" in auth_data and isinstance(auth_data["cookies"], list):
            for c in auth_data["cookies"]:
                if isinstance(c, dict) and c.get("name") in ("sessionKey", "sessionKeyV3"):
                    creds["type"] = "session_key"
                    creds["session_key"] = c.get("value", "")
                    return creds

        if "sessionKey" in auth_data:
            creds["type"] = "session_key"
            creds["session_key"] = auth_data["sessionKey"]
            return creds

        if "access_token" in auth_data and auth_data["access_token"]:
            creds["type"] = "oauth_token"
            creds["access_token"] = auth_data["access_token"]
            creds["refresh_token"] = auth_data.get("refresh_token", "")
            creds["email"] = auth_data.get("email", "")
            creds["org_id"] = auth_data.get("organization_uuid", "")
            creds["org_name"] = auth_data.get("organization_name", "")
            creds["account_id"] = auth_data.get("account_uuid", "")
            return creds

    return creds


def make_session(session_key: str = "", oauth_token: str = "") -> cffi_requests.Session:
    """Tạo session giả lập trình duyệt Chrome."""
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
    if session_key:
        s.cookies.set("sessionKey", session_key, domain=".claude.ai")
    if oauth_token:
        s.headers["Authorization"] = f"Bearer {oauth_token}"
    return s


def try_refresh_oauth_token(refresh_token: str, auth_file: Path = None) -> str:
    """Thử làm mới OAuth access_token bằng refresh_token qua endpoint Anthropic."""
    if not refresh_token:
        return ""

    log_info("Đang thử gửi yêu cầu làm mới Access Token tới Claude OAuth Cloud...")
    url = TOKEN_URL
    payload = {
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    }

    try:
        s = cffi_requests.Session(impersonate=BROWSER)
        resp = s.post(url, json=payload, headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Claude-Code/2.1.278",
        }, timeout=15)

        print(f"  Cloud Refresh Response: HTTP {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            new_access_token = data.get("access_token", "")
            new_refresh_token = data.get("refresh_token", refresh_token)
            if new_access_token:
                log_ok("Làm mới Access Token thành công từ máy chủ Claude!")
                # Cập nhật lại file auth nếu có
                if auth_file and auth_file.exists():
                    try:
                        raw = json.loads(auth_file.read_text())
                        raw["access_token"] = new_access_token
                        raw["refresh_token"] = new_refresh_token
                        raw["last_refresh"] = datetime.now().isoformat()
                        auth_file.write_text(json.dumps(raw, indent=2), encoding="utf-8")
                        log_ok(f"Đã lưu token mới vào: {auth_file.name}")
                    except Exception as e:
                        log_warn(f"Không thể ghi đè file auth: {e}")
                return new_access_token
        else:
            log_warn(f"Làm mới thất bại (HTTP {resp.status_code}): {resp.text[:200]}")
    except Exception as e:
        log_warn(f"Lỗi khi gửi yêu cầu refresh: {e}")

    return ""


def api_get_bootstrap(session: cffi_requests.Session) -> dict:
    url = f"{BASE_URL}/api/bootstrap"
    try:
        resp = session.get(url, timeout=15)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        log_warn(f"Lỗi gọi bootstrap: {e}")
    return {}


def api_get_organizations(session: cffi_requests.Session) -> list[dict]:
    url = f"{BASE_URL}/api/organizations"
    try:
        resp = session.get(url, timeout=15)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        log_warn(f"Lỗi gọi organizations: {e}")
    return []


def api_get_conversations(session: cffi_requests.Session, org_id: str) -> tuple[int, list[dict], str]:
    """
    Lấy danh sách toàn bộ các cuộc hội thoại trên Cloud.
    Trả về (status_code, conversations, raw_body_preview).
    """
    url = f"{BASE_URL}/api/organizations/{org_id}/chat_conversations"
    try:
        resp = session.get(url, timeout=20)
        status = resp.status_code
        text_preview = resp.text[:300]
        if status == 200:
            return status, resp.json(), text_preview
        else:
            return status, [], text_preview
    except Exception as e:
        return 0, [], str(e)


def api_get_conversation_detail(session: cffi_requests.Session, org_id: str,
                                conversation_id: str, max_retries: int = 3) -> dict | None:
    url = f"{BASE_URL}/api/organizations/{org_id}/chat_conversations/{conversation_id}"
    for attempt in range(max_retries):
        try:
            resp = session.get(url, timeout=25)
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 429:
                wait_time = 5 * (attempt + 1)
                log_warn(f"Rate limited (429). Chờ {wait_time}s thử lại...")
                time.sleep(wait_time)
            else:
                break
        except Exception:
            time.sleep(1)
    return None


def download_file(session: cffi_requests.Session, url: str, dest: Path) -> bool:
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        resp = session.get(url, timeout=30)
        if resp.status_code == 200:
            dest.write_bytes(resp.content)
            return True
    except Exception:
        pass
    return False


def fetch_for_auth(auth_file: str, base_output_dir: str) -> bool:
    auth_path = Path(auth_file).resolve()
    output_base_dir = Path(base_output_dir).resolve()

    if not auth_path.exists():
        log_error(f"Không tìm thấy file: {auth_path}")
        return False

    try:
        auth_raw = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception as e:
        log_error(f"Không thể phân tích cú pháp JSON: {e}")
        return False

    creds = extract_session_credentials(auth_raw)
    auth_type = creds["type"]

    if not auth_type:
        log_error("File không chứa sessionKey hợp lệ hoặc OAuth access_token.")
        return False

    log_step(f"Khởi tạo phiên kết nối Claude Cloud ({auth_type})")
    print(f"  📄 File nguồn:      {auth_path}")

    email = creds["email"]
    org_id = creds["org_id"]
    org_name = creds["org_name"]
    token_val = creds["access_token"] if auth_type == "oauth_token" else creds["session_key"]

    session = None

    if auth_type == "session_key":
        session = make_session(session_key=token_val)
        bootstrap = api_get_bootstrap(session)
        account = bootstrap.get("account", {})
        email = account.get("email_address") or "unknown_email"
        memberships = bootstrap.get("memberships", [])
        if memberships:
            first_org = memberships[0].get("organization", {})
            org_id = first_org.get("uuid", "")
            org_name = first_org.get("name", "")
        if not org_id:
            org_list = api_get_organizations(session)
            if org_list:
                org_id = org_list[0].get("uuid", "")
                org_name = org_list[0].get("name", "")
    else:
        # OAuth token (Claude Code)
        if not email:
            email = "sasadairaseann@gmail.com"
        session = make_session(oauth_token=token_val)

    safe_email = re.sub(r"[^\w\-.]", "_", email)
    out_dir = output_base_dir / safe_email
    out_dir.mkdir(parents=True, exist_ok=True)
    conv_dir = out_dir / "conversations"
    assets_dir = out_dir / "assets"
    conv_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    print(f"  📧 Email tài khoản: {B}{email}{X}")
    print(f"  🏢 Tổ chức:         {org_name or 'N/A'} ({org_id or 'N/A'})")
    print(f"  🔑 Token Prefix:    {token_val[:30]}...")
    print(f"  📂 Thư mục xuất:    {out_dir}")

    if not org_id:
        log_error("Không tìm thấy Organization UUID để gửi request lên Cloud.")
        return False

    # ── Gửi request trực tiếp tới Cloud conversations API ──
    cloud_url = f"{BASE_URL}/api/organizations/{org_id}/chat_conversations"
    log_step(f"Gửi request tới Cloud API: GET {cloud_url}")
    
    status, conversations, raw_body = api_get_conversations(session, org_id)
    print(f"  ☁️  Mã phản hồi từ Cloud: HTTP {status}")

    # Nếu 401 với OAuth token: Thử làm mới qua refresh_token
    if status == 401 and auth_type == "oauth_token" and creds["refresh_token"]:
        log_warn("Access token nhận mã HTTP 401. Đang thử làm mới bằng refresh_token...")
        new_token = try_refresh_oauth_token(creds["refresh_token"], auth_path)
        if new_token:
            token_val = new_token
            session = make_session(oauth_token=token_val)
            # Thử lại request
            log_step(f"Thử lại request với token mới: GET {cloud_url}")
            status, conversations, raw_body = api_get_conversations(session, org_id)
            print(f"  ☁️  Mã phản hồi từ Cloud (lần 2): HTTP {status}")

    if status != 200:
        log_error(f"Máy chủ Claude Cloud từ chối kết nối (HTTP {status})!")
        print(f"  📩 Chi tiết phản hồi từ Cloud: {raw_body}")
        
        # Ghi log kết quả vào file để user xem trực tiếp
        summary_fail = [
            "╔══════════════════════════════════════════════════════════════╗",
            "║  Claude Cloud Fetch Result (FAILED)                          ║",
            "╚══════════════════════════════════════════════════════════════╝",
            "",
            f"  File nguồn:   {auth_path}",
            f"  Email:        {email}",
            f"  Org ID:       {org_id}",
            f"  Loại auth:    {auth_type}",
            f"  Cloud URL:    {cloud_url}",
            f"  HTTP Status:  {status}",
            f"  Phản hồi:     {raw_body}",
            f"  Thời gian:    {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "",
            "════════════════════════════════════════════════════════════════",
        ]
        (out_dir / "summary.txt").write_text("\n".join(summary_fail), encoding="utf-8")
        return False

    log_ok(f"Thành công! Máy chủ Cloud trả về {len(conversations)} cuộc hội thoại!")

    # Lưu danh sách conversations.json
    (out_dir / "conversations.json").write_text(
        json.dumps(conversations, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # ── Tải chi tiết từng cuộc hội thoại ──
    log_step(f"Tải chi tiết {len(conversations)} cuộc hội thoại từ Cloud...")
    ok_count = 0
    total_assets = 0

    for idx, c in enumerate(conversations, 1):
        cid = c.get("uuid") or c.get("id")
        title = c.get("name") or c.get("title") or "Untitled"
        safe_title = (title[:45] + "…") if len(title) > 45 else title
        print(f"  [{idx}/{len(conversations)}] ⏳ {safe_title} ({cid[:8]}…)", end="\r")

        detail = api_get_conversation_detail(session, org_id, cid)
        if detail:
            ok_count += 1
            conv_file = conv_dir / f"{cid}.json"
            conv_file.parent.mkdir(parents=True, exist_ok=True)
            conv_file.write_text(json.dumps(detail, indent=2, ensure_ascii=False), encoding="utf-8")

            # Tải tệp đính kèm (assets)
            for msg in detail.get("chat_messages", []):
                for att in msg.get("attachments", []):
                    file_url = att.get("url") or att.get("download_url")
                    file_name = att.get("file_name") or att.get("id")
                    if file_url and file_name:
                        dest_file = assets_dir / cid / file_name
                        if not dest_file.exists() or dest_file.stat().st_size == 0:
                            if download_file(session, file_url, dest_file):
                                total_assets += 1

        time.sleep(0.5)

    print(f"\n{G}✅ Đã tải xong {ok_count}/{len(conversations)} hội thoại, {total_assets} tệp đính kèm.{X}")

    # ── Chuyển đổi sang Markdown ──
    log_step("Chuyển đổi dữ liệu sang định dạng Markdown & tạo index...")
    script_dir = Path(__file__).resolve().parent
    convert_script = script_dir / "convert_claude_to_md.py"
    if convert_script.exists():
        subprocess.run([sys.executable, str(convert_script), str(conv_dir), str(assets_dir)])

    # ── Tạo file summary.txt ──
    summary_lines = [
        "╔══════════════════════════════════════════════════════════════╗",
        "║  Claude Cloud API Fetch Summary                              ║",
        "╚══════════════════════════════════════════════════════════════╝",
        "",
        f"  📧 Email:          {email}",
        f"  🏢 Organization:   {org_name} ({org_id})",
        f"  📁 Auth File:      {auth_path}",
        f"  🔑 Auth Type:      {auth_type}",
        f"  📅 Fetched at:     {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "── API Results ────────────────────────────────────────────────",
        f"  1. chat_conversations: HTTP {status} ({len(conversations)} items)",
        f"  2. conv details:       {ok_count}/{len(conversations)} ok",
        f"  3. assets downloaded:  {total_assets}",
        "",
        "── Output Files ───────────────────────────────────────────────",
        f"  {out_dir}/conversations.json",
        f"  {out_dir}/conversations/<id>.json",
        f"  {out_dir}/conversations_md/<file>.md",
        f"  {out_dir}/conversations_md/index.md",
        f"  {out_dir}/assets/<id>/<file>",
        f"  {out_dir}/summary.txt",
        "",
        "════════════════════════════════════════════════════════════════",
    ]
    (out_dir / "summary.txt").write_text("\n".join(summary_lines), encoding="utf-8")
    log_ok(f"Tóm tắt kết quả lưu tại: {out_dir}/summary.txt")

    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 _fetch_claude_data.py <auth_file.json> [output_dir]")
        sys.exit(1)

    auth_file = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parent / "data")

    success = fetch_for_auth(auth_file, out_dir)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
