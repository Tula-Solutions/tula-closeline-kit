import {
  AppError2
} from "./chunk-tya44yhr.js";

// src/clock.ts
var UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
var DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
function isUnit(unit) {
  return unit !== undefined && unit in UNIT_MS;
}
var systemClock2 = {
  now: () => new Date
};
function createFixedClock2(start) {
  let current = new Date(start).getTime();
  if (Number.isNaN(current)) {
    throw new TypeError(`createFixedClock needs a valid start time, got ${String(start)}`);
  }
  return {
    now: () => new Date(current),
    advance(duration) {
      const match = DURATION_PATTERN.exec(duration);
      const amount = match?.[1];
      const unit = match?.[2];
      if (amount === undefined || !isUnit(unit)) {
        throw new TypeError(`Invalid duration ${JSON.stringify(duration)}: use a whole number and ms, s, m, h or d`);
      }
      current += Number(amount) * UNIT_MS[unit];
    }
  };
}

// src/queue/errors.ts
var QUEUE_ERROR_CODES2 = {
  invalidMessage: "queue.invalid_message",
  messageTooLarge: "queue.message_too_large",
  batchTooLarge: "queue.batch_too_large",
  invalidRequest: "queue.invalid_request",
  receiptInvalid: "queue.receipt_invalid",
  rejected: "queue.rejected",
  unavailable: "queue.unavailable",
  badResponse: "queue.bad_response"
};
var STATUS = {
  "queue.invalid_message": 422,
  "queue.message_too_large": 413,
  "queue.batch_too_large": 413,
  "queue.invalid_request": 400,
  "queue.receipt_invalid": 409,
  "queue.rejected": 500,
  "queue.unavailable": 503,
  "queue.bad_response": 502
};

class QueueError2 extends AppError2 {
  constructor(code, message, options = {}) {
    super({
      code,
      status: STATUS[code],
      message,
      ...options.cause === undefined ? {} : { cause: options.cause },
      ...options.details === undefined ? {} : { details: options.details }
    });
    this.name = "QueueError";
  }
}

