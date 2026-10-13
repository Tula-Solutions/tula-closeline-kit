import type { AnyEnvelope, InvalidReason } from './envelope'
import { QUEUE_ERROR_CODES, QueueError } from './errors'

/** Opaque handle for one delivery of a message; pass it back to acknowledge or change visibility. */
export type Receipt = string

/** The largest batch SQS takes or gives. */
export const MAX_BATCH_SIZE = 10

/** The longest long-poll wait SQS allows, in seconds. */
export const MAX_WAIT_SECONDS = 20

/** The longest visibility timeout SQS allows, in seconds (12 hours). */
export const MAX_VISIBILITY_SECONDS = 43_200

/** A message that arrived and passed validation. */
export interface ValidDelivery<E> {
  kind: 'message'
  /** The validated envelope. */
  envelope: E
  /** Handle for acknowledging this delivery. */
  receipt: Receipt
  /** How many times the queue has handed this message out, this delivery included (1 on the first). */
  receiveCount: number
}

/**
 * A message that arrived but is not one this service accepts: not JSON, an unknown type, a
 * different version, a wrong scope or a payload that fails its schema. It is handed to the caller
 * rather than dropped, so it can be logged, reported and left to reach the dead-letter queue. It
 * carries no body: only the reason, field paths and the envelope id when one could be read.
 */
export interface InvalidDelivery {
  kind: 'invalid'
  /** Why it was rejected. */
  reason: InvalidReason
  /** Field paths and codes of what failed; never values. */
  issues: string[]
  /** The envelope's id, when the body had one. */
  messageId?: string
  /** Handle for acknowledging, or delaying, this delivery. */
  receipt: Receipt
  /** How many times the queue has handed this message out. */
  receiveCount: number
}

/** One thing {@link Queue.receive} returns. */
export type Delivery<E> = ValidDelivery<E> | InvalidDelivery

/** What {@link Queue.receive} is asked for. */
export interface ReceiveOptions {
  /** How many messages at most, 1 to 10. */
  maxMessages: number
  /** How long the messages stay hidden from other receivers, in seconds, 0 to 43200. */
  visibilityTimeoutSeconds: number
  /** How long to wait for a message when the queue is empty (long poll), in seconds, 0 to 20. */
  waitSeconds: number
  /** Ends the wait early; the call then returns an empty list. */
  signal?: AbortSignal
}

/** What {@link Queue.publishBatch} reports for one message that was not accepted. */
export interface BatchFailure {
  /** The envelope id. */
  id: string
  /** The queue's error code, such as `InternalError` or `ServiceUnavailable`. */
  code: string
  /** True when the failure is the sender's fault (retrying the same message will not help). */
  senderFault: boolean
}

/** The outcome of a batch publish: which envelope ids were accepted and which were not. */
export interface BatchResult {
  /** Ids of the envelopes the queue accepted, in input order. */
  sent: string[]
  /** The ones it did not; the caller retries these (the same envelope, so the id is stable). */
  failed: BatchFailure[]
}

/**
 * A queue of typed messages. Delivery is at-least-once and unordered: a message can be handed out
 * more than once (a consumer that is slow, crashes, or a duplicate in the queue itself) and two
 * messages can arrive in either order, so a handler must be idempotent (see
 * {@link createConsumer}). An envelope is validated against the registry on the way in and on the
 * way out. The queue holds the message until it is acknowledged; after the queue's
 * `maxReceiveCount` deliveries it moves to the dead-letter queue instead of being delivered again.
 */
export interface Queue<E extends AnyEnvelope = AnyEnvelope> {
  /**
   * Sends one message. Resolves when the queue has accepted it. Throws a QueueError: invalid
   * message, message too large, or unavailable (after the adapter's bounded, jittered retries).
   * A retry after an `unavailable` error can leave two copies in the queue with the same envelope
   * id; the idempotent consumer drops the second. O(message size).
   */
  publish(envelope: E): Promise<void>
  /**
   * Sends up to 10 messages (and up to 256 KiB in total) in one call. Everything is validated
   * before anything is sent. A message the queue refuses comes back in `failed`; the call throws
   * only when the whole request fails. O(total size).
   */
  publishBatch(envelopes: readonly E[]): Promise<BatchResult>
  /**
   * Receives up to `maxMessages` messages and hides them for `visibilityTimeoutSeconds`. With
   * `waitSeconds` above 0 it waits that long for a message when the queue is empty. Messages that
   * are not valid come back as `kind: 'invalid'`. O(batch size).
   */
  receive(options: ReceiveOptions): Promise<Delivery<E>[]>
  /**
   * Removes the message for good. Safe to call twice and for a delivery that was already
   * redelivered: it resolves either way.
   */
  acknowledge(receipt: Receipt): Promise<void>
  /**
   * Hides the message for `seconds` more from now (a lease extension, or a delay before retry).
   * Throws a QueueError `queue.receipt_invalid` when the message is no longer in flight.
   */
  extendVisibility(receipt: Receipt, seconds: number): Promise<void>
  /** Makes the message visible again at once, so another receive gets it. Same errors as extendVisibility. */
  release(receipt: Receipt): Promise<void>
}

/** Throws the QueueError for a `receive` call whose numbers are out of range. */
export function assertReceiveOptions(options: ReceiveOptions): void {
  const { maxMessages, visibilityTimeoutSeconds, waitSeconds } = options
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_BATCH_SIZE) {
    throw new QueueError(QUEUE_ERROR_CODES.invalidRequest, 'maxMessages must be 1 to 10')
  }
  assertVisibility(visibilityTimeoutSeconds)
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
    throw new QueueError(QUEUE_ERROR_CODES.invalidRequest, 'waitSeconds must be 0 to 20')
  }
}

/** Throws the QueueError for a visibility timeout outside 0 to 43200 whole seconds. */
export function assertVisibility(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_VISIBILITY_SECONDS) {
    throw new QueueError(
      QUEUE_ERROR_CODES.invalidRequest,
      'visibility timeout must be 0 to 43200 whole seconds'
    )
  }
}

/** Throws the QueueError for a batch of 0 or more than 10 messages. */
export function assertBatchCount(count: number): void {
  if (count < 1 || count > MAX_BATCH_SIZE) {
    throw new QueueError(QUEUE_ERROR_CODES.batchTooLarge, 'a batch holds 1 to 10 messages', {
      details: { count },
    })
  }
}
