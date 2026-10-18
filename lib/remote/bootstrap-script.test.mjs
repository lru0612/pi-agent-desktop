import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { BOOTSTRAP_SCRIPT, installCommand, isSafeVersion } from "./bootstrap-script.ts";

const execFileAsync = promisify(execFile);

async function runBootstrap(home, args) {
  const child = execFileAsync("sh", ["-s", "--", ...args], {
    env: { ...process.env, HOME: home, PATH: `${join(process.execPath, "..")}:${process.env.PATH}` },
  });
  child.child.stdin.end(BOOTSTRAP_SCRIPT);
  const { stdout } = await child;
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected exactly one JSON line, got: ${stdout}`);
  return JSON.parse(lines[0]);
}

test("version strings are restricted to a shell-safe charset", () => {
  for (const ok of ["0.7.3", "0.7.3-dev1", "1.0.0+build.5", "v2_rc"]) {
    assert.equal(isSafeVersion(ok), true, ok);
  }
  for (const bad of ["", "../x", "1.0;rm -rf ~", "a b", "$(id)", "`id`", "-rf", ".hidden", "x".repeat(65)]) {
    assert.equal(isSafeVersion(bad), false, bad);
  }
  assert.throws(() => installCommand("1.0;id"), /unsafe version/);
  assert.match(installCommand("0.7.3"), /tar -xzf - -C/);
});

test("probe reports platform and an empty install on a fresh home", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-home-"));
  try {
    const result = await runBootstrap(home, ["probe"]);
    assert.equal(result.ok, true);
    assert.equal(result.platform, `${process.platform}-${process.arch}`);
    assert.deepEqual(result.versions, []);
    assert.equal(result.running, null);
    assert.equal(result.home, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("start refuses a version that is not installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-home-"));
  try {
    const result = await runBootstrap(home, ["start", "9.9.9"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "not_installed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unknown actions fail with a usage error instead of hanging", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-home-"));
  try {
    const result = await runBootstrap(home, ["frobnicate"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "usage");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
