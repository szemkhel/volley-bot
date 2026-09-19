// mvpCaricature.js needs only fs/path/lib — no node_modules — so it's safe to test in CI.
// These drive the retry with REAL fetch against a local server that really drops the connection,
// so the error shape under test is the one Node actually produces (2026-09-19: "fetch failed"),
// not a hand-built imitation.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { withOneRetry } = require("../mvpCaricature");
const { isDroppedConnection, fetchErrorDetail } = require("../lib");

// Serves `behaviours` in order, one per request: "drop" = kill the socket before any response,
// "cut" = send headers + half a body then kill it, "ok" = 200 JSON, "400" = an HTTP error.
function flakyServer(behaviours) {
  let i = 0;
  const server = http.createServer((req, res) => {
    const b = behaviours[Math.min(i++, behaviours.length - 1)];
    req.resume();
    if (b === "drop") return req.socket.destroy();
    if (b === "cut") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
      res.write('{"data":[{"b64_json":"AAAA');
      return setTimeout(() => req.socket.destroy(), 20);
    }
    if (b === "400") { res.writeHead(400); return res.end("bad request"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    resolve({ url: "http://127.0.0.1:" + server.address().port, close: () => server.close(), hits: () => i });
  }));
}

// Same shape as callOpenAiEdit/Generate: throw on !ok, parse the body.
async function call(url) {
  const res = await fetch(url, { method: "POST", body: "x" });
  if (!res.ok) throw new Error("OpenAI edit " + res.status + ": " + (await res.text()));
  return await res.json();
}

test("withOneRetry: a connection dropped before the response is retried once and recovers", async () => {
  const s = await flakyServer(["drop", "ok"]);
  try {
    assert.deepStrictEqual(await withOneRetry("t", () => call(s.url), 0), { ok: true });
    assert.strictEqual(s.hits(), 2);
  } finally { s.close(); }
});

test("withOneRetry: a body cut off mid-stream is retried once and recovers", async () => {
  const s = await flakyServer(["cut", "ok"]);
  try {
    assert.deepStrictEqual(await withOneRetry("t", () => call(s.url), 0), { ok: true });
    assert.strictEqual(s.hits(), 2);
  } finally { s.close(); }
});

test("withOneRetry: only ONE retry — a second drop surfaces with its real cause", async () => {
  const s = await flakyServer(["drop", "drop", "ok"]);
  try {
    await assert.rejects(withOneRetry("t", () => call(s.url), 0), e => {
      assert.ok(isDroppedConnection(e));
      // The detail must carry more than Node's bare "fetch failed"
      assert.match(fetchErrorDetail(e), /^fetch failed \(.+\)$/);
      return true;
    });
    assert.strictEqual(s.hits(), 2);
  } finally { s.close(); }
});

test("withOneRetry: an HTTP error from OpenAI is NOT retried", async () => {
  const s = await flakyServer(["400", "ok"]);
  try {
    await assert.rejects(withOneRetry("t", () => call(s.url), 0), /OpenAI edit 400/);
    assert.strictEqual(s.hits(), 1);
  } finally { s.close(); }
});

test("isDroppedConnection: a timeout is NOT a dropped connection (image may still be rendering)", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.strictEqual(isDroppedConnection(timeout), false);
  assert.strictEqual(isDroppedConnection(new Error("OpenAI edit 500: oops")), false);
  assert.strictEqual(isDroppedConnection(null), false);
});

test("fetchErrorDetail: plain errors pass through, causes are appended", () => {
  assert.strictEqual(fetchErrorDetail(new Error("OpenAI edit 400: nope")), "OpenAI edit 400: nope");
  const e = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  assert.strictEqual(fetchErrorDetail(e), "fetch failed (UND_ERR_SOCKET: other side closed)");
  assert.strictEqual(fetchErrorDetail(undefined), "unknown error");
});
