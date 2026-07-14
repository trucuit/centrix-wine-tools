# Security Audit Report — CentriX Flow

**Scope:** CentriX end-to-end flow (auth → lock → pool export → Electron cookie inject → optional wine-tools dump/Chrome)  
**Mode:** Audit only (STRIDE + OWASP)  
**Date:** 2026-07-14  
**Sources:** `exports/centrix-app-asar-3.6.16/source` (App 3.6.16), wine-tools scripts, local runtime permissions  

**Credential hygiene:** Secret values masked as `<REDACTED_*>`; only env var / key names cited.

---

### Summary

| Metric | Value |
|--------|------:|
| Files scanned (primary) | ~25 (asar security-critical + 3 tool scripts + local perms) |
| Critical | 2 |
| High | 5 |
| Medium | 6 |
| Low | 4 |
| Info | 3 |

**Overall residual risk:** **High** for session-pool product model; **not** classic RCE-first app. Highest impact = **session cookie exfil / replay** once CentriX account or local dumps compromised.

---

### Flow under audit

```text
Google OAuth → /api/auth/google → session.bin + device-key
  → /api/profile/lock (single device)
  → open service → /api/profile/export?service= (AES-GCM)
  → importProfileSnapshot → RAM partition cookies.set
  → loadURL(AI site)
  → [wine-tools hook] cookies-dump plaintext
  → [optional] Chrome CDP inject
```

---

### Findings

