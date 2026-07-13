/**
 * Shared helper for multipart uploads. Normalizes the broad SDK
 * `AudioInput` union into a single `Blob` suitable for
 * `FormData.append`. Extracted so the transcriptions + voices (clone)
 * endpoints use identical input-coercion rules — a future multipart
 * endpoint can import this helper instead of re-rolling it.
 */

import { HakimError } from '../errors.js';
import type { AudioInput } from '../types.js';

export async function audioInputToBlob(input: AudioInput, filename: string): Promise<Blob> {
  if (isBlobLike(input)) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Blob([toFixedArrayBuffer(new Uint8Array(input))]);
  }

  if (ArrayBuffer.isView(input)) {
    return new Blob([toFixedArrayBuffer(input)]);
  }

  if (isReadableStream(input)) {
    const parts: ArrayBuffer[] = [];
    for await (const raw of input) {
      const chunk: unknown = raw;
      if (chunk instanceof Uint8Array) {
        parts.push(toFixedArrayBuffer(chunk));
      } else if (typeof chunk === 'string') {
        parts.push(toFixedArrayBuffer(new TextEncoder().encode(chunk)));
      } else if (chunk instanceof ArrayBuffer) {
        parts.push(chunk);
      } else if (ArrayBuffer.isView(chunk)) {
        parts.push(toFixedArrayBuffer(chunk));
      } else {
        throw new HakimError({
          type: 'invalid_request_error',
          code: 'invalid_audio_chunk',
          message: `Hakim SDK: unsupported chunk type in stream (${typeof chunk}).`,
          status: 400,
          requestId: undefined,
        });
      }
    }
    return new Blob(parts);
  }

  throw new HakimError({
    type: 'invalid_request_error',
    code: 'invalid_audio_input',
    message: `Hakim SDK: unsupported file input type (${typeof input}). Pass a Blob, Buffer, Uint8Array, ArrayBuffer, or Node ReadableStream. (filename=${filename})`,
    status: 400,
    requestId: undefined,
  });
}

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as { pipe?: unknown; readable?: unknown; [Symbol.asyncIterator]?: unknown };
  return typeof maybe.pipe === 'function' || typeof maybe[Symbol.asyncIterator] === 'function';
}

function isBlobLike(value: unknown): value is Blob {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as {
    arrayBuffer?: unknown;
    stream?: unknown;
    slice?: unknown;
    size?: unknown;
    type?: unknown;
  };
  return (
    typeof maybe.arrayBuffer === 'function' &&
    typeof maybe.slice === 'function' &&
    typeof maybe.size === 'number'
  );
}

/** Normalize a TypedArray/view to a plain `ArrayBuffer` (not
 *  `ArrayBufferLike`, which would include `SharedArrayBuffer`). Keeps
 *  us compatible with the global `Blob` constructor's DOM types under
 *  TypeScript 5.7+, which tightened up `BlobPart`. */
function toFixedArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return out;
}
