# CentriX Wine tools (macOS)

Chạy **CentriX App User** (Windows `.exe`) trên Mac bằng Wine, dump cookie theo service, export JSON kiểu **J2TEAM**.

Repo private: dùng được trên **nhiều Mac** — clone → setup → run.

---

## Máy Mac mới (quick start)

```bash
# 1) Clone
git clone https://github.com/trucuit/centrix-wine-tools.git
cd centrix-wine-tools

# 2) Cài Wine + cài .exe vào Wine prefix local
./setup-centrix-mac.sh

# 3) Chạy app
./run-centrix.sh
```

Lần đầu:

- Cần **Homebrew**
- Apple Silicon: **Rosetta 2** (script hỏi cài nếu thiếu)
- Login CentriX (Google) trên máy đó

Reinstall app:

```bash
./setup-centrix-mac.sh --force-reinstall
```

---

## Files trong repo

| File | Việc |
|------|------|
| **`setup-centrix-mac.sh`** | Bootstrap Mac: Wine + cài `CentriX-App-User-Setup-*.exe` |
| **`run-centrix.sh`** | Launch app (prefix portable, không hardcode `/Volumes/m2`) |
| **`export-centrix-cookies.sh`** | Hook dump cookie mỗi lần mở service + `watch` / convert |
| **`export-centrix-api.sh`** | API trực tiếp: login Google + `/profile/export` (không mở UI) |
| **`export-pick-service.sh`** | Chọn service → export offline (ChatGPT → + `auth.openai.com`) |
| **`scripts/lib/centrix_cookie_export.py`** | **Pattern export chung** — pick / API / export-centrix-cookies reuse |
| **`import-cookies-to-chrome.sh`** | Import cookie vào Chrome profile riêng qua CDP |
| **`CentriX-App-User-Setup-3.6.16.exe`** | Installer Windows (~93 MB) |
| **`README.md`** | Doc này |

**Không** commit (mỗi máy tự tạo / secret):

```text
wine-prefix-centrix/     # session, device-key, raw dumps
cookies/*                # exported JSON (giữ cookies/.gitkeep)
.centrix-env
```

---

## Scripts chi tiết

### setup-centrix-mac.sh

```bash
./setup-centrix-mac.sh
./setup-centrix-mac.sh --force-reinstall
```

Steps:

1. Check macOS + Rosetta (arm64)  
2. `brew install --cask wine-stable` nếu chưa có  
3. `WINEPREFIX=./wine-prefix-centrix`  
4. Cài silent: `CentriX-App-User-Setup-*.exe /VERYSILENT …`  
5. Ghi `.centrix-env` cho `run-centrix.sh`

### run-centrix.sh

```bash
./run-centrix.sh
```

- Đọc `.centrix-env` nếu có  
- Tự tìm `CentriX App User.exe` (username Wine khác nhau từng Mac)  
- Virtual desktop 1440×900 + flag GPU (tránh cửa sổ trắng)

### Cookie tools

Mọi export mặc định vào **`./cookies/`** trong project (không còn Desktop).

```bash
# A) API trực tiếp — không mở App UI, không patch asar
./export-centrix-api.sh login            # Google OAuth 1 lần
./export-centrix-api.sh export grok      # → cookies/grok-heavy/
./export-centrix-api.sh export chatgpt   # alias → notebooklm
./export-centrix-api.sh export all
./export-centrix-api.sh status
./export-centrix-api.sh logout
# session: .centrix-api-session.json (gitignored, mode 600)
# nếu device đang lock bởi App User: đóng app hoặc ./export-centrix-api.sh takeover

# B) Hook asar — mỗi lần mở service → dump
./export-centrix-cookies.sh install-hook
./export-centrix-cookies.sh watch

# C) Offline từ dump đã có
./export-pick-service.sh
./export-pick-service.sh chatgpt   # → cookies/chatgpt/
./export-pick-service.sh grok      # → cookies/grok/
./export-pick-service.sh deepseek  # → cookies/deepseek/
./export-pick-service.sh all
./export-centrix-cookies.sh export-all
```

```text
cookies/
  chatgpt/
    chatgpt.json              # cookie scoped cho service, an toàn để inject
    chatgpt.full.json         # raw partition dump, chỉ dùng chẩn đoán
    chatgpt.com.json
    auth.openai.com.json
  grok/
    grok.json
    grok.full.json
    grok.com.json
    accounts.x.ai.json
```

