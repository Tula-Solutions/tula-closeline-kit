import {
  createFixedClock2,
  prepareFields
} from "./shared/chunk-67sxzn8d.js";

// src/testing.ts
function build(entries, bound) {
  const record = (level) => (message, fields) => {
    entries.push({ level, message, fields: { ...bound, ...prepareFields(fields) } });
  };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: (fields) => build(entries, { ...bound, ...prepareFields(fields) })
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
