const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * One piece of synthesised speech, in order. The audio is held in a private field, so it is not in
 * `JSON.stringify`, a spread, `String()`, a log line or a console dump; only the sequence number
 * and the byte count are. Read the bytes with {@link TtsAudioChunk.audio}.
 */
export class TtsAudioChunk {
  /** The position in the stream, from 0, rising by 1 with no gaps. */
  readonly sequence: number
  /** The size of the audio in bytes. */
  readonly byteLength: number
  readonly #audio: Uint8Array

  constructor(sequence: number, audio: Uint8Array) {
    this.sequence = sequence
    this.byteLength = audio.byteLength
    this.#audio = audio
  }

  /** The audio bytes in the format the stream was opened with; not copied, so do not change them. */
  get audio(): Uint8Array {
    return this.#audio
  }

  /** The metadata, for `JSON.stringify`. */
  toJSON(): { sequence: number; byteLength: number } {
    return { sequence: this.sequence, byteLength: this.byteLength }
  }

  /** A readable label without the audio. */
  toString(): string {
    return `TtsAudioChunk(#${this.sequence}, ${this.byteLength} bytes)`
  }

  /** The console and `util.inspect` form, without the audio. */
  [INSPECT](): string {
    return this.toString()
  }
}
