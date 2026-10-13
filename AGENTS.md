# tula-closeline-kit

Closeline shared runtime helpers: token verification, queue port and adapters, logging, test fixtures

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

- `ErrorReporter.capture` with the no-op reporter (`src/reporting/noop.ts`) sits on every error
  path, and `scrubText` (`src/scrub.ts`) runs on every log message and error message. `capture` is
  an empty call and `scrubText` is O(message length), linear with a 32 KiB cap. Budgets in
  `bench/reporting.bench.ts`: no-op `capture` mean 0.001 ms, an ordinary message mean 0.005 ms and
  a message with secrets mean 0.015 ms, each with a median and best-batch p95 budget as above.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:kit`.
