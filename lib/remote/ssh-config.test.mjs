import assert from "node:assert/strict";
import test from "node:test";

import { parseSshConfig } from "./ssh-config.ts";

test("concrete Host aliases are listed with their HostName/User/Port", () => {
  const hosts = parseSshConfig(`
# comment
Host devbox gpu-*
  HostName 10.0.0.5
  User me
  Port 2222

Host *
  ServerAliveInterval 30

Host=jump
  hostname jump.example.com   # trailing comment

Match host foo
  User nobody

Host !negated devbox
  User other
`);
  assert.deepEqual(hosts, [
    { alias: "devbox", hostName: "10.0.0.5", user: "me", port: "2222" },
    { alias: "jump", hostName: "jump.example.com" },
  ]);
});