// src/queue/envelope.ts
import { organizationIdSchema as contractOrganizationIdSchema } from "tula-closeline-contract";
import { z } from "zod";
var MAX_MESSAGE_BYTES2 = 262144;
var TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
function defineMessage2(definition) {
  if (!TYPE_PATTERN.test(definition.type)) {
    throw new TypeError(`message type must look like "area.event_name", got "${definition.type}"`);
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new TypeError(`message version must be a positive integer, got ${definition.version}`);
  }
  const seen = new Set([definition.version]);
  for (const older of definition.previous ?? []) {
    if (!Number.isInteger(older.version) || older.version < 1 || seen.has(older.version)) {
      throw new TypeError(`previous version ${older.version} is invalid or repeated`);
    }
    seen.add(older.version);
  }
  return Object.freeze({ ...definition });
}
var INVALID_REASONS2 = [
  "malformed",
  "unknown_type",
  "unsupported_version",
  "invalid_scope",
  "invalid_payload"
];
var ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
var envelopeSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  type: z.string().min(1).max(128),
  version: z.number().int().min(1),
  occurredAt: z.iso.datetime(),
  organizationId: z.string().min(1).max(128).optional(),
  traceId: z.string().regex(ID_PATTERN),
  payload: z.unknown()
});
var WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch"
]);
function defOf(schema) {
  return schema._zod.def;
}
function unwrap(schema, depth = 0) {
  if (depth > 20) {
    return;
  }
  const def = defOf(schema);
  if (def.type !== undefined && WRAPPERS.has(def.type) && def.innerType !== undefined) {
    return unwrap(def.innerType, depth + 1);
  }
  if (def.type === "pipe" && def.in !== undefined) {
    return unwrap(def.in, depth + 1);
  }
  if (def.type === "lazy" && def.getter !== undefined) {
    return unwrap(def.getter(), depth + 1);
  }
  return schema;
}
function step(schema, segment) {
  const node = schema === undefined ? undefined : unwrap(schema);
  const def = node === undefined ? undefined : defOf(node);
  if (def?.type === "object" && def.shape !== undefined) {
    if (typeof segment === "string" && Object.hasOwn(def.shape, segment)) {
      return [segment, def.shape[segment]];
    }
    return ["*", undefined];
  }
  if (def?.type === "array" && typeof segment === "number") {
    return ["*", def.element];
  }
  if (def?.type === "tuple" && typeof segment === "number") {
    return ["*", def.items?.[segment] ?? def.rest ?? undefined];
  }
  return ["*", undefined];
}
function issuesOf(error, schema) {
  return error.issues.slice(0, 20).map((issue) => {
    let at = schema;
    const path = issue.path.map((segment) => {
      const [shown, next] = step(at, segment);
      at = next;
      return shown;
    }).join(".");
    return `${path || "(root)"}: ${issue.code}`;
  });
}
function invalid(reason, issues) {
  return new QueueError2(QUEUE_ERROR_CODES2.invalidMessage, `message is not valid: ${reason}`, {
    details: { reason, issues }
  });
}
function createMessageRegistry2(definitions, options = {}) {
  const byType = new Map;
  for (const definition of definitions) {
    if (byType.has(definition.type)) {
      throw new TypeError(`message type ${definition.type} is defined twice`);
    }
    byType.set(definition.type, definition);
  }
  const clock = options.clock ?? systemClock2;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const orgSchema = options.organizationIdSchema ?? contractOrganizationIdSchema;
  function check(candidate) {
    const shape = envelopeSchema.safeParse(candidate);
    if (!shape.success) {
      const id = typeof candidate === "object" && candidate !== null && "id" in candidate ? candidate.id : undefined;
      return {
        ok: false,
        reason: "malformed",
        issues: issuesOf(shape.error, envelopeSchema),
        ...typeof id === "string" && ID_PATTERN.test(id) ? { messageId: id } : {}
      };
    }
    const value = shape.data;
    const base = { messageId: value.id };
    const definition = byType.get(value.type);
    if (definition === undefined) {
      return {
        ok: false,
        reason: "unknown_type",
        issues: [`type: unknown, ${value.type.length} characters`],
        ...base
      };
    }
    const older = value.version === definition.version ? undefined : definition.previous?.find((entry) => entry.version === value.version);
    if (value.version !== definition.version && older === undefined) {
      return {
        ok: false,
        reason: "unsupported_version",
        issues: [`version: ${value.version}, accepted ${definition.version}`],
        ...base
      };
    }
    if (definition.scope === "organization") {
      if (value.organizationId === undefined) {
        return { ok: false, reason: "invalid_scope", issues: ["organizationId: required"], ...base };
      }
      if (!orgSchema.safeParse(value.organizationId).success) {
        return { ok: false, reason: "invalid_scope", issues: ["organizationId: invalid"], ...base };
      }
    } else if (value.organizationId !== undefined) {
      return {
        ok: false,
        reason: "invalid_scope",
        issues: ["organizationId: not allowed"],
        ...base
      };
    }
    const payloadSchema = older?.payload ?? definition.payload;
    const payload = payloadSchema.safeParse(value.payload);
    if (!payload.success) {
      return {
        ok: false,
        reason: "invalid_payload",
        issues: issuesOf(payload.error, payloadSchema),
        ...base
      };
    }
    let current = payload;
    if (older !== undefined) {
      try {
        current = definition.payload.safeParse(older.upcast(payload.data));
      } catch {
        return { ok: false, reason: "invalid_payload", issues: ["upcast: failed"], ...base };
      }
      if (!current.success) {
        return {
          ok: false,
          reason: "invalid_payload",
          issues: issuesOf(current.error, definition.payload),
          ...base
        };
      }
    }
    const envelope = {
      id: value.id,
      type: value.type,
      version: definition.version,
      occurredAt: value.occurredAt,
      traceId: value.traceId,
      payload: current.data
    };
    if (value.organizationId !== undefined) {
      envelope.organizationId = value.organizationId;
    }
    return { ok: true, envelope };
  }
  return {
    definitions: byType,
    create(input) {
      const request = input;
      const definition = byType.get(request.type);
      if (definition === undefined) {
        throw invalid("unknown_type", [`type: ${String(request.type).slice(0, 64)}`]);
      }
      const envelope = {
        id: request.id ?? newId(),
        type: definition.type,
        version: definition.version,
        occurredAt: (request.occurredAt ?? clock.now()).toISOString(),
        traceId: request.traceId,
        payload: definition.payload.parse(request.payload)
      };
      if (request.organizationId !== undefined) {
        envelope.organizationId = request.organizationId;
      }
      const result = check(envelope);
      if (!result.ok) {
        throw invalid(result.reason, result.issues);
      }
      return result.envelope;
    },
    encode(envelope) {
      const result = check(envelope);
      if (!result.ok) {
        throw invalid(result.reason, result.issues);
      }
      return JSON.stringify(result.envelope);
    },
    decode(body) {
      if (body.length > MAX_MESSAGE_BYTES2) {
        return { ok: false, reason: "malformed", issues: ["body: too large"] };
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { ok: false, reason: "malformed", issues: ["body: not JSON"] };
      }
      return check(parsed);
    }
  };
}

export { systemClock2, createFixedClock2, QUEUE_ERROR_CODES2, QueueError2, MAX_MESSAGE_BYTES2, defineMessage2, INVALID_REASONS2, createMessageRegistry2 };
