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
| **`export-pick-service.sh`** | Chọn service → export offline (ChatGPT → + `auth.openai.com`) |
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
# Hook: mỗi lần mở service → dump → ghi đè ./cookies/
./export-centrix-cookies.sh install-hook
./export-centrix-cookies.sh watch

# Export offline (không cần mở UI — cần dump đã có)
./export-pick-service.sh
./export-pick-service.sh chatgpt   # → cookies/chatgpt.com.json + cookies/auth.openai.com.json
./export-pick-service.sh all
./export-centrix-cookies.sh export-all
```

```text
cookies/
  services/
    chatgpt.json
    claude.json
    ...
  chatgpt.com.json
  auth.openai.com.json
```

Override path: `OUT_DIR=/other/path ./export-pick-service.sh chatgpt`  
Optional copy ra injector: `J2TEAM_OUT_DIR=/path/to/injector`

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
- Cookie dump có thể là session pool — cẩn thận ToS / privacy.  
- DeepSeek browser import thường cần **localStorage**, không chỉ cookie.

---

## License

Private use. CentriX và app bên thứ ba thuộc chủ sở hữu tương ứng.
