/**
 * Minimal Server-Sent Events parser for server-side consumers of remote
 * streams (fork-owned, server-only).
 */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parse an SSE byte stream into events. Comments and heartbeats are skipped. */
export async function* parseSse(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n?/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseBlock(block);
      if (event) yield event;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}

/** Encode one SSE `data:` frame. */
export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
