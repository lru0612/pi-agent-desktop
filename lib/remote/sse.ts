/**
 * Minimal Server-Sent Events parser for server-side consumers of remote
 * streams (fork-owned, server-only).
 */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

// UTF-16 code units, including ignored fields/comments and line delimiters.
// Caps both an unterminated line and a frame made of many short lines.
export const MAX_SSE_FRAME_CHARS = 1024 * 1024;

/**
 * Parse SSE without depending on transport chunk boundaries. Oversized frames
 * throw (and close the source iterator); an incomplete frame at EOF is dropped.
 */
export async function* parseSse(
  chunks: AsyncIterable<Uint8Array | string>,
  { maxFrameChars = MAX_SSE_FRAME_CHARS }: { maxFrameChars?: number } = {},
): AsyncGenerator<SseEvent> {
  if (!Number.isSafeInteger(maxFrameChars) || maxFrameChars < 1) throw new RangeError("Invalid SSE frame limit");
  // Handle the one stream-leading BOM ourselves, including mixed input kinds.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let line = "";
  let frameChars = 0;
  let skipLF = false;
  let atStart = true;
  let eventType = "";
  let lastEventId: string | undefined;
  let data: string[] = [];

  function append(part: string, delimiter = false): void {
    frameChars += part.length + (delimiter ? 1 : 0);
    if (frameChars > maxFrameChars) throw new RangeError("SSE frame exceeds size limit");
    line += part;
  }

  function finishLine(): SseEvent | null {
    const valueLine = line;
    line = "";
    if (!valueLine) {
      const event = data.length ? { event: eventType || "message", data: data.join("\n"), id: lastEventId } : null;
      data = [];
      eventType = "";
      frameChars = 0;
      return event;
    }
    if (valueLine.startsWith(":")) return null;
    const colon = valueLine.indexOf(":");
    const field = colon < 0 ? valueLine : valueLine.slice(0, colon);
    let value = colon < 0 ? "" : valueLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventType = value;
    else if (field === "id" && !value.includes("\0")) lastEventId = value;
    return null;
  }

  function* consume(text: string): Generator<SseEvent> {
    if (atStart && text.length) {
      atStart = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (skipLF) {
        skipLF = false;
        if (char === "\n") {
          start = i + 1;
          continue;
        }
      }
      if (char !== "\r" && char !== "\n") continue;
      append(text.slice(start, i), true);
      const event = finishLine();
      skipLF = char === "\r";
      start = i + 1;
      if (event) yield event;
    }
    append(text.slice(start));
  }

  for await (const chunk of chunks) {
    // A string is already decoded. Flush pending bytes before switching input
    // kinds so a partial UTF-8 sequence cannot move past that string.
    const text = typeof chunk === "string"
      ? decoder.decode() + chunk
      : decoder.decode(chunk, { stream: true });
    yield* consume(text);
  }
  yield* consume(decoder.decode());
}

/** Encode one SSE `data:` frame. */
export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
