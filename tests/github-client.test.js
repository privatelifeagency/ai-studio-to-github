// node --test tests/github-client.test.js
//
// Verifies the 4-step Git Data API push sequence in pushAtomic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushAtomic } from "../lib/github-client.js";

// Tiny fetch mock that records every call and returns scripted responses.
function makeMockFetch(scripts) {
  const calls = [];
  const remaining = scripts.slice();
  const fakeFetch = async (url, init) => {
    const call = { url, init: init || {}, method: (init && init.method) || "GET" };
    if (call.init.body) {
      try { call.body = JSON.parse(call.init.body); } catch { call.body = call.init.body; }
    }
    calls.push(call);
    const match = remaining.findIndex(
      (s) => s.match(url, call.method, call.body) === true,
    );
    if (match === -1) {
      throw new Error(`No mock matched ${call.method} ${url}: ${JSON.stringify(call.body || {}).slice(0, 100)}`);
    }
    const scriptItem = remaining.splice(match, 1)[0];
    const respBody = typeof scriptItem.respond === "function"
      ? scriptItem.respond(call)
      : scriptItem.respond;
    return new Response(JSON.stringify(respBody), {
      status: scriptItem.status || 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fakeFetch, calls };
}

function installFetch(mockFetch) {
  globalThis.fetch = mockFetch;
}
function restoreFetch(original) {
  globalThis.fetch = original;
}

test("pushAtomic rejects empty files array", async () => {
  await assert.rejects(
    () => pushAtomic("tok", { owner: "o", repo: "r", branch: "main", files: [], commitMessage: "x" }),
    /files array is empty/,
  );
});

test("pushAtomic empty repo: bootstraps via PUT /contents then PATCHes ref", async (t) => {
  const original = globalThis.fetch;
  const { fetch: fakeFetch, calls } = makeMockFetch([
    // 1. getBranchHeadSha → 404 (no ref yet — repo is empty)
    {
      match: (url, m) => m === "GET" && url.endsWith("/repos/o/r/git/refs/heads/main"),
      status: 404,
      respond: { message: "Not Found" },
    },
    // 2. Bootstrap PUT /contents with the seed file (the marker if present,
    //    else the smallest content). In this test, "B" is smaller than the
    //    marker JSON, so the seed is b.txt.
    {
      match: (url, m, b) => m === "PUT" && url.endsWith("/repos/o/r/contents/b.txt") && typeof b.content === "string",
      respond: { commit: { sha: "bootstrapSHA" } },
    },
    // 3. Two blob POSTs (we'll push 2 files).
    {
      match: (url, m, b) => m === "POST" && url.endsWith("/repos/o/r/git/blobs") && b.content === "AAAAA",
      respond: { sha: "blobA" },
    },
    {
      match: (url, m, b) => m === "POST" && url.endsWith("/repos/o/r/git/blobs") && b.content === "B",
      respond: { sha: "blobB" },
    },
    // 4. Tree POST.
    {
      match: (url, m, b) => m === "POST" && url.endsWith("/repos/o/r/git/trees") && Array.isArray(b.tree),
      respond: { sha: "treeSHA" },
    },
    // 5. Commit POST with bootstrapSHA as parent (NOT empty parents).
    {
      match: (url, m, b) => m === "POST" && url.endsWith("/repos/o/r/git/commits") && Array.isArray(b.parents) && b.parents[0] === "bootstrapSHA",
      respond: { sha: "commitSHA", html_url: "https://github.com/o/r/commit/commitSHA" },
    },
    // 6. PATCH the ref (NOT POST — bootstrap created the ref).
    {
      match: (url, m, b) => m === "PATCH" && url.endsWith("/repos/o/r/git/refs/heads/main") && b.sha === "commitSHA",
      respond: { ref: "refs/heads/main" },
    },
  ]);
  installFetch(fakeFetch);
  t.after(() => restoreFetch(original));

  const result = await pushAtomic("tok", {
    owner: "o",
    repo: "r",
    branch: "main",
    files: [
      { path: "a.txt", content: "AAAAA" }, // longer
      { path: "b.txt", content: "B" },     // shorter → used as seed
    ],
    commitMessage: "init",
  });

  assert.equal(result.commitSha, "commitSHA");
  assert.equal(result.bootstrapped, true);

  // Confirm the call sequence.
  assert.equal(calls.filter((c) => c.method === "PUT" && c.url.includes("/contents/")).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith("/git/blobs")).length, 2);
  assert.equal(calls.filter((c) => c.url.endsWith("/git/trees")).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith("/git/commits")).length, 1);
  // No POST /git/refs — we PATCH because bootstrap created the ref.
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/refs")).length, 0);
  assert.equal(calls.filter((c) => c.method === "PATCH" && c.url.includes("/git/refs/heads/")).length, 1);
});

