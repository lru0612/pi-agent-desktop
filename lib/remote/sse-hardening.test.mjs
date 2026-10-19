import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { MAX_SSE_FRAME_CHARS, parseSse, sseFrame } from "./sse.ts";

async function collect(chunks, options) {
  return Array.fromAsync(parseSse((async function* () { yield* chunks; })(), options));
}

test("every CRLF/UTF-8 byte split gives the same multiline SSE frames", async () => {
  const bytes = Buffer.from("\uFEFF: hello\r\nid: 7\r\nevent: output\r\ndata: 中文😀é\r\ndata: two\r\n\r\ndata: next\r\n\r\n");
  const expected = [
    { event: "output", data: "中文😀é\ntwo", id: "7" },
    { event: "message", data: "next", id: "7" },
  ];
  for (let i = 0; i <= bytes.length; i++) {
    assert.deepEqual(await collect([bytes.subarray(0, i), bytes.subarray(i)]), expected, `byte split ${i}`);
  }
  assert.deepEqual(await collect([...bytes].map((byte) => Uint8Array.of(byte))), expected);
});

test("split CRLF does not inject a blank line or dispatch before the frame ends", async () => {
  assert.deepEqual(await collect(["data: one\r", "\ndata: two\r", "\n\r", "\n"]), [
    { event: "message", data: "one\ntwo", id: undefined },
  ]);
  assert.deepEqual(await collect(["data: one\r", "\ndata: unfinished"]), []);
  assert.deepEqual(await collect(["data: one\r", "\r", "data: two\n\n"]), [
    { event: "message", data: "one", id: undefined },
    { event: "message", data: "two", id: undefined },
  ]);
});

test("SSE field rules: empty event/data, last ID, NUL IDs and one leading space", async () => {
  assert.deepEqual(await collect([
    "\uFEFFid: saved\n\nevent:\ndata\n\n",
    "id: bad\0id\ndata:  two spaces\nignored: x\n\n",
    "id\ndata: reset\n\n",
    "event: unused\n\ndata: normal\n\n",
    "data: unfinished",
  ]), [
    { event: "message", data: "", id: "saved" },
    { event: "message", data: " two spaces", id: "saved" },
    { event: "message", data: "reset", id: "" },
    { event: "message", data: "normal", id: "" },
  ]);
});

test("bounded frames include ignored lines and comments, even across chunks", async () => {
  for (const chunks of [
    ["data: " + "x".repeat(40)],
    Array(40).fill("x"),
    Array(40).fill(":x\n"),
    Array(40).fill("ignored: x\n"),
    Array(40).fill("data: x\n"),
  ]) await assert.rejects(collect(chunks, { maxFrameChars: 32 }), /SSE frame exceeds/);
  assert.equal((await collect(Array(100).fill("data: x\n\n"), { maxFrameChars: 9 })).length, 100);
  assert.equal((await collect(["data: " + "x".repeat(MAX_SSE_FRAME_CHARS - 8) + "\n\n"])).length, 1);
  await assert.rejects(collect(["x".repeat(MAX_SSE_FRAME_CHARS + 1)]), /SSE frame exceeds/);
  for (const maxFrameChars of [0, -1, Infinity, NaN, 1.5]) {
    await assert.rejects(collect([], { maxFrameChars }), /Invalid SSE frame limit/);
  }
});

test("oversize and consumer cancellation close the source iterator", async () => {
  let closed = 0;
  async function* source() {
    try { while (true) yield "data: x\n\n"; }
    finally { closed++; }
  }
  await assert.rejects(collect(source(), { maxFrameChars: 3 }), /SSE frame exceeds/);
  for await (const event of parseSse(source())) {
    assert.equal(event.data, "x");
    break;
  }
  assert.equal(closed, 2);
  const readable = Readable.from([Buffer.from("data: too large\n\n")]);
  await assert.rejects(Array.fromAsync(parseSse(readable, { maxFrameChars: 3 })), /SSE frame exceeds/);
  assert.equal(readable.destroyed, true);
});

test("mixed byte/string chunks and incomplete UTF-8 stay in wire order", async () => {
  assert.deepEqual((await collect([Buffer.from("data: "), Uint8Array.of(0xe2), "x\n\n"])).map((event) => event.data), ["�x"]);
  assert.deepEqual(await collect([Buffer.from("data: incomplete "), Uint8Array.of(0xe2)]), []);
  assert.deepEqual((await collect(["data: ", Buffer.from("\uFEFFvalue\n\n")])).map((event) => event.data), ["\uFEFFvalue"]);
  assert.equal(sseFrame({ value: "a\nb" }), 'data: {"value":"a\\nb"}\n\n');
});
