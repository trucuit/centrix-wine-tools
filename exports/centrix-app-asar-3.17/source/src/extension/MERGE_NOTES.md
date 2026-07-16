# CentriX + Private Pass merge notes

This package keeps `centrix-extension` as the primary codebase and adds a local encrypted password vault.

Added files:
- `crypto.js`
- `vault.html`
- `vault.js`
- `vault.css`
- `vault-background.js`
- `vault-content.js`

Changed files:
- `manifest.json`
- `background.js`
- `popup.html`
- `popup.js`

Behavior:
- The normal CentriX popup remains the main popup.
- A new `Vault` button in the popup opens the merged password vault.
- Vault autofill runs through `vault-content.js` on matched pages.
- Auto-unlock state is cleared when there are no entries marked for auto-fill.

Latest upgrades in this build:
- Added local TOTP generation from saved Base32 secrets.
- Added email OTP helper that can read codes from an already-open Gmail / Outlook / generic mail tab.
- Enhanced autofill to fill username, password, TOTP, and email OTP fields when they are detected.
- Added richer vault UI fields for 2FA and email OTP settings.

Extra improvements in this build:
- Added per-entry Login URL hints so autofill can continue on redirected login / OTP / MFA pages.
- Added current-tab URL capture button in Vault for faster setup.
- Added entry edit/update flow instead of creating duplicates when changing passwords or URL hints.
- Improved OTP field detection for pages that only label the input externally (for example, One-time code screens).
