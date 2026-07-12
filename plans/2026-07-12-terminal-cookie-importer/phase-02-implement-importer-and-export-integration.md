---
phase: 2
title: Implement importer and export integration
status: completed
priority: P1
dependencies:
  - 1
---

# Phase 2: Implement importer and export integration

## Overview

Implement the terminal wrapper and Node CDP client, then add an opt-in export integration.

## Implementation Steps

1. Create `import-cookies-to-chrome.sh` as the stable user command.
2. Create `scripts/import-cookies-to-chrome.mjs` for CDP transport and validation.
3. Add `--chrome` parsing to both export scripts.
4. Update README with commands, profile location, and security boundaries.

## Success Criteria

- [ ] `--help`, success, and invalid-input paths are usable.
- [ ] Existing export commands remain backward compatible.
- [ ] Import summary reports counts without secrets.
