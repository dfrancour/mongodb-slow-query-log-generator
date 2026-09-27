#!/usr/bin/env bash
# Run a mongosh workload against a throwaway local mongod and keep its log.
#
# Usage: WORKLOAD=<script.js> src/common/run-workload.sh <output-dir> [port]
#
# Requires mongod and mongosh. Starts a throwaway mongod with --slowms 0 by
# default so every operation is logged, runs the workload script, then
# extracts the "Slow query" lines into <output-dir>/slow-queries.jsonl and
# keeps the raw log as <output-dir>/mongod.log.
#
# Environment:
#   WORKLOAD     mongosh script to run (required)
#   SLOWMS       slow threshold the server starts with (default: 0)
#   MONGOD       mongod binary (default: mongod on PATH)
#   MONGOD_ARGS  extra mongod flags, e.g. "--wiredTigerCacheSizeGB 0.25"
set -euo pipefail

OUT="${1:?output directory required}"
PORT="${2:-27117}"
WORKLOAD="${WORKLOAD:?WORKLOAD script required}"
MONGOD="${MONGOD:-mongod}"
SLOWMS="${SLOWMS:-0}"
WORK="$(mktemp -d)"
mkdir -p "$OUT" "$WORK/db"

# shellcheck disable=SC2086 # MONGOD_ARGS is intentionally word-split
"$MONGOD" --dbpath "$WORK/db" --logpath "$WORK/mongod.log" --port "$PORT" \
  --bind_ip 127.0.0.1 --slowms "$SLOWMS" ${MONGOD_ARGS:-} >/dev/null &
MONGOD_PID=$!
trap 'mongosh --quiet --port "$PORT" --eval "db.getSiblingDB(\"admin\").shutdownServer()" >/dev/null 2>&1 || true; wait "$MONGOD_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 60); do
  mongosh --quiet --port "$PORT" --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1 && break
  sleep 0.5
done

WORKLOAD_PORT="$PORT" mongosh --quiet --port "$PORT" "$WORKLOAD"

VERSION="$(mongosh --quiet --port "$PORT" --eval 'db.version()')"
grep '"msg":"Slow query"' "$WORK/mongod.log" \
  | grep -v '"ns":"admin\.\|"ns":"config\.\|"ns":"local\.' \
  > "$OUT/slow-queries.jsonl"
cp "$WORK/mongod.log" "$OUT/mongod.log"
echo "mongod $VERSION: $(wc -l < "$OUT/slow-queries.jsonl") slow query entries written to $OUT"
