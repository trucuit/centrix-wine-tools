#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude Code CLI - Subscription OAuth Login Engine
Implements the exact PKCE OAuth protocol from Claude Code CLI v2.1.x
"""

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import shutil
import socketserver
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# ANSI colors
C_RESET = "\033[0m"
C_BOLD = "\033[1m"
C_RED = "\033[31m"
C_GREEN = "\033[32m"
C_YELLOW = "\033[33m"
C_BLUE = "\033[34m"
C_CYAN = "\033[36m"
C_WHITE = "\033[37m"

def log_info(msg):
    print(f"{C_CYAN}ℹ️  {msg}{C_RESET}")

def log_success(msg):
    print(f"{C_GREEN}✅ {msg}{C_RESET}")

def log_warn(msg):
    print(f"{C_YELLOW}⚠️  {msg}{C_RESET}")

def log_error(msg):
    print(f"{C_RED}❌ {msg}{C_RESET}")

# Anthropic Claude Code official OAuth constants
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
CLAUDE_AI_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

SCOPES = [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
]

SUB_MAP = {
    "claude_max": "max",
    "claude_pro": "pro",
    "claude_enterprise": "enterprise",
    "claude_team": "team",
}

def resolve_user():
    user = os.environ.get("DEFAULT_USER") or os.environ.get("USER")
    if not user or user == "root":
        try:
            user = subprocess.check_output(["stat", "-f", "%Su", "/dev/console"]).decode().strip()
        except Exception:
            pass
    return user or "pat"

def resolve_home(user):
    home = os.environ.get("DEFAULT_HOME") or os.environ.get("HOME")
    if not home:
        try:
            out = subprocess.check_output(["dscl", ".", "-read", f"/Users/{user}", "NFSHomeDirectory"]).decode()
            home = out.split()[1]
        except Exception:
            pass
    return Path(home or str(Path.home()))

def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

def generate_pkce():
    code_verifier = base64url_encode(secrets.token_bytes(32))
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64url_encode(digest)
    state = base64url_encode(secrets.token_bytes(32))
    return code_verifier, code_challenge, state

def build_auth_url(code_challenge: str, state: str, redirect_uri: str, email: str = "", sso: bool = False) -> str:
    params = [
        ("code", "true"),
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("scope", " ".join(SCOPES)),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ]
    if email:
        params.append(("login_hint", email))
    if sso:
        params.append(("login_method", "sso"))

    query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    return f"{CLAUDE_AI_AUTHORIZE_URL}?{query}"

class AuthCallbackState:
    def __init__(self, expected_state: str):
        self.expected_state = expected_state
        self.code = None
        self.state = None
        self.received_event = threading.Event()
        self.error = None

def make_callback_handler(auth_state: AuthCallbackState):
    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/callback":
                self.send_response(404)
                self.end_headers()
                return

            query = urllib.parse.parse_qs(parsed.query)
            code = query.get("code", [None])[0]
            state = query.get("state", [None])[0]
            error = query.get("error", [None])[0]
            error_desc = query.get("error_description", [None])[0]

            if error:
                auth_state.error = error_desc or error
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"<html><body style='font-family:system-ui;padding:40px;text-align:center;'><h2>Authentication Failed</h2><p>You can close this tab and return to your terminal.</p></body></html>")
                auth_state.received_event.set()
                return

            if not code:
                self.send_response(400)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Missing code parameter")
                return

            if state != auth_state.expected_state:
                self.send_response(400)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"State mismatch")
                auth_state.error = "State mismatch in callback"
                auth_state.received_event.set()
                return

            auth_state.code = code
            auth_state.state = state
            auth_state.received_event.set()

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            success_html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Claude Code Login Successful</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#c9d1d9;">
  <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 48px;text-align:center;max-width:440px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
    <div style="font-size:48px;margin-bottom:12px;">✅</div>
    <h2 style="color:#58a6ff;margin:0 0 8px 0;">Đăng nhập thành công!</h2>
    <p style="color:#8b949e;font-size:14px;margin:0 0 20px 0;">Xác thực Claude Code đã hoàn tất. Bạn có thể đóng tab này và quay lại terminal.</p>
  </div>
</body>
</html>"""
            self.wfile.write(success_html.encode("utf-8"))

    return CallbackHandler

