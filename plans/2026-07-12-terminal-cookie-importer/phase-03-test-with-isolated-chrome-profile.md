---
phase: 3
title: Test with isolated Chrome profile
status: completed
priority: P1
dependencies:
  - 2
---

# Phase 3: Test with isolated Chrome profile

## Overview

Verify syntax, unit behavior, export integration, and a real Chrome/CDP import.

## Implementation Steps

1. Test cookie normalization and domain rejection using temporary fixtures.
2. Test CLI help and bad service handling.
3. Run both export scripts in temporary output directories.
4. Launch isolated Chrome, import a service, and verify stored cookies via CDP.
5. Confirm the default Chrome profile is untouched and no secret values are logged.

## Success Criteria

- [ ] Shell and Node syntax checks pass.
- [ ] Focused regression tests pass.
- [ ] Real Chrome stores the expected cookie names and attributes.
- [ ] Documentation matches observed commands.
