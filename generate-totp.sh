#!/usr/bin/env bash
# Wrapper → scripts/generate-totp.sh
exec "$(cd "$(dirname "$0")" && pwd)/scripts/generate-totp.sh" "$@"
