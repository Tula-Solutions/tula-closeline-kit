import {
  createFixedClock2,
  redactFields
} from "./shared/chunk-279hrqks.js";

// src/testing.ts
function build(entries, bound) {
  const record = (level) => (message, fields) => {
    entries.push({ level, message, fields: { ...bound, ...redactFields(fields ?? {}) } });
  };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: (fields) => build(entries, { ...bound, ...redactFields(fields) })
  };
}
function createMemoryLogger() {
  return build([], {});
}
function createTestDeps(overrides = {}) {
  return {
    clock: overrides.clock ?? createFixedClock2("2026-01-01T00:00:00.000Z"),
    logger: overrides.logger ?? createMemoryLogger()
  };
}
export {
  createMemoryLogger,
  createTestDeps
};
