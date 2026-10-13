# tula-closeline-kit

Closeline shared runtime helpers: token verification, queue, object storage and vector store ports and adapters, logging, test fixtures

Kind: **library**. Common standards for every Closeline repo are in `.claude/COMMON.md`, synced
from the hub (`tula-closeline`). This file holds only what is specific to this repo. Keep it under
200 lines: put detail in a path-scoped rule under `.claude/rules/` or a decision record in the hub.

## Commands

| Command | Use |
| --- | --- |
| `bun install` | install, including the tagged `tula-closeline-*` libraries |
| `bun run verify` | the full gate, exactly what CI runs |
| `bun run verify:changed` | the quick gate the Stop hook runs |
| `bun test` | tests |
| `bun run bench` | benchmark suite with budgets |

Other scripts are in `package.json`.

## Hot paths

- `TokenVerifier.verify` (`src/auth/verifier.ts`) runs on every request. It is O(token length) with
  one Ed25519 verification and a Map lookup, and does no I/O when the key is cached. Budget:
  mean under 0.5 ms, median under 0.25 ms and best-of-five-batches p95 under 0.4 ms, enforced by
  `bench/verify.bench.ts` (`bun run bench`, part of `bun run verify`). The median and the best
  batch are used instead of one p99 so a single scheduler stall cannot fail the check. The same
  file budgets the bad-signature path (mean 0.3 ms) and the middleware (mean 0.3 ms), each with
  the same median and tail budgets, about 5x what it measures. Any change to it re-runs the
  benchmark.

- `ErrorReporter.capture` sits on every error path, and `scrubText` (`src/scrub.ts`) runs on every
  log message and error message. With the no-op reporter (`src/reporting/noop.ts`) `capture` is an
  empty call. With the Sentry adapter (`src/reporting/sentry.ts`) it copies the error with bounds
  (8 KiB per message, six errors, 16 KiB of stack each), builds the event and scrubs it, all
  before returning: O(message length + frames) with those caps, about 0.08 ms. `scrubText` is
  O(message length), linear with a 32 KiB cap (about 0.6 ms at the cap). Budgets in
  `bench/reporting.bench.ts`: no-op `capture` mean 0.001 ms, Sentry `capture` mean 0.4 ms, an
  ordinary message mean 0.008 ms, a message with secrets mean 0.015 ms and a 32 KiB input mean
  3 ms and a 32 KiB input made only of `@` (the shape that made email masking quadratic) mean 3 ms,
  and a 32 KiB input of `tokens=1 ` repeated (a token count scanned to the end of the line at every
  pair, 82 ms) mean 6 ms,
  each with a median and best-batch p95 budget as above.

- The queue: `registry.encode` and `registry.decode` (`src/queue/envelope.ts`) run on every
  publish and every delivery (queue consumers are a hot path, ADR 0009). They are O(message size),
  at most 256 KiB because a longer body is refused before parsing. The memory adapter's publish and
  acknowledge are O(1) and its receive is O(messages stored), a scan that is fine for tests only;
  the SQS adapter is one HTTP call per operation. The consumer adds one claim, one renew per third
  of the visibility timeout while a handler runs, one complete, all O(1) against the store.
  Budgets in `bench/queue.bench.ts`, about five times the measured means: encode plus decode of an
  ordinary message mean 0.015 ms, decode of a 200 KiB message mean 0.15 ms, a memory publish,
  receive and acknowledge mean 0.02 ms and a whole consumer cycle on the memory adapters mean
  0.07 ms, each with a median and best-batch p95 budget as above.

- The object and vector stores (`src/storage/`, `src/vector/`) are used on the playbook's ingestion
  and live-search paths. Every operation validates the Organization id and key or vector first
  (O(key length) and O(dimensions)), then makes one call: the S3 adapter is one HTTP request, a
  list is O(page) with a page of at most 1,000, and `search` takes a `topK` of at most 100. The
  memory adapters are for tests: object put plus get of 4 KiB mean 0.012 ms, a 100-item list of
  1,000 objects mean 0.16 ms, a 10-vector upsert at 384 dimensions mean 0.33 ms and a search of
  1,000 such vectors mean 2.7 ms, each with a median and best-batch p95 budget in
  `bench/stores.bench.ts`, about five times what it measures.

- `prepareFields` / `redactFields` (`src/redact.ts`) copy the fields of every log line. O(fields +
  objects walked + text emitted), bounded in counts by 5,000 shared objects and 20,000 shared nested
  values plus 50 objects and 200 values per top-level field, and 200 Errors scrubbed per entry (the rest are `[truncated]` unread), and in text by 1 MiB of UTF-16 code
  units plus 1 KiB per top-level field (a string is cut at 16 KiB, a key at 256): the serialised
  entry is under 12 MB worst case (control characters) and about 2 MB for ordinary text. Budgets in
  `bench/redact.bench.ts`: a typical entry, an oversized one (a field that spends the shared budget,
  then 40 small objects) and the worst case (200 fields at their allowance, plus long strings that
  hit the text budget) and 200 fields of 100 Errors with 30,000 character texts, each with a mean, median and best-batch p95 budget about five times what it
  measures.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:kit`.
