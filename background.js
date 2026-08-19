// background.js — MV3 service worker. The orchestrator.
//
// Responsibilities:
//   • Hold current AI Studio context (bearer, projectId, locationId, tabId)
//     received from content-script
//   • Drive the GitHub Device Flow login
//   • Drive the "push to GitHub" pipeline (read marker → fetch GHL files →
//     atomic push → update mapping)
//   • Bridge popup ↔ content-script (popup never talks to content-script
//     directly; it always goes through here)

import { GITHUB_CLIENT_ID, GITHUB_SCOPES } from "./config.js";
import { startDeviceFlow, pollForToken } from "./lib/github-device-flow.js";
import {
  getAuthedUser,
  getRepo,
  listUserRepos,
  createRepo,
  readFile,
  listRootContents,
  pushAtomic,
} from "./lib/github-client.js";
import {
  getGithubAuth,
  setGithubAuth,
  clearGithubAuth,
  getProjectMapping,
  setProjectMapping,
  removeProjectMapping,
} from "./lib/storage.js";
import { MARKER_FILENAME, buildMarkerContent, parseMarker } from "./lib/marker.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// ---------- State ----------
//
// `currentContext` lives in module memory AND in chrome.storage.session so
// it survives the service worker being suspended/killed between user
// interactions. The promise `contextReady` resolves once the in-memory
// copy has been hydrated from storage on every SW boot.

let currentContext = {
  bearer: null,
  projectId: null,
  locationId: null,
  projectName: null,
  capturedAt: 0,
  tabId: null,
  frameId: null,
};

const contextReady = chrome.storage.session
  .get("currentContext")
  .then((r) => {
    if (r.currentContext) {
      currentContext = { ...currentContext, ...r.currentContext };
    }
  })
  .catch(() => {});

function persistContext() {
  chrome.storage.session.set({ currentContext }).catch(() => {});
}

let loginState = null; // { userCode, verificationUri, expiresIn, startedAt, abortController, result?, error? }
const pushStateByProjectId = new Map(); // projectId → progress object

// ---------- Helpers ----------

