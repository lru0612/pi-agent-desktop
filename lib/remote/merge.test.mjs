import assert from "node:assert/strict";
import test from "node:test";

import { mergeSessionPayloads } from "./merge.ts";

const session = (id, cwd) => ({ id, cwd, path: `/${id}.jsonl`, created: "", modified: "", messageCount: 1, firstMessage: "" });

test("remote rows are tagged with their host and running ids merged", () => {
  const merged = mergeSessionPayloads(
    { sessions: [session("l1", "/Users/me/a")], sessionListVersion: 4, runningSessionIds: ["l1"] },
    [
      { host: "devbox", live: true, payload: { sessions: [session("r1", "/home/u/p")], sessionListVersion: 9, runningSessionIds: ["r1"] } },
      { host: "gpu", live: false, payload: { sessions: [session("r2", "/data/x")], sessionListVersion: 1, runningSessionIds: ["r2"] } },
      { host: "never", live: false, payload: null },
    ],
    42,
  );
  assert.deepEqual(merged.sessions.map((row) => [row.id, row.host]), [["l1", undefined], ["r1", "devbox"], ["r2", "gpu"]]);
  // Cached (offline) lists contribute rows but not stale running state.
  assert.deepEqual(merged.runningSessionIds, ["l1", "r1"]);
  assert.equal(merged.sessionListVersion, 42);
});

test("a remote row never shadows a local session with the same id", () => {
  const merged = mergeSessionPayloads(
    { sessions: [session("same", "/Users/me/a")], sessionListVersion: 1 },
    [{ host: "devbox", live: true, payload: { sessions: [session("same", "/home/u/p")], sessionListVersion: 1 } }],
    2,
  );
  assert.equal(merged.sessions.length, 1);
  assert.equal(merged.sessions[0].host, undefined);
});
