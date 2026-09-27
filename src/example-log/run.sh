#!/usr/bin/env bash
# Generate the example log that mongodb-paste-the-plan serves at
# /examples/slow-query-log.jsonl.
#
# Runs workload.js against a mongod with a deliberately small WiredTiger
# cache, so reads spill to storage the way they do on a busy production
# node. The server runs at its default slow threshold (100 ms), and the
# workload raises it while seeding, so only genuinely slow operations are
# kept.
#
# Use an 8.x mongod so the log carries workingMillis, queues and storage
# metrics:
#   MONGOD=/opt/homebrew/opt/mongodb-community@8.0/bin/mongod \
#     src/example-log/run.sh
#
# Output: output/slow-query-log.jsonl. Copy it to
# mongodb-paste-the-plan/public/examples/slow-query-log.jsonl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

WORKLOAD="$HERE/workload.js" \
SLOWMS=100 \
MONGOD_ARGS="${MONGOD_ARGS:---wiredTigerCacheSizeGB 0.25}" \
  "$HERE/../common/run-workload.sh" "$WORK" "${1:-27118}"
mkdir -p "$HERE/output"
cp "$WORK/slow-queries.jsonl" "$HERE/output/slow-query-log.jsonl"
echo "example log written to $HERE/output/slow-query-log.jsonl"