Override path: `OUT_DIR=/other/path ./export-pick-service.sh chatgpt`  
Optional copy ra injector: `J2TEAM_OUT_DIR=/path/to/injector`

### Import tự động vào Chrome

Tool dùng Chrome profile riêng tại `./.chrome-cookie-profile`; không điều khiển profile Chrome mặc định.

```bash
# Menu tương tác: chọn service + mode (service|full)
./import-cookies-to-chrome.sh
./import-cookies-to-chrome.sh --pick

# Import cookie đã export, mở hoặc reload service (mode=service mặc định)
./import-cookies-to-chrome.sh grok
./import-cookies-to-chrome.sh chatgpt

# Import từ *.full.json (raw partition dump)
./import-cookies-to-chrome.sh grok --full
./import-cookies-to-chrome.sh chatgpt --mode full

# Export rồi import bằng một lệnh
./export-pick-service.sh grok --chrome
./export-centrix-cookies.sh export-all --chrome

# Kiểm tra JSON/domain mà không mở Chrome
./import-cookies-to-chrome.sh grok --dry-run
./import-cookies-to-chrome.sh grok --full --dry-run
```

Tuỳ chọn hữu ích:

```text
-i, --pick             Menu chọn service + mode (TTY)
--mode service|full    service = scoped JSON (mặc định, an toàn inject)
                       full    = chỉ *.full.json (raw dump, vẫn filter domain)
--mode-service / --full  alias ngắn cho --mode
--profile-dir <path>   Chrome profile riêng
--port <number>        CDP port, mặc định 9222
--chrome <path>        Chrome executable
--no-open              Import nhưng không mở/reload tab
--json                 Kết quả machine-readable
```

Mặc định (`--mode service`): đọc `cookies/<serviceId>/*.json`, **bỏ qua** `.full.json`.  
`--mode full` / `--full`: chỉ đọc `*.full.json`. Cả hai mode vẫn kiểm tra allowlist domain và không in giá trị cookie ra log.

Alias mặc định: `grok` luôn dùng nguồn `grok-heavy`; `chatgpt` luôn dùng nguồn `notebooklm` (GPT-5.5 Pro).

---

## Yêu cầu

| | |
|--|--|
| OS | macOS (test: Apple Silicon M4) |
| Wine | Wine Stable app (x86_64 + Rosetta trên ARM) |
| Tools | `brew`, `python3`, `npx` (hook asar) |
| Disk | ~1–2 GB (Wine prefix + app) |

---

## Cấu trúc sau setup

```text
centrix-wine-tools/
├── setup-centrix-mac.sh
├── run-centrix.sh
├── export-centrix-cookies.sh
├── export-pick-service.sh
├── CentriX-App-User-Setup-3.6.16.exe
├── README.md
├── .gitignore
├── cookies/                     # exports (gitignored contents)
│   ├── .gitkeep
│   └── services/
├── .centrix-env                 # local (gitignored)
└── wine-prefix-centrix/         # local (gitignored)
    └── drive_c/users/<you>/.../CentriX App User/
```

---

## Troubleshooting

| Vấn đề | Cách xử lý |
|--------|------------|
| `Wine not found` | `./setup-centrix-mac.sh` hoặc cài cask `wine-stable` |
| Rosetta missing | `softwareupdate --install-rosetta --agree-to-license` |
| Cửa sổ trắng | `run-centrix.sh` đã bật software GL; đợi session-restore |
| `exe not found` | `./setup-centrix-mac.sh --force-reinstall` |
| brew gstreamer cần sudo | Script dùng `--skip-cask-deps` khi cài Wine |

---

## Security

- Repo **private**; vẫn **không** commit wine prefix / cookie dumps.  
- Mỗi service được export vào `cookies/<serviceId>/`; file được giới hạn theo domain và đặt permission `0600`.
- File `<serviceId>.full.json` trong từng folder vẫn chứa raw partition, không đưa vào injector.
- Cookie dump có thể là session pool — cẩn thận ToS / privacy.  
- DeepSeek browser import thường cần **localStorage**, không chỉ cookie.

---

## License

Private use. CentriX và app bên thứ ba thuộc chủ sở hữu tương ứng.
