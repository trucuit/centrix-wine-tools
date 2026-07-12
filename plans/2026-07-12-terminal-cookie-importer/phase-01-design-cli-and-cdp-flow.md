---
phase: 1
title: Design CLI and CDP flow
status: completed
priority: P1
dependencies: []
---

# Phase 1: Design CLI and CDP flow

## Overview

Define command behavior, Chrome lifecycle, CDP calls, validation, and error handling.

## Implementation Steps

1. Resolve service folder and canonical target URL.
2. Discover a local Chrome binary and use a dedicated profile directory.
3. Start Chrome with a loopback-only debugging port or reuse the existing endpoint.
4. Load only service-scoped JSON files, excluding `.full.json`.
5. Normalize cookies into CDP `Network.CookieParam` objects.
6. Call `Storage.setCookies`, verify with `Storage.getCookies`, then open/reload the service.

## Success Criteria

- [ ] No dependency on npm packages.
- [ ] No access to the default Chrome profile.
- [ ] Cookie values never appear in logs.
- [ ] Invalid service/domain inputs fail closed.