function setBadge(text, color = "#4f46e5") {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

async function sendToContentScript(type, payload) {
  if (!currentContext.tabId) {
    throw new Error("No active AI Studio tab — open a project first.");
  }
  return chrome.tabs.sendMessage(
    currentContext.tabId,
    { type, payload },
    currentContext.frameId !== null ? { frameId: currentContext.frameId } : undefined,
  );
}

function nowIso() {
  return new Date().toISOString();
}

function commitMessageFor(projectName, fileCount) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  const stamp = `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
  return [
    `Sync from AI Studio • ${stamp}`,
    "",
    `Project: ${projectName || "(unnamed)"}`,
    `Files: ${fileCount}`,
    `Pushed by: ghl-aistudio-exporter v${EXTENSION_VERSION}`,
  ].join("\n");
}

function sanitizePath(p) {
  if (typeof p !== "string" || p.length === 0) return null;
  if (p.startsWith("/") || p.includes("\\")) return null;
  const segments = p.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return null;
  }
  return p;
}

// ---------- UI state derivation ----------

async function deriveUiState() {
  const auth = await getGithubAuth();
  const mapping = currentContext.projectId
    ? await getProjectMapping(currentContext.projectId)
    : null;
  const activePush = currentContext.projectId
    ? pushStateByProjectId.get(currentContext.projectId)
    : null;

  return {
    extensionVersion: EXTENSION_VERSION,
    context: {
      hasProject: !!currentContext.projectId,
      projectId: currentContext.projectId,
      locationId: currentContext.locationId,
      projectName: currentContext.projectName,
      hasBearer: !!currentContext.bearer,
      bearerAgeMs: currentContext.capturedAt ? Date.now() - currentContext.capturedAt : null,
    },
    auth: auth ? { login: auth.user?.login, avatarUrl: auth.user?.avatarUrl } : null,
    mapping,
    activePush: activePush ? { ...activePush } : null,
  };
}

// ---------- Login flow ----------

async function beginLogin() {
  if (loginState && !loginState.error && !loginState.result) {
    // Already in progress.
    return { ok: true, ...publicLoginState() };
  }
  const abort = new AbortController();
  loginState = {
    startedAt: Date.now(),
    abortController: abort,
    userCode: null,
    verificationUri: null,
    expiresIn: 0,
    result: null,
    error: null,
  };

  try {
    const dev = await startDeviceFlow(GITHUB_CLIENT_ID, GITHUB_SCOPES);
    loginState.userCode = dev.userCode;
    loginState.verificationUri = dev.verificationUri;
    loginState.expiresIn = dev.expiresIn;
    loginState.deviceCode = dev.deviceCode;
    loginState.interval = dev.interval;

    // Don't await — poll in background. Popup reads progress separately.
    (async () => {
      try {
        const tok = await pollForToken(GITHUB_CLIENT_ID, dev.deviceCode, dev.interval, abort.signal);
        const user = await getAuthedUser(tok.accessToken);
        await setGithubAuth(tok.accessToken, {
          login: user.login,
          id: user.id,
          avatarUrl: user.avatar_url,
        });
        loginState.result = { login: user.login };
        setBadge("");
      } catch (e) {
        loginState.error = String(e?.message || e);
        loginState.errorCode = e?.code || null;
      }
    })();

    return { ok: true, ...publicLoginState() };
  } catch (e) {
    loginState.error = String(e?.message || e);
    return { ok: false, error: loginState.error };
  }
}

function publicLoginState() {
  if (!loginState) return { state: "idle" };
  if (loginState.result) return { state: "done", login: loginState.result.login };
  if (loginState.error) return { state: "error", message: loginState.error, code: loginState.errorCode };
  if (loginState.userCode) {
    return {
      state: "pending",
      userCode: loginState.userCode,
      verificationUri: loginState.verificationUri,
      expiresIn: loginState.expiresIn,
      startedAt: loginState.startedAt,
    };
  }
  return { state: "starting" };
}

function cancelLogin() {
  if (loginState?.abortController) loginState.abortController.abort();
  loginState = null;
  return { ok: true };
}

// ---------- Push flow ----------

async function beginPush(choice) {
  await contextReady;
  if (!currentContext.projectId || !currentContext.locationId) {
    return { ok: false, error: "Open an AI Studio project first." };
  }
  const auth = await getGithubAuth();
  if (!auth?.accessToken) {
    return { ok: false, error: "Not logged in to GitHub." };
  }
  const projectId = currentContext.projectId;
  if (pushStateByProjectId.has(projectId) && pushStateByProjectId.get(projectId).status === "running") {
    return { ok: false, error: "A sync is already running for this project." };
  }
  const state = {
    status: "running",
    step: "verifying",
    detail: "",
    progress: { done: 0, total: 0 },
    startedAt: Date.now(),
    result: null,
    error: null,
  };
  pushStateByProjectId.set(projectId, state);

  // Don't await — run in background; popup polls.
  runPush(auth.accessToken, auth.user, projectId, choice, state).catch((e) => {
    state.status = "error";
    state.error = friendlyError(e);
    state.errorRaw = String(e?.message || e);
  });

  return { ok: true };
}

// validateRepoForProject — shared logic for both the "use existing repo"
// path and the "create new repo but it already exists" fallback. Confirms
// that the repo is either empty (or near-empty) or already linked to the
// CURRENT AI Studio project via a matching marker file. Throws a clear
// message if the repo belongs to a different project or has unrelated
// content.
async function validateRepoForProject(token, owner, repoName, branch, projectId) {
  const marker = await readFile(token, owner, repoName, MARKER_FILENAME, branch);
  if (marker) {
    const parsed = parseMarker(marker.contentText);
    if (!parsed) {
      throw new Error(`Marker file in ${owner}/${repoName} is corrupted. Pick a different repo.`);
    }
    if (parsed.projectId !== String(projectId)) {
      throw new Error(`Repo ${owner}/${repoName} is linked to a different AI Studio project. Pick a different repo or clear the mapping.`);
    }
    return; // marker matches — OK to overwrite
  }
  // No marker. Acceptable if the repo is empty (or only has an auto-init
  // README, or only has the marker placeholder from a half-failed previous
  // bootstrap that didn't get to write any source files yet).
  const contents = await listRootContents(token, owner, repoName, branch);
  if (!contents || contents.length === 0) return;
  const onlyHarmless = contents.every((c) => {
    const n = (c.name || "").toLowerCase();
    return n === "readme.md" || n === ".ghl-aistudio-sync.json";
  });
  if (!onlyHarmless) {
    throw new Error(`Repo ${owner}/${repoName} already has content not managed by this extension. Pick an empty repo or create a new one.`);
  }
}

// friendlyError — translates the most common technical failures into
// a sentence the user can act on. Falls back to the raw message so
// power users still see what actually went wrong.
function friendlyError(e) {
  const msg = String(e?.message || e || "");
  const status = e?.status;

  if (status === 401) {
    return "GitHub rejected the token. Sign out and back in, then retry.";
  }
  if (status === 403 && /rate limit/i.test(msg)) {
    return "GitHub rate limit reached. Wait a few minutes and try again.";
  }
  if (status === 404 && /repos\/.+\/contents/i.test(msg)) {
    return "Couldn't find the file on GitHub. Try reloading the extension (chrome://extensions → reload) and retry.";
  }
  if (status === 422 && /name already exists/i.test(msg)) {
    return "A repo with this name already exists on your GitHub. Pick a different name, or pick 'Use existing repo' to push into it.";
  }
  if (status === 422 && /sha.*supplied/i.test(msg)) {
    return "GitHub rejected the bootstrap because a marker file is already there. Reload the extension (chrome://extensions → reload) and retry — the self-heal should pick it up.";
  }
  if (status === 409 && /repository is empty/i.test(msg)) {
    return "Couldn't initialize the empty repo. Reload the extension (chrome://extensions → reload) and retry. If it still fails, delete the empty repo on GitHub and create a new one.";
  }
  if (/no bearer captured|interact with AI Studio/i.test(msg)) {
    return "Lost connection to AI Studio. Click anywhere in the AI Studio editor (e.g. the chat input) and retry.";
  }
  if (/context drifted/i.test(msg)) {
    return "Project context changed mid-push. Refresh the AI Studio page and retry.";
  }
  if (/no files for this project/i.test(msg)) {
    return "This AI Studio project has no files yet. Add something via the chat, then retry.";
  }
  // Default: keep the raw message but trim it to something readable.
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

async function runPush(token, githubUser, projectId, choice, state) {
  const ctx = { ...currentContext };
  if (!ctx.projectId || ctx.projectId !== projectId) {
    throw new Error("Context drifted — refresh AI Studio and retry.");
  }

  // 1. Resolve target repo (existing or new).
  let owner, repoName, defaultBranch;

  if (choice.kind === "new") {
    state.step = "creating-repo";
    state.detail = `Creating ${githubUser.login}/${choice.name}…`;
    let created = null;
    try {
      created = await createRepo(token, {
        name: choice.name,
        isPrivate: !!choice.isPrivate,
        description: `AI Studio backup • ${ctx.projectName || projectId}`,
      });
    } catch (e) {
      // 422 "name already exists" — a previous failed attempt likely created
      // the repo. Validate it for reuse instead of blocking the user.
      if (e.status === 422 && /name already exists/i.test(e.message || "")) {
        state.detail = `Repo already exists, validating for reuse…`;
        const existing = await getRepo(token, githubUser.login, choice.name);
        if (!existing) throw e;
        const existingDefault = existing.default_branch || "main";
        await validateRepoForProject(token, githubUser.login, choice.name, existingDefault, projectId);
        owner = existing.owner.login;
        repoName = existing.name;
        defaultBranch = existingDefault;
      } else {
        throw e;
      }
    }
    if (created) {
      owner = created.owner.login;
      repoName = created.name;
      defaultBranch = created.default_branch || "main";
    }
  } else if (choice.kind === "existing") {
    owner = choice.owner;
    repoName = choice.name;
    state.step = "checking-repo";
    state.detail = `Checking ${owner}/${repoName}…`;
    const repo = await getRepo(token, owner, repoName);
    if (!repo) throw new Error(`Repo ${owner}/${repoName} not found.`);
    defaultBranch = repo.default_branch || "main";
    await validateRepoForProject(token, owner, repoName, defaultBranch, projectId);
  } else {
    throw new Error("Unknown repo choice kind: " + choice.kind);
  }

  // 2. Fetch files from GHL via content-script proxy.
  state.step = "fetching-files";
  state.detail = "Fetching files from AI Studio…";
  const filesResp = await sendToContentScript("fetch-ghl-project-files");
  if (!filesResp?.ok) {
    throw new Error("Failed to fetch files: " + (filesResp?.error || "unknown"));
  }
  const ghlFiles = filesResp.data;
  if (!Array.isArray(ghlFiles) || ghlFiles.length === 0) {
    throw new Error("AI Studio returned no files for this project.");
  }

  // 3. Optionally fetch updated project metadata for the commit message.
  let projectName = ctx.projectName;
  try {
    const metaResp = await sendToContentScript("fetch-ghl-project-metadata");
    if (metaResp?.ok && metaResp.data?.name) projectName = metaResp.data.name;
  } catch {
    // Non-fatal; commit message just falls back to projectId.
  }

  // 4. Build the file set: sanitize paths, append marker.
  const existingMapping = await getProjectMapping(projectId);
  const now = nowIso();
  const files = [];
  for (const f of ghlFiles) {
    const safePath = sanitizePath(f.path);
    if (!safePath) {
      throw new Error(`AI Studio returned a suspicious file path: ${JSON.stringify(f.path)}. Push aborted.`);
    }
    if (safePath === MARKER_FILENAME) {
      // AI Studio file conflicts with our marker — skip the AI Studio one; we write our own.
      continue;
    }
    files.push({
      path: safePath,
      content: typeof f.content === "string" ? f.content : String(f.content ?? ""),
      mode: "100644",
      encoding: f.kind === "binary" ? "base64" : "utf-8",
    });
  }

  files.push({
    path: MARKER_FILENAME,
    content: buildMarkerContent({
      projectId,
      locationId: ctx.locationId,
      projectName,
      firstSyncedAt: existingMapping?.firstSyncedAt || now,
      lastSyncedAt: now,
      extensionVersion: EXTENSION_VERSION,
    }),
    mode: "100644",
    encoding: "utf-8",
  });

  state.progress = { done: 0, total: files.length };

  // 5. Push atomically.
  state.step = "pushing";
  state.detail = `Pushing ${files.length} files as one commit…`;
  const branch = defaultBranch || "main";

  // For progress signaling we don't have a hook inside pushAtomic; we just
  // show the total upfront. Future polish: instrument pushAtomic with a
  // per-blob callback.
  const result = await pushAtomic(token, {
    owner,
    repo: repoName,
    branch,
    files,
    commitMessage: commitMessageFor(projectName, files.length),
  });

  // 6. Update mapping.
  state.step = "saving-mapping";
  state.detail = "Saving project ↔ repo link…";
  await setProjectMapping(projectId, {
    repoOwner: owner,
    repoName: repoName,
    repoFullName: `${owner}/${repoName}`,
    repoUrl: `https://github.com/${owner}/${repoName}`,
    defaultBranch: branch,
    firstSyncedAt: existingMapping?.firstSyncedAt || now,
    lastSyncedAt: now,
    lastSyncCommitSha: result.commitSha,
  });

  // 7. Done.
  state.status = "done";
  state.step = "done";
  state.detail = "";
  state.result = {
    commitSha: result.commitSha,
    commitUrl: result.htmlUrl,
    repoUrl: `https://github.com/${owner}/${repoName}`,
    fileCount: files.length,
  };
  state.finishedAt = Date.now();
  setBadge("");
}

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  // From content-script
  if (msg.type === "context-update") {
    currentContext = {
      ...currentContext,
      ...msg.payload,
      tabId: sender.tab?.id ?? currentContext.tabId,
      frameId: sender.frameId ?? currentContext.frameId,
    };
    persistContext();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "button-clicked") {
    // The in-page modal is the primary UI; this message is a heartbeat
    // (telemetry hook, future analytics). No badge, no popup open here.
    sendResponse({ ok: true });
    return false;
  }

  // From popup (native or modal-hosted)
  if (msg.type === "get-ui-state") {
    contextReady.then(() => deriveUiState()).then((s) => sendResponse({ ok: true, data: s }));
    return true;
  }

  if (msg.type === "begin-login") {
    beginLogin().then(sendResponse);
    return true;
  }

  if (msg.type === "get-login-progress") {
    sendResponse({ ok: true, data: publicLoginState() });
    return false;
  }

  if (msg.type === "cancel-login") {
    cancelLogin();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "list-repos") {
    (async () => {
      const auth = await getGithubAuth();
      if (!auth?.accessToken) return sendResponse({ ok: false, error: "Not logged in." });
      try {
        const repos = await listUserRepos(auth.accessToken);
        sendResponse({ ok: true, data: repos });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === "begin-push") {
    beginPush(msg.payload).then(sendResponse);
    return true;
  }

  if (msg.type === "get-push-progress") {
    const pid = msg.payload?.projectId || currentContext.projectId;
    const s = pid ? pushStateByProjectId.get(pid) : null;
    sendResponse({ ok: true, data: s ? { ...s } : null });
    return false;
  }

  if (msg.type === "clear-push-state") {
    const pid = msg.payload?.projectId || currentContext.projectId;
    if (pid) pushStateByProjectId.delete(pid);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "clear-mapping") {
    const pid = msg.payload?.projectId || currentContext.projectId;
    if (pid) {
      removeProjectMapping(pid).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false, error: "No project context." });
    return false;
  }

  if (msg.type === "logout") {
    clearGithubAuth().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener(() => {
  // Popup is opened automatically; this fires only if no popup is set,
  // which shouldn't happen given our manifest. Kept for safety.
});
