#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
exec node scripts/lock.mjs build serial
