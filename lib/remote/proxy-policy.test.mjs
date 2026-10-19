import assert from "node:assert/strict";
import test from "node:test";

import { isSafeRemotePath, proxyLocation, proxyRequestHeaders, proxyResponseHeaders, remotePathFor } from "./proxy-policy.ts";
import { encodeFilePathForApi } from "../file-paths.ts";

const local = "http://127.0.0.1:12345/api/r/devbox/";

test("blocked families cannot hide behind percent escapes, dots, or separators", () => {
  for (const family of ["desktop", "open-in-explorer", "custom-css", "updates", "web-auth", "push", "r", "remote-hosts"]) {
    for (const path of [
      `${family}/x`, `%${family.charCodeAt(0).toString(16)}${family.slice(1)}/x`,
      `${family}%2fx`, `${family}%252fx`, `files/../${family}/x`,
      `files/%2e%2e/${family}/x`, `files/%2e%2e%2f${family}/x`,
      `files/%252e%252e%252f${family}/x`, `files%2f..%2f${family}/x`,
      `files/%5c..%5c${family}/x`, `files/%255c..%255c${family}/x`,
      `/${family}/x`, `sessions/%2f..%2f..%2f${family}/x`,
    ]) assert.equal(remotePathFor(local + path, "devbox"), null, path);
  }
  for (const path of ["", "%", "%zz", "%E9", "files/%C0%AF", "files/%00x", "files/%250ax", "files/" + "%25".repeat(1) + "25".repeat(20) + "2e"]) {
    assert.equal(remotePathFor(local + path, "devbox"), null, path);
  }
  assert.equal(remotePathFor("not a URL", "devbox"), null);
  assert.equal(remotePathFor(local + "sessions", "other"), null);
});

test("file URL path bytes, absolute paths, UNC roots and queries survive unchanged", () => {
  for (const file of [
    "/home/user/a b#?.txt", "C:\\Users\\me\\a.txt", "\\\\server\\share\\a b.txt",
    "/tmp/100%done/中文😀.txt", "/tmp/desktop/web-auth.txt",
  ]) {
    const rest = `files/${encodeFilePathForApi(file)}?type=serve&path=%2Ftmp%2Fa+b&path=x`;
    assert.equal(remotePathFor(local + rest, "devbox"), `/api/${rest}`);
  }
  for (const path of ["files//home/u/a", "files/%2Fhome%2Fu%2Fa", "files/%2F%2Fserver/share/a", "files/%5C%5Cserver%5Cshare%5Ca"]) {
    assert.equal(remotePathFor(local + path, "devbox"), `/api/${path}`);
  }
  assert.equal(remotePathFor(local + "sessions/id?x=%&y=/../web-auth", "devbox"), "/api/sessions/id?x=%&y=/../web-auth");
  assert.equal(isSafeRemotePath("/api/files/./a"), false);
});

test("request header allow-list isolates credentials, Origin and connection metadata", () => {
  const headers = proxyRequestHeaders(new Headers({
    cookie: "local=secret", authorization: "Basic secret", "proxy-authorization": "secret",
    origin: "http://local", referer: "http://local/private", host: "evil.invalid",
    "x-pi-desktop-token": "desktop-secret", "sec-fetch-site": "same-origin",
    forwarded: "host=evil", "x-forwarded-host": "evil", "x-forwarded-for": "evil",
    "x-middleware-subrequest": "middleware", connection: "keep-alive, x-pi-dest-path",
    "x-pi-dest-path": "/tmp/a", "content-length": "999", range: "bytes=1-3",
    "last-event-id": "7", "content-type": "application/octet-stream", "if-range": "etag",
  }));
  assert.deepEqual(headers, {
    "content-type": "application/octet-stream", "if-range": "etag", "last-event-id": "7", range: "bytes=1-3",
  });
});

test("response header filtering removes cookies, auth prompts, CORS and nominated hop headers", () => {
  const headers = proxyResponseHeaders(new Headers({
    "set-cookie": "pi_web_session=secret", "set-cookie2": "secret", "www-authenticate": "Basic realm=remote",
    connection: "x-private, keep-alive", "x-private": "secret", "keep-alive": "timeout=10",
    "transfer-encoding": "chunked", trailer: "digest", te: "trailers", "proxy-authenticate": "secret",
    "access-control-allow-origin": "*", "access-control-allow-credentials": "true",
    "clear-site-data": '"*"', refresh: "0; url=/api/desktop/save", "alt-svc": 'h3=":1234"',
    "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "123",
    "content-range": "bytes 1-3/4", "content-security-policy": "sandbox", "x-accel-buffering": "no",
  }));
  assert.deepEqual(Object.fromEntries(headers), {
    "content-encoding": "gzip", "content-length": "123", "content-range": "bytes 1-3/4",
    "content-security-policy": "sandbox", "content-type": "text/event-stream", "x-accel-buffering": "no",
  });
});

test("Location only resolves to a validated API path on the same remote host", () => {
  const base = "http://127.0.0.1:54321";
  const rewrite = (location) => proxyLocation(location, base, "/api/files/tmp/a?type=serve", "devbox");
  assert.equal(rewrite("b?type=download#x"), "/api/r/devbox/files/tmp/b?type=download#x");
  assert.equal(rewrite("/api/files/%2F%2Fhost/share/a"), "/api/r/devbox/files/%2F%2Fhost/share/a");
  assert.equal(rewrite(base + "/api/sessions/?a=%2f"), "/api/r/devbox/sessions/?a=%2f");
  for (const location of [
    "/api/desktop/save", "/api/web-auth", "/api/r/other/sessions", "/login", "/", "../../../desktop/save",
    "https://example.invalid/api/sessions", "//example.invalid/api/sessions", "http://127.0.0.1:1/api/sessions",
    "http://user:secret@127.0.0.1:54321/api/sessions", "javascript:alert(1)",
    "/api/files/%252e%252e%252fdesktop/save", "/api/%77eb-auth",
  ]) assert.equal(rewrite(location), null, location);
});