| # | Severity | Category | STRIDE / OWASP | Location | Description | Fix recommendation |
|---|----------|----------|----------------|----------|-------------|-------------------|
| 1 | **Critical** | Insecure Design / Session | I · A04 A07 | Architecture: pool export | CentriX distributes **live AI session cookies** (encrypted in transit) to any authorized App User device. Theft of CentriX token+`sessionKey` **or** decrypted snapshot ≈ full use of pool AI accounts until revoke. | Short-lived AI sessions; bind export to device jkt always; server-side revoke AI sessions when CentriX token revoked; anomaly detection on export volume; minimize pool reuse |
| 2 | **Critical** | Secret in client | I · A02 A05 | `shared/app-attest.js:8-35` | **Default** `CENTRIX_APP_ATTEST_SECRET`, `CENTRIX_APP_KEY`, `CENTRIX_EXPORT_SIGN_KEY` **shipped in asar**. Code admits friction-only. Attest/App-Key/export-sig forgeable after unpack. Server warns if strict+default (`remote-tabs-main.js:573-574`). | Rotate to env-only secrets per deploy; refuse start if `*_IS_DEFAULT` in production; never ship defaults in release builds |
| 3 | **High** | Auth / PoP optional | S · A07 | `remote-user-main.js:688-693` | DPoP (`X-CentriX-Proof`) and session-key bind **enforced only when server flags** (`CENTRIX_BIND_DEVICE_KEY`, `CENTRIX_BIND_SESSION_KEY`). Client always sends headers; stolen Bearer may work if server log-only. | Enforce DPoP + sessionKey bind in production always; fail closed on bad proof |
| 4 | **High** | Information Disclosure | I · A02 | Hook dumps `cookies-dump-*.json` | Local dumps from asar hook are **session plaintext**. Observed perms: Wine userdata dumps **`644` (world-readable)**; project `cookies/` often `600` (good). | Force `chmod 600` on dumps in hook; umask; encrypt at rest; delete dumps on app quit; don't leave hook on shared machines |
| 5 | **High** | Supply / Integrity | T · A08 | `export-centrix-cookies.sh` + patched `app.asar` | Tools **patch production asar** (backup `app.asar.bak-cookie-export`). Integrity of App User binary broken; updates may reintroduce/remove hook unpredictably; attacker with write to Program Files can similar-patch. | Prefer non-invasive intercept; code-sign check on launch; document integrity loss; optional offline export only |
| 6 | **High** | Access / Export gate bypass class | A01 A07 | `remote-tabs-main.js:2956+` EXPORT_GATE | Gate requires prior “interaction” (health/services). **Not** a substitute for unforgeable client identity if secrets extracted. Naive bots blocked; reverse-engineered clients not. | Treat export as high-risk: CAPTCHA/device attestation hardware-backed where possible; rate limit per account; step-up on new device |
| 7 | **High** | Business logic fail-open | E · A04 | `remote-user-main.js:2781` model gate | Model credit check **FAIL OPEN** on network blip / timeout / 401 inside grace → possible **unbilled AI use**. | Fail closed for paid models; queue offline; deny when check unreachable |
| 8 | **Medium** | Session persistence | S · A07 | `remote-user-session.js`, quit handlers | Plain quit **does not** self-revoke; `session.bin` keeps token for restore (UX). Stolen disk + unlocked OS keychain can resume session. | Optional idle timeout; revoke on inactive; optional “don't persist login”; require re-auth for export after idle |
| 9 | **Medium** | Weak password policy | A07 | `remote-user-main.js:4209` | `change-password` min length **6** (UI copy says 8 in places). | Min 12+; breach check; Google-only deprecates password paths |
| 10 | **Medium** | Shared cookie jar | T I · A04 | `userBrowserSession` RAM prefix | All services share one partition → cross-service cookie visibility/clobber; dump of one open can include other domains in jar. | Partition per service; stricter dump scoping (already partial in export tools) |
| 11 | **Medium** | Shell sandbox off | E · A05 | `remote-user-main.js:4868` | Main window `sandbox: false` (service tabs sandbox true). Shell XSS/compromise higher impact. | Enable sandbox on shell if possible; strict CSP; no untrusted HTML |
| 12 | **Medium** | Local tools amplify blast | I · A04 | `import-cookies-to-chrome.mjs` | CDP inject into Chrome multiplies session copies; domain allowlist is good fail-closed design. | Keep isolated profile; auto-expire profile; never import `.full.json` (already skipped) |
| 13 | **Medium** | Seed defaults | A05 | `shared/local-db.js:531` | Seed passwords `CENTRIX_SEED_PW` or account.password fallback — risk if seed ships to non-dev. | No default seed in prod images |
| 14 | **Low** | Dead password UI | A05 | `remote-user/user.js` | Legacy password login UI paths remain; main throws disabled. Confusion / attack surface for UI bugs. | Remove dead password login UI entirely |
| 15 | **Low** | Grace 401 window | A07 | `AUTH_EXPIRY_GRACE_MS` 12s | After connect, 401 on `/api/me` ignored briefly — intentional tunnel lag. | Keep short; don't expand |
| 16 | **Low** | Export rate limit present | Info | `remote-tabs-main.js` rate tables | Export has rate limits (e.g. 10–15/min class) — good. | Keep + alert on threshold |
| 17 | **Low** | google secret env-only | Info | `google-oauth.js:11` | `GOOGLE_CLIENT_SECRET` defaults empty string — good (server env). Client has public client id only. | Ensure prod always sets secret |
| 18 | **Info** | Password login 410 | Info | `remote-tabs-main.js:4039` | Password login endpoint disabled. | Keep disabled |
| 19 | **Info** | Tools chmod 600 on convert | Info | export scripts `0o600` | Project exports often private. | Align Wine dump perms same way |
| 20 | **Info** | hardenRuntime | Info | `harden-runtime.js` | Packaged app exits if remote-debug flags. | Good defense-in-depth |

---

### STRIDE matrix (CentriX flow)

| Threat | Status | Notes |
|--------|--------|-------|
| **S**poofing | Partial | Google OAuth + device jkt good; client attest forgeable with asar defaults |
| **T**ampering | Partial | Snapshot AES-GCM integrity OK; asar patch / cookie dump tamper local |
| **R**epudiation | Partial | Activity + export-gate logs exist; local dumps unlogged by server |
| **I**nfo disclosure | **Weak** | Pool cookies + plaintext dumps + secrets in asar |
| **D**oS | Partial | Rate limits on export; model gate fail-open is inverse risk |
| **E**levation | Partial | Single-device + account allowlist; admin master token powerful if leaked |

