#!/bin/bash
#
# chatgpt_remote_desktop_download.sh
#
# Gửi message qua ChatGPT API để Remote Desktop Commander 
# tar và upload /chatgpt-web từ máy Windows.
#
# Usage: ./chatgpt_remote_desktop_download.sh <auth_json>
#

set -euo pipefail

AUTH_FILE="${1:?Usage: $0 <auth_json_file>}"
OUTPUT_DIR="chatgpt-api/data/remote_downloads"

if [ ! -f "$AUTH_FILE" ]; then
    echo "❌ File not found: $AUTH_FILE"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

python3 << 'PYEOF'
import json, sys, os, time, base64, re
from curl_cffi import requests as cffi_requests

auth_file = os.environ.get("AUTH_FILE", sys.argv[1] if len(sys.argv) > 1 else "")
output_dir = os.environ.get("OUTPUT_DIR", "chatgpt-api/data/remote_downloads")

with open(auth_file) as f:
    auth = json.load(f)

token = auth["access_token"]
account_id = auth["account_id"]

# Setup session with browser impersonation
s = cffi_requests.Session(impersonate="chrome")
s.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "text/event-stream",
    "Referer": "https://chatgpt.com/",
    "Origin": "https://chatgpt.com",
})

# Link session
parts = token.split(".")
payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=="))
expires_in = max(1, int(payload.get("exp", 0) - time.time()))
s.post("https://chatgpt.com/api/auth/link-session", json={
    "auth_token": token, "expires_in": expires_in
}, headers={"Content-Type": "application/json", "x-i-am-a-browser": "true"})

print("✅ Session linked")

headers = {
    "Authorization": f"Bearer {token}",
    "ChatGPT-Account-Id": account_id,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
}

# Step 1: Create conversation with Remote Desktop Commander
# The message asks RDC to tar and provide download link for /chatgpt-web
import uuid
msg_id = str(uuid.uuid4())
parent_id = str(uuid.uuid4())

message_text = """@Remote Desktop Commander 

Thực hiện các bước sau trên máy Windows:

1. Vào thư mục /chatgpt-web (hoặc tìm thư mục chatgpt-web trên máy)
2. Tạo file zip toàn bộ thư mục: `Compress-Archive -Path "C:\\chatgpt-web\\*" -DestinationPath "C:\\Users\\Admin\\Desktop\\chatgpt-web.zip" -Force`
3. Nếu không tìm thấy /chatgpt-web, hãy tìm: `Get-ChildItem -Path C:\\ -Filter "chatgpt-web" -Recurse -Directory -ErrorAction SilentlyContinue | Select-Object FullName`
4. Liệt kê cấu trúc thư mục chatgpt-web cho mình xem

Trả kết quả chi tiết."""

conv_payload = {
    "action": "next",
    "messages": [{
        "id": msg_id,
        "author": {"role": "user"},
        "content": {
            "content_type": "text",
            "parts": [message_text]
        },
        "metadata": {
            "system_hints": ["plugin:asdk_app_6a057d268ebc81919918d37eec718425"],
            "serialization_metadata": {
                "custom_symbol_offsets": [{
                    "id": "plugin:asdk_app_6a057d268ebc81919918d37eec718425",
                    "symbol": "ecosystemMention",
                    "startIndex": 0,
                    "endIndex": 26
                }]
            }
        }
    }],
    "parent_message_id": parent_id,
    "model": "gpt-5-6-thinking",
    "timezone_offset_min": -420,
    "history_and_training_disabled": False,
    "conversation_mode": {"kind": "primary_assistant"},
    "websocket_request_id": str(uuid.uuid4()),
}

print("\n📤 Sending message to ChatGPT with @Remote Desktop Commander...")
print(f"   Message: Find and zip /chatgpt-web on Windows machine")

resp = s.post(
    "https://chatgpt.com/backend-api/conversation",
    json=conv_payload,
    headers=headers,
    stream=True,
    timeout=120,
)

print(f"\n📡 Response status: {resp.status_code}")

if resp.status_code != 200:
    print(f"❌ Error: {resp.text[:500]}")
    sys.exit(1)

# Parse SSE stream
full_text = ""
conv_id = None
file_urls = []

for line in resp.iter_lines():
    if not line:
        continue
    line = line.decode("utf-8", errors="replace")
    if not line.startswith("data: "):
        continue
    data_str = line[6:]
    if data_str == "[DONE]":
        break
    try:
        data = json.loads(data_str)
        
        # Extract conversation_id
        if "conversation_id" in data:
            conv_id = data["conversation_id"]
        
        # Extract message content
        msg = data.get("message", {})
        content = msg.get("content", {})
        parts = content.get("parts", [])
        
        for part in parts:
            if isinstance(part, str):
                full_text = part  # SSE sends cumulative text
            elif isinstance(part, dict):
                ct = part.get("content_type", "")
                if "file" in ct or "download" in ct:
                    file_urls.append(part)
        
        # Check for tool calls (MCP actions)
        metadata = msg.get("metadata", {})
        if metadata.get("status") == "finished_successfully":
            role = msg.get("author", {}).get("role", "")
            if role == "assistant" and full_text:
                # Print progress
                preview = full_text[:200].replace("\n", " ")
                print(f"\r   📝 {preview}...", end="", flush=True)
                
    except json.JSONDecodeError:
        continue

print(f"\n\n{'='*60}")
print(f"📋 Conversation ID: {conv_id}")
print(f"📝 Response length: {len(full_text)} chars")
print(f"📎 Files found: {len(file_urls)}")

# Save full response
os.makedirs(output_dir, exist_ok=True)
result = {
    "conversation_id": conv_id,
    "response_text": full_text,
    "file_urls": file_urls,
    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
}
result_file = os.path.join(output_dir, "rdc_response.json")
with open(result_file, "w") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)

print(f"\n💾 Saved to: {result_file}")

# Print the actual response
print(f"\n{'='*60}")
print("📋 ChatGPT Response:")
print(f"{'='*60}")
print(full_text[:3000])

if file_urls:
    print(f"\n📎 Download URLs:")
    for fu in file_urls:
        print(f"   {fu}")

PYEOF
