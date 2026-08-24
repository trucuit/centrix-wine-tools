#!/usr/bin/env zsh
# ==============================================================================
# export-cookies.sh — Trích xuất Cookie các dịch vụ AI CentriX bằng Master Token
# ==============================================================================
# Sử dụng:
#   ./export-cookies.sh                      # Tải toàn bộ tất cả các dịch vụ AI
#   ./export-cookies.sh chatgpt              # Tải riêng cookie ChatGPT
#   ./export-cookies.sh claude --chrome      # Tải và tự nạp thẳng Claude vào Chrome
#   ./export-cookies.sh all --chrome         # Tải và tự nạp tất cả vào Chrome
# ==============================================================================

set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

# Kiểm tra Node.js
if ! command -v node >/dev/null 2>&1; then
  print -r -- "LỖI: Cần cài đặt Node.js 18+ để chạy script." >&2
  exit 1
fi

MJS_SCRIPT="$SCRIPT_DIR/scripts/export-via-master.mjs"

if [[ ! -f "$MJS_SCRIPT" ]]; then
  print -r -- "LỖI: Không tìm thấy $MJS_SCRIPT" >&2
  exit 1
fi

# Chạy script export
node "$MJS_SCRIPT" "$@"

# Thu thập danh sách service để nạp vào Chrome nếu có cờ --chrome / -c
import_chrome=0
typeset -a target_services=()

for arg in "$@"; do
  if [[ "$arg" == "--chrome" || "$arg" == "-c" ]]; then
    import_chrome=1
  elif [[ "$arg" != -* ]]; then
    # Chuẩn hóa alias
    s="${arg:l}"
    case "$s" in
      claue|claud|cl) s="claude" ;;
      cg|gpt|chat|chat-gpt) s="chatgpt" ;;
      gem) s="gemini" ;;
      copilot|msft) s="microsoft-copilot" ;;
      elements|envato) s="envato-elements" ;;
      gpt-5|gpt-pro|gpt5|pro|chatgpt-pro|chatgpt_pro|gptpro) s="gptpro" ;;
      magnific) s="freepik" ;;
      perp) s="perplexity" ;;
    esac
    target_services+=("$s")
  fi
done

if [[ "$import_chrome" -eq 1 ]]; then
  if [[ -f "$SCRIPT_DIR/import-cookies-to-chrome.sh" ]]; then
    print -r -- "\n▸ Đang tự động nạp Cookie vào Google Chrome..."
    if [[ "${#target_services[@]}" -eq 0 || "${target_services[1]:-}" == "all" ]]; then
      # Nạp tất cả service có cookie folder
      local cookies_root="${CENTRIX_COOKIES_DIR:-$SCRIPT_DIR/cookies}"
      if [[ -d "$cookies_root" ]]; then
        for svc_dir in "$cookies_root"/*(N/); do
          local svc_name="${svc_dir:t}"
          print -r -- "▸ Nạp $svc_name vào Chrome..."
          "$SCRIPT_DIR/import-cookies-to-chrome.sh" "$svc_name" || true
        done
      else
        "$SCRIPT_DIR/import-cookies-to-chrome.sh" chatgpt || true
      fi
    else
      for svc in "${target_services[@]}"; do
        print -r -- "▸ Nạp $svc vào Chrome..."
        "$SCRIPT_DIR/import-cookies-to-chrome.sh" "$svc" || true
      done
    fi
  fi
fi
