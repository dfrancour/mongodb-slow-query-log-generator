#!/usr/bin/env bash
# Generate the slow-query log fixtures used by the Slow Query Explorer tests.
#
# Usage: src/test-fixtures/run.sh <version> [port]
#
# Runs workload.js against a throwaway mongod with --slowms 0 so every
# operation is logged, and writes output/<version>/standalone/ with
# slow-queries.jsonl (slow-query lines only) and mongod.log (everything,
# the source for a hand-picked mixed-messages.jsonl).
#
#   MONGOD=/opt/homebrew/opt/mongodb-community@6.0/bin/mongod \
#     src/test-fixtures/run.sh 6.0
set -euo pipefail

VERSION="${1:?version required, e.g. 6.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"

WORKLOAD="$HERE/workload.js" \
  "$HERE/../common/run-workload.sh" "$HERE/output/$VERSION/standalone" "${2:-27117}"
