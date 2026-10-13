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
  mean under 0.5 ms and p99 under 2 ms, enforced by `bench/verify.bench.ts` (`bun run bench`,
  part of `bun run verify`). Any change to it re-runs the benchmark.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:kit`.
