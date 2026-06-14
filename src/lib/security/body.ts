// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * Bounded body reader: stream a `Response` body up to a byte cap, refusing an over-cap declared
 * `Content-Length` up front and aborting mid-stream if the cap is exceeded.
 *
 * VENDORED from prod-solid-server `packages/guarded-fetch/src/body.ts` (docs/DESIGN.md §5), with an
 * added `readBoundedBytes` variant (some RDF parsers want raw bytes). Each caller wraps
 * {@link BodyTooLargeError} in its own domain error.
 */

/** Raised when a response body exceeds the byte cap (declared or streamed). */
export class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

export interface ReadBoundedOptions {
  /** Maximum body size in bytes. */
  readonly maxBytes: number;
  /**
   * Optional AbortController to `.abort()` when the cap is exceeded — guardedFetch shares one
   * controller across the whole fetch (request + redirects + body) so an over-cap body also tears
   * down the in-flight request. When omitted the reader cancels its own stream reader.
   */
  readonly controller?: AbortController;
}

/** Stream `res.body` enforcing `maxBytes`, returning the raw bytes. Up-front rejects over-cap
 * `Content-Length`; aborts on overflow. An absent body returns an empty `Uint8Array`. */
export async function readBoundedBytes(
  res: Response,
  opts: ReadBoundedOptions
): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (!Number.isNaN(declared) && declared > opts.maxBytes) {
    opts.controller?.abort();
    throw new BodyTooLargeError(
      `Body exceeds cap (Content-Length ${declared} > ${opts.maxBytes}).`
    );
  }
  const body = res.body;
  if (!body) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > opts.maxBytes) {
          if (opts.controller) {
            opts.controller.abort();
          } else {
            void reader.cancel();
          }
          throw new BodyTooLargeError(
            `Body exceeds cap (${total} bytes > ${opts.maxBytes}).`
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or stream errored — fine.
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Read `res.body` as UTF-8 text, enforcing `maxBytes`. Up-front rejects an over-cap
 * `Content-Length`. Streams and aborts on overflow. An absent body returns `""`.
 */
export async function readBoundedText(
  res: Response,
  opts: ReadBoundedOptions
): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (!Number.isNaN(declared) && declared > opts.maxBytes) {
    opts.controller?.abort();
    throw new BodyTooLargeError(
      `Body exceeds cap (Content-Length ${declared} > ${opts.maxBytes}).`
    );
  }
  const body = res.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > opts.maxBytes) {
          if (opts.controller) {
            opts.controller.abort();
          } else {
            void reader.cancel();
          }
          throw new BodyTooLargeError(
            `Body exceeds cap (${total} bytes > ${opts.maxBytes}).`
          );
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or stream errored — fine.
    }
  }
  return chunks.join("");
}