def parse_user_code_input(raw: str, expected_state: str):
    raw = raw.strip()
    if not raw:
        return None, None

    if raw.startswith("http://") or raw.startswith("https://"):
        try:
            parsed = urllib.parse.urlparse(raw)
            qs = urllib.parse.parse_qs(parsed.query)
            code = qs.get("code", [None])[0]
            state = qs.get("state", [None])[0]
            if code:
                return code, (state or expected_state)
        except Exception:
            pass

    if "#" in raw:
        parts = raw.split("#", 1)
        code = parts[0].strip()
        state = parts[1].strip()
        return code, state

    return raw, expected_state

def main():
    parser = argparse.ArgumentParser(
        description="Đăng nhập Claude Code CLI với gói Subscription (Claude Pro / Max / Team)."
    )
    parser.add_argument("-o", "--open", action="store_true", help="Tự động mở link đăng nhập trên trình duyệt mặc định")
    parser.add_argument("-c", "--chrome", action="store_true", help="Mở link đăng nhập trên Google Chrome")
    parser.add_argument("-e", "--email", type=str, default="", help="Điền sẵn email đăng nhập trên trang Claude")
    parser.add_argument("--sso", action="store_true", help="Bật chế độ đăng nhập SSO")
    parser.add_argument("--no-server", action="store_true", help="Tắt local loopback server (chỉ nhập code thủ công)")
    parser.add_argument("-s", "--status", action="store_true", help="Xem trạng thái xác thực hiện tại của Claude CLI")

    args = parser.parse_args()

    user = resolve_user()
    home_dir = resolve_home(user)
    claude_dir = home_dir / ".claude"
    claude_json_path = home_dir / ".claude.json"
    credentials_path = claude_dir / ".credentials.json"
    backup_dir = claude_dir / "backups"

    if args.status:
        if shutil.which("claude"):
            subprocess.run(["claude", "auth", "status"])
        else:
            print("Lệnh claude chưa được cài đặt trong PATH.")
        return

    print(f"{C_BOLD}{C_CYAN}========================================================================{C_RESET}")
    print(f"{C_BOLD}{C_CYAN}🔑 CLAUDE CODE CLI - SUBSCRIPTION OAUTH LOGIN HELPER{C_RESET}")
    print(f"{C_BOLD}{C_CYAN}========================================================================{C_RESET}")

    # Check existing auth status
    if shutil.which("claude"):
        try:
            proc = subprocess.run(["claude", "auth", "status"], capture_output=True, text=True, timeout=4)
            if proc.returncode == 0:
                status = json.loads(proc.stdout)
                if status.get("loggedIn"):
                    sub = status.get("subscriptionType") or "unknown"
                    email = status.get("email") or "unknown"
                    log_info(f"Trạng thái hiện tại: Đã đăng nhập ({email}, gói: {sub}).")
                    log_info("Tiếp tục sẽ làm mới hoặc đăng nhập tài khoản mới.")
                else:
                    log_info("Trạng thái hiện tại: Chưa đăng nhập.")
        except Exception:
            pass

    code_verifier, code_challenge, state = generate_pkce()

    # Start loopback server if enabled
    loopback_server = None
    loopback_port = None
    auth_callback_state = AuthCallbackState(expected_state=state)

    if not args.no_server:
        try:
            handler = make_callback_handler(auth_callback_state)
            loopback_server = socketserver.TCPServer(("127.0.0.1", 0), handler)
            loopback_port = loopback_server.server_address[1]
            server_thread = threading.Thread(target=loopback_server.serve_forever, daemon=True)
            server_thread.start()
        except Exception as e:
            log_warn(f"Không thể khởi động local loopback server ({e}). Sử dụng chế độ manual callback.")
            loopback_server = None

    manual_auth_url = build_auth_url(code_challenge, state, MANUAL_REDIRECT_URL, email=args.email, sso=args.sso)
    loopback_auth_url = build_auth_url(code_challenge, state, f"http://localhost:{loopback_port}/callback", email=args.email, sso=args.sso) if loopback_port else None

    print()
    print(f"{C_BOLD}{C_WHITE}👉 BƯỚC 1: Mở đường link sau trong trình duyệt để đăng nhập Claude:{C_RESET}")
    print(f"{C_CYAN}------------------------------------------------------------------------{C_RESET}")
    print(f"{C_BOLD}{C_YELLOW}{manual_auth_url}{C_RESET}")
    print(f"{C_CYAN}------------------------------------------------------------------------{C_RESET}")
    print(f"ℹ️  Đăng nhập bằng tài khoản Claude có gói Subscription ({C_BOLD}Pro / Max / Team / Enterprise{C_RESET}).")
    print(f"ℹ️  Nhấn {C_BOLD}Authorize{C_RESET}. Sau khi cấp quyền, Anthropic sẽ chuyển đến trang callback.")
    print(f"ℹ️  Trang callback sẽ hiển thị một ô chứa mã (dạng {C_BOLD}<code>#<state>{C_RESET}).")
    print()

    # Auto open browser if requested
    open_url = loopback_auth_url if loopback_auth_url else manual_auth_url
    if args.open or args.chrome:
        try:
            if args.chrome:
                log_info("Đang mở link trên Google Chrome...")
                subprocess.run(["open", "-a", "Google Chrome", open_url], check=False)
            else:
                log_info("Đang mở link trên trình duyệt mặc định...")
                subprocess.run(["open", open_url], check=False)
        except Exception as e:
            log_warn(f"Không thể tự động mở trình duyệt: {e}")

    # Wait for code
    print(f"{C_BOLD}{C_WHITE}👉 BƯỚC 2: Nhập Auth Code sau khi cấp quyền trong trình duyệt:{C_RESET}")
    print(f"ℹ️  (Nếu trình duyệt tự động callback về localhost, bước này sẽ tự hoàn tất)")

    shared_result = {"code": None, "state": None}

    def read_terminal_input():
        try:
            prompt_str = f"\n{C_BOLD}{C_GREEN}Auth Code (hoặc code#state) > {C_RESET}"
            sys.stdout.write(prompt_str)
            sys.stdout.flush()

            # Try /dev/tty first for interactive terminal, fallback to stdin
            line = ""
            if os.path.exists("/dev/tty") and sys.stdin.isatty():
                try:
                    with open("/dev/tty", "r") as tty:
                        line = tty.readline()
                except Exception:
                    line = sys.stdin.readline()
            else:
                line = sys.stdin.readline()

            if line:
                c, s = parse_user_code_input(line, state)
                if c:
                    shared_result["code"] = c
                    shared_result["state"] = s
            auth_callback_state.received_event.set()
        except Exception:
            auth_callback_state.received_event.set()

    input_thread = threading.Thread(target=read_terminal_input, daemon=True)
    input_thread.start()

    while not auth_callback_state.received_event.is_set():
        time.sleep(0.2)

    if loopback_server:
        loopback_server.shutdown()
        loopback_server.server_close()

    used_redirect_uri = MANUAL_REDIRECT_URL
    if auth_callback_state.code:
        received_code = auth_callback_state.code
        received_state = auth_callback_state.state
        used_redirect_uri = f"http://localhost:{loopback_port}/callback"
        print(f"\n{C_GREEN}⚡ Đã nhận mã xác thực tự động từ trình duyệt qua localhost callback!{C_RESET}")
    elif shared_result["code"]:
        received_code = shared_result["code"]
        received_state = shared_result["state"]
        used_redirect_uri = MANUAL_REDIRECT_URL
        print(f"\n{C_GREEN}📥 Đã nhận mã xác thực từ người dùng.{C_RESET}")
    else:
        if auth_callback_state.error:
            log_error(f"Lỗi xác thực: {auth_callback_state.error}")
        else:
            log_error("Không nhận được mã xác thực hợp lệ.")
        sys.exit(1)

    # Token exchange
    print()
    log_info("Đang đổi Authorization Code lấy OAuth Access Token từ Anthropic...")

    token_payload = {
        "grant_type": "authorization_code",
        "code": received_code,
        "redirect_uri": used_redirect_uri,
        "client_id": CLIENT_ID,
        "code_verifier": code_verifier,
        "state": received_state or state,
    }

    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        TOKEN_URL,
        data=json.dumps(token_payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Claude-Code/2.1.263",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            token_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        log_error(f"Đổi token thất bại (HTTP {e.code}): {err_body}")
        sys.exit(1)
    except Exception as e:
        log_error(f"Lỗi kết nối khi đổi token: {e}")
        sys.exit(1)

    access_token = token_data.get("access_token")
    refresh_token = token_data.get("refresh_token")
    expires_in = token_data.get("expires_in", 3600)
    refresh_expires_in = token_data.get("refresh_token_expires_in", 2592000)
    scope_str = token_data.get("scope", "")
    scopes_list = [s for s in scope_str.split(" ") if s] if isinstance(scope_str, str) else SCOPES

    if not access_token:
        log_error("Phản hồi không chứa access_token!")
        sys.exit(1)

    log_success("Đổi OAuth Token thành công!")

    # Fetch User Profile
    log_info("Đang lấy thông tin tài khoản và gói Subscription từ Anthropic...")
    profile_data = None
    profile_req = urllib.request.Request(
        PROFILE_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "User-Agent": "Claude-Code/2.1.263",
        },
    )

    try:
        with urllib.request.urlopen(profile_req, context=ctx, timeout=15) as resp:
            profile_data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log_warn(f"Không thể tải hồ sơ người dùng ({e}). Tiếp tục lưu thông tin cơ bản.")

    account_info = profile_data.get("account", {}) if isinstance(profile_data, dict) else {}
    org_info = profile_data.get("organization", {}) if isinstance(profile_data, dict) else {}

    org_type = org_info.get("organization_type")
    sub_type = SUB_MAP.get(org_type, org_type or "pro")
    rate_limit_tier = org_info.get("rate_limit_tier")

    now_ms = int(time.time() * 1000)
    expires_at_ms = now_ms + (expires_in * 1000)
    refresh_expires_at_ms = now_ms + (refresh_expires_in * 1000)

    oauth_creds = {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": expires_at_ms,
        "refreshTokenExpiresAt": refresh_expires_at_ms,
        "scopes": scopes_list,
        "subscriptionType": sub_type,
        "rateLimitTier": rate_limit_tier,
    }

    full_creds_payload = {
        "claudeAiOauth": oauth_creds
    }

    # Backup existing credentials
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_file = backup_dir / f"claude-code-keychain.backup.{timestamp}.json"

    if shutil.which("security"):
        find_cmd = ["security", "find-generic-password", "-a", user, "-w", "-s", "Claude Code-credentials"]
        existing = subprocess.run(find_cmd, capture_output=True, text=True, check=False)
        if existing.returncode == 0 and existing.stdout.strip():
            backup_file.write_text(existing.stdout.strip() + "\n")
            os.chmod(backup_file, 0o600)
            log_info(f"Đã sao lưu credentials cũ: {backup_file}")

    # Save to macOS Keychain
    keychain_saved = False
    if shutil.which("security"):
        serialized = json.dumps(full_creds_payload, separators=(",", ":"))
        hex_payload = serialized.encode("utf-8").hex()
        save_cmd = [
            "security", "add-generic-password", "-U",
            "-a", user,
            "-s", "Claude Code-credentials",
            "-X", hex_payload
        ]
        res = subprocess.run(save_cmd, capture_output=True, text=True, check=False)
        if res.returncode == 0:
            keychain_saved = True
            log_success("Đã lưu token vào macOS Keychain (service: 'Claude Code-credentials').")
        else:
            log_warn(f"Lưu Keychain không thành công ({res.stderr.strip()}). Sử dụng file ~/.claude/.credentials.json.")

    # Save plaintext fallback ~/.claude/.credentials.json
    claude_dir.mkdir(parents=True, exist_ok=True)
    credentials_path.write_text(json.dumps(full_creds_payload, indent=2) + "\n")
    os.chmod(credentials_path, 0o600)
    log_success(f"Đã lưu credentials fallback vào: {credentials_path}")

    # Update ~/.claude.json
    claude_json = {}
    if claude_json_path.exists():
        try:
            claude_json = json.loads(claude_json_path.read_text())
        except Exception:
            claude_json = {}

    claude_json["hasCompletedOnboarding"] = True

    oauth_acc = claude_json.get("oauthAccount") if isinstance(claude_json.get("oauthAccount"), dict) else {}
    if account_info:
        oauth_acc["accountUuid"] = account_info.get("uuid")
        oauth_acc["emailAddress"] = account_info.get("email_address")
        oauth_acc["displayName"] = account_info.get("display_name")
        oauth_acc["fullName"] = account_info.get("full_name")
        oauth_acc["accountCreatedAt"] = account_info.get("created_at")

    if org_info:
        oauth_acc["organizationUuid"] = org_info.get("uuid")
        oauth_acc["billingType"] = org_info.get("billing_type")
        oauth_acc["seatTier"] = org_info.get("seat_tier")
        oauth_acc["hasExtraUsageEnabled"] = bool(org_info.get("has_extra_usage_enabled", False))
        oauth_acc["subscriptionCreatedAt"] = org_info.get("subscription_created_at")
        oauth_acc["ccOnboardingFlags"] = org_info.get("cc_onboarding_flags", {})
        oauth_acc["claudeCodeTrialEndsAt"] = org_info.get("claude_code_trial_ends_at")
        oauth_acc["claudeCodeTrialDurationDays"] = org_info.get("claude_code_trial_duration_days")

    oauth_acc["profileFetchedAt"] = now_ms
    claude_json["oauthAccount"] = oauth_acc

    claude_json_path.write_text(json.dumps(claude_json, indent=2) + "\n")
    os.chmod(claude_json_path, 0o600)
    log_success(f"Đã cập nhật trạng thái onboarding & oauthAccount vào: {claude_json_path}")

    # Summary
    print()
    print(f"{C_BOLD}{C_CYAN}========================================================================{C_RESET}")
    print(f"{C_BOLD}{C_GREEN}🎉 ĐĂNG NHẬP CLAUDE SUBSCRIPTION HOÀN TẤT THÀNH CÔNG!{C_RESET}")
    print(f"{C_BOLD}{C_CYAN}========================================================================{C_RESET}")
    if account_info.get("email_address"):
        print(f" 👤 Tài khoản:     {C_BOLD}{account_info.get('email_address')}{C_RESET}")
    if account_info.get("full_name"):
        print(f" 🏷️  Tên hiển thị:  {account_info.get('full_name')} ({account_info.get('displayName')})")
    print(f" 💎 Gói Sub:       {C_BOLD}{C_YELLOW}{sub_type.upper()}{C_RESET} (Tier: {rate_limit_tier or 'default'})")
    if org_info.get("uuid"):
        print(f" 🏢 Organization:  {org_info.get('uuid')}")
    print(f" ⏰ Token hết hạn: {datetime.fromtimestamp(expires_at_ms / 1000).strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{C_CYAN}------------------------------------------------------------------------{C_RESET}")

    if shutil.which("claude"):
        try:
            proc = subprocess.run(["claude", "auth", "status", "--text"], capture_output=True, text=True, timeout=5)
            if proc.stdout.strip():
                print(f"{C_BOLD}Trạng thái xác thực Claude CLI:{C_RESET}")
                print(proc.stdout.strip())
        except Exception:
            pass

    print(f"{C_BOLD}{C_GREEN}✨ Bạn có thể sử dụng ngay lệnh `claude` trong terminal!{C_RESET}")

if __name__ == "__main__":
    main()