test("pushAtomic prefers marker file as bootstrap seed when present", async (t) => {
  const original = globalThis.fetch;
  const { fetch: fakeFetch, calls } = makeMockFetch([
    {
      match: (url, m) => m === "GET" && url.endsWith("/git/refs/heads/main"),
      status: 404,
      respond: {},
    },
    // Seed must be the marker file, not the smaller "a.txt"
    {
      match: (url, m) => m === "PUT" && url.endsWith("/contents/.ghl-aistudio-sync.json"),
      respond: { commit: { sha: "bootstrap" } },
    },
    { match: (url, m) => m === "POST" && url.endsWith("/git/blobs"), respond: { sha: "b" } },
    { match: (url, m) => m === "POST" && url.endsWith("/git/blobs"), respond: { sha: "b2" } },
    { match: (url, m) => m === "POST" && url.endsWith("/git/trees"), respond: { sha: "t" } },
    { match: (url, m) => m === "POST" && url.endsWith("/git/commits"), respond: { sha: "c", html_url: "h" } },
    { match: (url, m) => m === "PATCH" && url.endsWith("/git/refs/heads/main"), respond: {} },
  ]);
  installFetch(fakeFetch);
  t.after(() => restoreFetch(original));

  await pushAtomic("tok", {
    owner: "o", repo: "r", branch: "main",
    files: [
      { path: "a.txt", content: "A" }, // smallest
      { path: ".ghl-aistudio-sync.json", content: "{...marker...}" },
    ],
    commitMessage: "x",
  });

  const seedCall = calls.find((c) => c.method === "PUT");
  assert.ok(seedCall.url.includes(".ghl-aistudio-sync.json"), "marker should win as seed");
});

test("pushAtomic existing repo: updates ref via PATCH with force:true", async (t) => {
  const original = globalThis.fetch;
  const { fetch: fakeFetch, calls } = makeMockFetch([
    // getBranchHeadSha returns existing SHA.
    {
      match: (url, m) => m === "GET" && url.endsWith("/repos/o/r/git/refs/heads/main"),
      respond: { object: { sha: "oldCommitSHA" } },
    },
    // One blob.
    {
      match: (url, m) => m === "POST" && url.endsWith("/repos/o/r/git/blobs"),
      respond: { sha: "blob1" },
    },
    // Tree.
    {
      match: (url, m) => m === "POST" && url.endsWith("/repos/o/r/git/trees"),
      respond: { sha: "treeSHA" },
    },
    // Commit with parent.
    {
      match: (url, m, b) => m === "POST" && url.endsWith("/repos/o/r/git/commits") && b.parents.includes("oldCommitSHA"),
      respond: { sha: "newCommitSHA", html_url: "https://github.com/o/r/commit/newCommitSHA" },
    },
    // Update ref (PATCH).
    {
      match: (url, m, b) => m === "PATCH" && url.endsWith("/repos/o/r/git/refs/heads/main") && b.force === true && b.sha === "newCommitSHA",
      respond: { ref: "refs/heads/main" },
    },
  ]);
  installFetch(fakeFetch);
  t.after(() => restoreFetch(original));

  const result = await pushAtomic("tok", {
    owner: "o",
    repo: "r",
    branch: "main",
    files: [{ path: "x.txt", content: "X" }],
    commitMessage: "resync",
  });

  assert.equal(result.commitSha, "newCommitSHA");
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.force, true);
});

test("pushAtomic surfaces GitHub error with status", async (t) => {
  const original = globalThis.fetch;
  const { fetch: fakeFetch } = makeMockFetch([
    {
      match: (url, m) => m === "GET" && url.endsWith("/repos/o/r/git/refs/heads/main"),
      status: 500,
      respond: { message: "boom" },
    },
  ]);
  installFetch(fakeFetch);
  t.after(() => restoreFetch(original));

  await assert.rejects(
    () => pushAtomic("tok", { owner: "o", repo: "r", branch: "main", files: [{ path: "a", content: "A" }], commitMessage: "x" }),
    (err) => err.status === 500 && /boom/.test(err.message),
  );
});

test("pushAtomic sends authorization header on every call", async (t) => {
  const original = globalThis.fetch;
  const { fetch: fakeFetch, calls } = makeMockFetch([
    {
      match: (url, m) => m === "GET" && url.endsWith("/git/refs/heads/main"),
      respond: { object: { sha: "old" } },
    },
    { match: (url, m) => m === "POST" && url.endsWith("/git/blobs"), respond: { sha: "b" } },
    { match: (url, m) => m === "POST" && url.endsWith("/git/trees"), respond: { sha: "t" } },
    { match: (url, m) => m === "POST" && url.endsWith("/git/commits"), respond: { sha: "c", html_url: "h" } },
    { match: (url, m) => m === "PATCH" && url.endsWith("/git/refs/heads/main"), respond: {} },
  ]);
  installFetch(fakeFetch);
  t.after(() => restoreFetch(original));

  await pushAtomic("secret-tok", {
    owner: "o", repo: "r", branch: "main",
    files: [{ path: "a", content: "A" }],
    commitMessage: "x",
  });

  for (const c of calls) {
    assert.equal(c.init.headers.authorization, "Bearer secret-tok", `missing auth on ${c.method} ${c.url}`);
  }
});
