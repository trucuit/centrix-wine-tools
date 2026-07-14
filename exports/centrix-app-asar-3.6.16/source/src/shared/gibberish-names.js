// Anonymized (gibberish) on-disk names — replace the visible "centrix"/"CentriX" branding in
// %APPDATA% folders + Electron session partitions. ANONYMIZATION ONLY (NOT a security control).
//
// IMPORTANT: changing any value here requires a matching one-time on-disk migration that moves the
// existing folders to the new names (see deploy-gibberish-migrate.cmd). The constants MUST match the
// migration exactly, or the app will create empty folders and lose cookies / auth / tunnel config.
module.exports = {
  // userData roots (set via app.setName before the app resolves any path)
  SERVER_USERDATA_NAME: "qwmbvcxzladk",   // PROMOTED TO PRODUCTION — adopt the original App Server userData (custodian logins + config). (clone-alongside value was qwmbvcxzweb1)
  USER_USERDATA_NAME: "mkvhszparoue",     // was "CentriX App User"

  // config dirs (siblings of userData under %APPDATA%/appData)
  SERVER_CONFIG_DIR: "sdfhsdjfhdsk",      // PROMOTED TO PRODUCTION — original config dir (auth.json/tunnel.json/local-db.json). (clone-alongside value was sdfhsdjfweb1)
  DESKTOP_CONFIG_DIR: "okmijnuhbzaq",     // was "CentriX Desktop App"

  // session partition prefixes (on-disk folder = Partitions\<prefix><profileId>)
  SHARED_BROWSER_PREFIX: "nkkqiwedoap-",  // PROMOTED TO PRODUCTION — original custodian partition that holds the real service logins. (clone-alongside value was nkkqiwedweb-)
  USER_RAM_PREFIX: "tgbyhnujmik-",        // was "centrix-user-"            (App User RAM-only — no migration)
  ACCOUNT_PREFIX: "ploakmnjiuh-",         // was "centrix-account-"
  DESKTOP_SHARED_PREFIX: "zxcvbnmasdf-",  // was "centrix-desktop-shared-"
  CLAUDE_REMOTE_PREFIX: "qazwsxedcrf-"    // was "centrix-claude-remote-"
};