### OWASP Top 10 mapping

| ID | Relevant findings |
|----|-------------------|
| A01 Broken Access Control | #6 export gate class; account path allowlists |
| A02 Cryptographic Failures | #2 shipped secrets; #4 plaintext dumps |
| A04 Insecure Design | #1 pool session distribution; #7 fail-open billing |
| A05 Security Misconfiguration | #5 asar patch; #11 sandbox; #13 seeds |
| A07 Identification/Auth Failures | #3 optional PoP; #8 persistent session; #9 weak pw policy |
| A08 Software/Data Integrity | #5 binary patching |
| A09 Logging | export-gate logs good; dump exfil not server-visible |

### Dependency audit

- CentriX asar: **no npm lock in extract** for full `npm audit` (bundled Electron app).  
- wine-tools importer: **no npm deps** (Node built-ins) — low supply-chain risk.  
- **Info:** Electron/Chromium version CVEs not verified in this pass.

### Secrets detected (names only)

| Location | Type | Risk |
|----------|------|------|
| `app-attest.js` DEFAULT_* | Attest / App-Key / Export-sign | Critical if prod uses defaults |
| `google-oauth.js` GOOGLE_CLIENT_ID | Public OAuth client id | Expected public |
| `google-oauth.js` CLIENT_SECRET | Env only (empty default) | OK if set on server |
| Local `session.bin` / dumps | Session material | High if machine compromised |

---

### Positive controls (keep)

1. Google-only login; password `/api/auth/login` → 410  
2. Snapshot AES-256-GCM with per-session key  
3. Export gate + interaction tracking + rate limits (design intent good)  
4. Single active device + takeover grace  
5. Service webContents: sandbox, no node, no DevTools  
6. safeStorage for session.bin / device-key  
7. Chrome importer: domain allowlist, skip `.full.json`, isolated profile  
8. Server startup warnings when strict gates + default secrets  

---

### Priority remediation roadmap

| Priority | Action | Owner surface |
|----------|--------|---------------|
| P0 | Rotate attest/app-key/export-sign off defaults; enforce non-default in prod | Backend + build |
| P0 | Enforce DPoP + sessionKey bind always | Backend |
| P0 | chmod 600 dumps; stop world-readable Wine dumps | Hook / App User |
| P1 | Model usage fail-closed | App User |
| P1 | Per-service partition | App User |
| P1 | Integrity monitoring (detect asar patch) | Ops |
| P2 | Remove dead password UI; raise password min if kept | App User |
| P2 | Idle re-auth for export | Product |
| P3 | Reduce dump retention; no Chrome multi-copy without policy | wine-tools users |

---

### Attack scenarios (validated conceptually)

| Scenario | Path | Impact |
|----------|------|--------|
| Malware on user Mac | Read `cookies-dump-*.json` (644) or decrypt session if OS unlocked | AI session hijack |
| Stolen CentriX Google account + new device takeover | Login → takeover → export | Full pool access for that grant |
| Unpacked asar + captured Bearer | Forge attest/sig; call export if token valid and interacted | Automated harvest if token still live |
| Network blip during chat | Model gate fail-open | Free usage / quota skip |
| Insider with admin/master | Plaintext snapshot path if ALLOW_PLAINTEXT | Mass cookie export |

---

### Out of scope / unresolved

- Live Phase-B production flag values (`BIND_*`, `EXPORT_GATE_STRICT`) not confirmed remotely.  
- Full Electron CVE matrix for bundled Chromium version.  
- Server-side RBAC IDOR matrix for every admin portal route (partial allowlist review only).  
- No active penetration against production API (audit is code/architecture).

---

### Verdict

**Do not treat CentriX client as a high-assurance vault.**  
The product is a **controlled session distributor**. Security depends on: (1) account hygiene, (2) non-default server secrets + enforced PoP, (3) local machine trust, (4) not leaving hook dumps world-readable.

**Release gate recommendation:** Block “secure deployment” claims until **P0** items addressed; wine-tools use only on owned machines with 600 perms and isolated Chrome profile.
