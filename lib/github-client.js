// Thin wrapper around api.github.com. The only part with meaningful logic is
// `pushAtomic`, which orchestrates the 4-step Git Data API push so the entire
// file set lands in ONE commit, atomically.

const API = "https://api.github.com";
const BLOB_CONCURRENCY = 8;

function headers(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
    ...extra,
  };
}

async function gh(token, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: headers(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return r;
}

async function ghJson(token, method, path, body) {
  const r = await gh(token, method, path, body);
  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  }
  if (!r.ok) {
    const err = new Error(`GitHub ${method} ${path} → ${r.status}: ${data?.message || text || "unknown"}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function getAuthedUser(token) {
  return ghJson(token, "GET", "/user");
}

export async function getRepo(token, owner, repo) {
  try {
    return await ghJson(token, "GET", `/repos/${owner}/${repo}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function listUserRepos(token) {
  // Paginate up to 5 pages of 100 = 500 repos. Sorted by recently updated
  // so users with many repos still see the relevant ones first.
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ghJson(
      token,
      "GET",
      `/user/repos?per_page=100&sort=updated&affiliation=owner&page=${page}`,
    );
    if (!Array.isArray(r) || r.length === 0) break;
    for (const repo of r) {
      out.push({
        fullName: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
        updatedAt: repo.updated_at,
      });
    }
    if (r.length < 100) break;
  }
  return out;
}

export async function createRepo(token, { name, isPrivate, description }) {
  return ghJson(token, "POST", "/user/repos", {
    name,
    private: !!isPrivate,
    description: description || "Synced from GoHighLevel AI Studio",
    auto_init: false,
  });
}

// Returns { sha, contentText } or null if not found.
export async function readFile(token, owner, repo, path, ref) {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const r = await ghJson(token, "GET", `/repos/${owner}/${repo}/contents/${encodePath(path)}${qs}`);
    if (Array.isArray(r) || r.type !== "file") return null;
    const text = atob(r.content.replace(/\n/g, ""));
    // atob produces a byte string; reinterpret as UTF-8.
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    const contentText = new TextDecoder("utf-8").decode(bytes);
    return { sha: r.sha, contentText };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Returns the array of top-level entries or null if repo is empty / 404.
export async function listRootContents(token, owner, repo, ref) {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const r = await ghJson(token, "GET", `/repos/${owner}/${repo}/contents${qs}`);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    if (e.status === 404) return null; // empty repo OR no such repo
    throw e;
  }
}

export async function getBranchHeadSha(token, owner, repo, branch) {
  try {
    const r = await ghJson(token, "GET", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
    return r.object.sha;
  } catch (e) {
    if (e.status === 404 || e.status === 409) return null; // empty repo or no such ref
    throw e;
  }
}

// utf8ToBase64 — base64-encode a UTF-8 string. btoa() needs latin-1 input.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// bootstrapEmptyRepo — GitHub's Git Data API endpoints (blobs/trees/commits)
// return 409 "Git Repository is empty" when called on a repo with no commits.
// PUT /contents implicitly creates the initial commit AND the default branch,
// unblocking subsequent Git Data API calls. We seed with the marker file's
// path so the bootstrap commit is meaningful, not a throwaway placeholder.
//
// If a previous (failed) attempt already created the seed file, GitHub
// answers 422 "sha wasn't supplied" — we read the existing sha and re-PUT
// as an update so retries are idempotent.
async function bootstrapEmptyRepo(token, owner, repo, branch, seedPath, seedContentUtf8) {
  const body = {
    message: "chore: initialize backup",
    content: utf8ToBase64(seedContentUtf8),
    branch,
  };
  try {
    const r = await ghJson(token, "PUT", `/repos/${owner}/${repo}/contents/${encodePath(seedPath)}`, body);
    return r.commit.sha;
  } catch (e) {
    if (e.status === 422 && /sha.*supplied/i.test(e.message || "")) {
      const existing = await readFile(token, owner, repo, seedPath, branch);
      if (existing) {
        body.sha = existing.sha;
        const r = await ghJson(token, "PUT", `/repos/${owner}/${repo}/contents/${encodePath(seedPath)}`, body);
        return r.commit.sha;
      }
    }
    throw e;
  }
}

// runBootstrap — pick a seed file (marker preferred, smallest as fallback)
// and call bootstrapEmptyRepo. Used both for the initial empty-repo case
// and for self-healing if blob creation hits a "Git Repository is empty" 409.
async function runBootstrap(token, owner, repo, branch, files) {
  let seed = files.find((f) => f.path === ".ghl-aistudio-sync.json");
  if (!seed) {
    seed = files.slice().sort((a, b) => (a.content?.length || 0) - (b.content?.length || 0))[0];
  }
  return bootstrapEmptyRepo(token, owner, repo, branch, seed.path, seed.content);
}

// pushAtomic — the workhorse. Pushes ALL files as one commit on the given branch.
//
// files: [{ path: "src/App.tsx", content: "...", mode: "100644" }]
//   mode default "100644" (regular file). "100755" for executable.
//
// Handles three states for the target branch:
//   • Branch exists with commits → atomic 4-step push, force-update the ref.
//   • Repo exists but has no commits at all (truly empty) → bootstrap via
//     PUT /contents to create the first commit + branch ref, then atomic
//     push as a normal update.
//
// Returns { commitSha, htmlUrl, treeSha, bootstrapped }.
export async function pushAtomic(token, { owner, repo, branch, files, commitMessage, authorName, authorEmail }) {
  if (!files || files.length === 0) {
    throw new Error("pushAtomic: files array is empty");
  }

  let parentSha = await getBranchHeadSha(token, owner, repo, branch);
  let bootstrapped = false;

  if (parentSha === null) {
    parentSha = await runBootstrap(token, owner, repo, branch, files);
    bootstrapped = true;
  }

  // 1. Create blobs concurrently with a small pool. Self-heal if GitHub
  //    reports the repo is still empty (bootstrap was skipped due to a
  //    stale parentSha read, or eventual-consistency timing). We re-run
  //    the bootstrap and retry once.
  const createBlobs = () => mapConcurrent(files, BLOB_CONCURRENCY, async (f) => {
    const blob = await ghJson(token, "POST", `/repos/${owner}/${repo}/git/blobs`, {
      content: f.content,
      encoding: f.encoding || "utf-8",
    });
    return { path: f.path, sha: blob.sha, mode: f.mode || "100644" };
  });

  let blobShas;
  try {
    blobShas = await createBlobs();
  } catch (e) {
    if (e.status === 409 && /repository is empty/i.test(e.message || "")) {
      // Bootstrap and retry once.
      parentSha = await runBootstrap(token, owner, repo, branch, files);
      bootstrapped = true;
      blobShas = await createBlobs();
    } else {
      throw e;
    }
  }

  // 2. Create the tree. No base_tree: the tree represents EXACTLY the file
  //    set we pass, with no leftover files from previous commits.
  const tree = await ghJson(token, "POST", `/repos/${owner}/${repo}/git/trees`, {
    tree: blobShas.map((b) => ({
      path: b.path,
      mode: b.mode,
      type: "blob",
      sha: b.sha,
    })),
  });

  // 3. Create the commit with parentSha (always set, thanks to bootstrap).
  const commit = await ghJson(token, "POST", `/repos/${owner}/${repo}/git/commits`, {
    message: commitMessage,
    tree: tree.sha,
    parents: [parentSha],
    ...(authorName && authorEmail
      ? { author: { name: authorName, email: authorEmail, date: new Date().toISOString() } }
      : {}),
  });

  // 4. Move the ref. force:true because we replace the whole tree (and
  //    after bootstrap the parent IS the previous head, so it's a fast-
  //    forward — force is a no-op there but stays safe for resyncs).
  await ghJson(token, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: commit.sha,
    force: true,
  });

  return {
    commitSha: commit.sha,
    treeSha: tree.sha,
    htmlUrl: commit.html_url,
    bootstrapped,
  };
}

// Small concurrency pool. Preserves output order matching input order.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function encodePath(p) {
  // Encode each segment so e.g. "src/components/ui/button.tsx" stays as-is
  // but a path with spaces or special chars gets encoded.
  return p.split("/").map(encodeURIComponent).join("/");
}
