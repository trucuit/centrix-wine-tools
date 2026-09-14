# VPS Auths

Thư mục chứa các file thông tin xác thực từ VPS và các script import trực tiếp vào máy Mac:

## Danh sách tài khoản

1. **Codex CLI**: `codex-341d52a7-chatgpt57@23ww.onmicrosoft.com-self-serve-business-prolite.json`
   - Tài khoản: `chatgpt57@23ww.onmicrosoft.com`
   - Đích: `~/.codex/auth.json` (tự động làm mới OpenAI OAuth refresh token)

2. **Claude**: `claude-sasadairaseann@gmail.com.json`
   - Tài khoản: `sasadairaseann@gmail.com`
   - Đích: `~/.claude/auth.json`, `~/.claude.json`, macOS Keychain (`Claude Code-credentials`)

3. **Antigravity**: `antigravity-laurienbuny2568@gmail.com.json`
   - Tài khoản: `laurienbuny2568@gmail.com`
   - Đích: `~/.gemini/oauth_creds.json`

4. **xAI / Grok CLI**: `xai-codecentrix1@signs.onmicrosoft.com.json`
   - Tài khoản: `codecentrix1@signs.onmicrosoft.com`
   - Đích: `~/.grok/auth.json`

---

## Cách sử dụng

Tất cả các script thực thi đều nằm ngay trong thư mục này:

```bash
# 1. Tải (sync) các file auth mới nhất từ VPS (163.223.224.240):
./vps-auths/download.sh
# Hoặc:
./vps-auths/import.sh download

# 2. Tải từ VPS và tự động import tất cả:
./vps-auths/import.sh sync

# 3. Chạy menu tương tác (chọn tải từ VPS hoặc import từng dịch vụ):
./vps-auths/import.sh

# 4. Hoặc import từng dịch vụ cụ thể:
./vps-auths/import-codex.sh
./vps-auths/import-claude.sh
./vps-auths/import-antigravity.sh
./vps-auths/import-xai.sh

# 5. Hoặc import tất cả tài khoản cùng một lúc từ file hiện có:
./vps-auths/import-all.sh
```
