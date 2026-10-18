import assert from "node:assert/strict";
import test from "node:test";

import { parseSse } from "./sse.ts";

async function collect(chunks) {
  const events = [];
  for await (const event of parseSse((async function* () { yield* chunks; })())) events.push(event);
  return events;
}

test("SSE frames split across chunks are reassembled", async () => {
  const events = await collect([
    ":\n\n",
    "data: {\"type\":\"run",
    "ning\",\"runningSessionIds\":[]}\n\nid: 7\nevent: output\ndata: a\ndata: b\n\n",
    "data: tail-without-terminator",
  ]);
  assert.deepEqual(events, [
    { event: "message", data: "{\"type\":\"running\",\"runningSessionIds\":[]}", id: undefined },
    { event: "output", data: "a\nb", id: "7" },
  ]);
});

test("CRLF line endings and byte chunks are accepted", async () => {
  const encoder = new TextEncoder();
  const events = await collect([encoder.encode("data: x\r\n\r\ndata: é"), encoder.encode("\n\n")]);
  assert.deepEqual(events.map((event) => event.data), ["x", "é"]);
});
