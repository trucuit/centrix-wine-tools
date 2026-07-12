---
title: Terminal Chrome Cookie Importer
description: >-
  One-command cookie import from per-service JSON folders into an isolated
  Chrome profile via CDP.
status: completed
priority: P2
branch: main
tags: []
blockedBy: []
blocks: []
created: '2026-07-12T04:07:34.011Z'
createdBy: 'ck:plan'
source: skill
---

# Terminal Chrome Cookie Importer

## Overview

Add a dependency-free terminal command that starts or reuses an isolated Chrome profile, imports service-scoped cookies through the Chrome DevTools Protocol, and opens or reloads the target service. Integrate it with both existing export scripts through an opt-in flag.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Design CLI and CDP flow](./phase-01-design-cli-and-cdp-flow.md) | Completed |
| 2 | [Implement importer and export integration](./phase-02-implement-importer-and-export-integration.md) | Completed |
| 3 | [Test with isolated Chrome profile](./phase-03-test-with-isolated-chrome-profile.md) | Completed |

## Dependencies

- Node.js 22+ with built-in `fetch` and `WebSocket`.
- Google Chrome installed locally.
- Existing `cookies/<serviceId>/` export structure.

## Acceptance Criteria

- `./import-cookies-to-chrome.sh <service>` works from Terminal without npm install.
- Chrome uses a non-default profile and a configurable debugging port.
- `.full.json` files are never imported.
- Cookie attributes and service/domain allowlists are validated.
- Export scripts support optional `--chrome` without changing default behavior.
- A real isolated Chrome run proves cookies were stored through CDP.
