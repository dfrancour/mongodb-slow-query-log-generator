# MongoDB Slow Query Log Generator

Generates real MongoDB "Slow query" log lines by running mongosh workloads
against a throwaway local `mongod`. Two generators serve different purposes:

| Generator | Threshold | Server | Use Case |
|---|---|---|---|
| **Example Log** | 100 ms (server default) | 8.x | The example log served by [mongodb-paste-the-plan](https://github.com/dfrancour/mongodb-paste-the-plan)'s Slow Query Explorer |
| **Test Fixtures** | 0 ms (every operation) | any | Parser and analyzer tests in the same repo |

Data is synthetic in both. Nothing here contains real records.

## Example Log

A multi-tenant helpdesk SaaS plays out over a few minutes: several services
talk to the database under their own `appName`, one tenant is far larger
than the rest, and dashboards, scheduled jobs, reporting, an index build and
an ad-hoc shell session produce the operations that cross the threshold.
The workload raises the threshold while seeding, so only the traffic phase
is logged, and the server runs with a small WiredTiger cache so reads hit
storage.

```bash
MONGOD=/opt/homebrew/opt/mongodb-community@8.0/bin/mongod ./src/example-log/run.sh
```

Output: `src/example-log/output/slow-query-log.jsonl`. Copy it to
`mongodb-paste-the-plan/public/examples/slow-query-log.jsonl`; that repo's
`exampleLog.test.ts` checks it loads cleanly and holds nothing under 100 ms.

To iterate on the traffic phase without reseeding, keep a `mongod` running
and replay against it:

```bash
WORKLOAD_SKIP_SEED=1 WORKLOAD_PORT=27119 mongosh --port 27119 src/example-log/workload.js
```

Seeding writes about 600 MB and takes a few minutes. Things an 8.x server
does and does not emit locally:

- `getMore` lines appear only when one batch alone is slow; the workload
  uses a small `batchSize` with an unindexed `$lookup` for that.
- A very large `$in` is clipped to fit the 10 KB log line, with no
  `truncated` marker.
- `usedDisk` needs a `$group` that pushes whole documents over the whole
  collection.
- `cpuNanos` is not emitted on macOS. Queue waits and write conflicts need
  concurrent clients, which a single mongosh session does not provide.

## Test Fixtures

A smaller shop workload (orders, customers, events) that exercises every
operation type and plan shape the parser must handle: indexed and unindexed
reads, covered queries, in-memory sorts, cursor batches, aggregations,
counts, distinct, every write command, a truncated command and a replan
trigger.

```bash
MONGOD=/opt/homebrew/opt/mongodb-community@6.0/bin/mongod ./src/test-fixtures/run.sh 6.0
```

Output: `src/test-fixtures/output/<version>/standalone/` with
`slow-queries.jsonl` (slow-query lines only) and `mongod.log` (everything).
`mixed-messages.jsonl` is a hand-picked slice of `mongod.log` that
interleaves other messages for skip-and-report tests. Copy the `.jsonl`
files to `mongodb-paste-the-plan/src/test-utils/fixtures/slow-query-logs/<version>/standalone/`.

## Requirements

- `mongod` and `mongosh`. Homebrew's versioned formulas work:
  `mongodb-community@6.0`, `@7.0`, `@8.0`. Pass the binary as `MONGOD=`;
  the default is `mongod` on `PATH`.
- Free ports 27117 (test fixtures) and 27118 (example log), or pass another
  as the last argument.
- About 1 GB of free disk for the example log's seed.

`mongod` 8.x on macOS refuses `--fork`, so the runner backgrounds the
process itself and waits for the port.

## Project Structure

```
src/
  common/
    run-workload.sh     # Throwaway mongod + workload → slow-queries.jsonl, mongod.log
  example-log/
    workload.js         # Multi-tenant helpdesk traffic, 100 ms threshold
    run.sh              # Shell wrapper
    output/             # Generated example log
  test-fixtures/
    workload.js         # Shop workload, every operation logged
    run.sh              # Shell wrapper
    output/             # Generated fixtures per server version
```

Runner knobs, all environment variables: `WORKLOAD` (script to run),
`SLOWMS` (server threshold, default 0), `MONGOD` (binary), `MONGOD_ARGS`
(extra flags such as `--wiredTigerCacheSizeGB 0.25`).
