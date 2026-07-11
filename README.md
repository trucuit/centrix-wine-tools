# CentriX Wine tools (macOS)

Scripts to run **CentriX App User** (Windows build) under Wine on Apple Silicon, dump service cookies, and export **J2TEAM**-compatible JSON.

## Requirements

- macOS (Apple Silicon tested: M4)
- [Wine Stable](https://wiki.winehq.org/MacOS) (`/Applications/Wine Stable.app`)
- `python3`, `npx` (for asar hook install)
- CentriX App User installed into a Wine prefix (see below)

## Scripts

| Script | Purpose |
|--------|---------|
| `run-centrix.sh` | Launch CentriX App User in a Wine virtual desktop |
| `export-centrix-cookies.sh` | Install dump hook, watch dumps, convert to J2TEAM, export-all |
| `export-pick-service.sh` | Interactive / CLI pick service → export offline (no app UI) |

### Launch app

```bash
./run-centrix.sh
```

Uses:

- `WINEPREFIX` default: `./wine-prefix-centrix` (local, **not** in git)
- GPU flags for blank-window workaround on Wine

### Cookie dump hook + watch

```bash
# Install hook into app.asar (overwrites dump on every service open)
./export-centrix-cookies.sh install-hook

# Watch dumps → write J2TEAM files to Desktop + optional injector dir
export OUT_DIR="$HOME/Desktop/centrix-cookie-export"
export J2TEAM_OUT_DIR="/path/to/centriq-cookies-injector"  # optional
./export-centrix-cookies.sh watch
```

Other modes:

```bash
./export-centrix-cookies.sh export-all
./export-centrix-cookies.sh convert /path/to/cookies-dump-chatgpt.json
./export-centrix-cookies.sh uninstall-hook
```

### Pick service (no app window)

Uses dumps already on disk under the Wine userdata folder:

```bash
./export-pick-service.sh           # menu
./export-pick-service.sh chatgpt   # ChatGPT → chatgpt.com.json + auth.openai.com.json
./export-pick-service.sh all
./export-pick-service.sh --list
```

## Local Wine prefix (not in git)

Create / keep locally:

```text
./wine-prefix-centrix/
  drive_c/users/.../AppData/Local/Programs/CentriX App User/
  drive_c/users/.../AppData/Roaming/mkvhszparoue/   # dumps, session (secret)
```

**Do not commit** the prefix: it contains `session.bin`, `device-key.bin`, and live cookie dumps.

Installer (Windows):

```text
CentriX-App-User-Setup-3.6.16.exe
# install silent example:
#   WINEPREFIX=./wine-prefix-centrix wine setup.exe /VERYSILENT
```

## Output layout (local)

```text
~/Desktop/centrix-cookie-export/
  services/
    chatgpt.json
    claude.json
    ...
  chatgpt.com.json
  auth.openai.com.json
  chat.deepseek.com.json
```

## Security

- Repo is **private**; still exclude secrets via `.gitignore`.
- Cookie dumps may be shared pool sessions — handle carefully (ToS / privacy).
- DeepSeek often needs **localStorage** in addition to cookies for browser import.

## License

Private use. CentriX / third-party apps remain their owners' property.
