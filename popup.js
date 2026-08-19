// popup.js — pure view layer. No business logic; everything routes through
// the service worker.

const $view = document.getElementById("view");
const $footer = document.getElementById("account-footer");

let pollTimer = null;
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => resolve(r));
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Account footer ----------

function renderFooter(state) {
  if (!state.auth?.login) {
    $footer.hidden = true;
    $footer.replaceChildren();
    return;
  }
  $footer.hidden = false;
  $footer.replaceChildren(
    el("span", { class: "dot", "aria-label": "connected" }),
    el("span", { class: "who" }, `@${state.auth.login}`),
    el(
      "button",
      {
        class: "logout-btn",
        title: "Sign out of GitHub",
        onclick: async () => {
          await send("logout");
          await refresh();
        },
      },
      "Logout",
    ),
  );
}

// ---------- Views ----------

async function refresh() {
  stopPolling();
  const r = await send("get-ui-state");
  if (!r?.ok) {
    $view.replaceChildren(el("div", { class: "error" }, "Failed to talk to extension."));
    return;
  }
  const state = r.data;
  renderFooter(state);
  route(state);
}

function route(state) {
  // Priority: in-flight push > login pending > error states > main flow.
  if (state.activePush && state.activePush.status === "running") return viewPushing(state);
  if (state.activePush && state.activePush.status === "done") return viewPushDone(state);
  if (state.activePush && state.activePush.status === "error") return viewPushError(state);
  if (!state.auth) return viewLogin(state);
  if (!state.context.hasProject) return viewNoProject(state);
  if (state.mapping) return viewReady(state);
  return viewChooseRepo(state);
}

// --- View: no project open ---

function viewNoProject(state) {
  $view.replaceChildren(
    el("h1", {}, "No AI Studio project open"),
    el(
      "p",
      { class: "muted" },
      "Open an AI Studio project in GoHighLevel, then click the extension icon again.",
    ),
  );
}

// --- View: login ---

function viewLogin(state) {
  $view.replaceChildren(
    el("h1", {}, "Connect GitHub"),
    el(
      "p",
      {},
      "Authorize this extension to push backups to your GitHub repos. Uses GitHub Device Flow — no client secret stored.",
    ),
    el(
      "button",
      {
        class: "btn btn-primary",
        onclick: async () => {
          const r = await send("begin-login");
          if (!r?.ok) return showLoginError(r?.error || "Login failed.");
          viewLoginPending();
          pollTimer = setInterval(pollLogin, 1500);
        },
      },
      "Login with GitHub",
    ),
  );
}

function showLoginError(msg) {
  $view.prepend(el("div", { class: "error" }, msg));
}

function viewLoginPending() {
  $view.replaceChildren(
    el("h1", {}, "Authorize on GitHub"),
    el("p", {}, "1. Open the GitHub device page."),
    el("p", {}, "2. Enter this code:"),
    el("div", { class: "card", style: "text-align:center; padding:18px;" },
      el("span", { class: "code", id: "user-code" }, "…"),
    ),
    el(
      "button",
      {
        class: "btn btn-primary",
        id: "open-device-link",
        onclick: () => {
          const link = document.getElementById("open-device-link").dataset.url;
          if (link) chrome.tabs.create({ url: link });
        },
      },
      "Open github.com/login/device",
    ),
    el(
      "button",
      {
        class: "btn btn-secondary",
        onclick: async () => {
          await send("cancel-login");
          await refresh();
        },
      },
      "Cancel",
    ),
  );
}

async function pollLogin() {
  const r = await send("get-login-progress");
  if (!r?.ok) return;
  const p = r.data;
  if (p.state === "pending") {
    const code = document.getElementById("user-code");
    if (code) code.textContent = p.userCode || "…";
    const link = document.getElementById("open-device-link");
    if (link) link.dataset.url = p.verificationUri || "https://github.com/login/device";
    return;
  }
  if (p.state === "done") {
    stopPolling();
    await refresh();
    return;
  }
  if (p.state === "error") {
    stopPolling();
    $view.prepend(el("div", { class: "error" }, p.message || "Login failed."));
    return;
  }
}

// --- View: choose repo (logged in, no mapping) ---

async function viewChooseRepo(state) {
  $view.replaceChildren(
    el("h1", {}, `Sync project "${state.context.projectName || state.context.projectId}"`),
    el("div", { class: "radio-row" },
      el("label", {},
        el("input", { type: "radio", name: "repokind", value: "new", checked: "" }),
        " Create new repo",
      ),
      el("label", {},
        el("input", { type: "radio", name: "repokind", value: "existing" }),
        " Use existing repo",
      ),
    ),
    el("div", { id: "repo-form-area" }),
    el("button", {
      class: "btn btn-primary",
      id: "begin-push-btn",
      onclick: onBeginPush,
    }, "Push to GitHub"),
  );

  // Default to "new" form.
  renderNewRepoForm(state);

  document.querySelectorAll('input[name="repokind"]').forEach((inp) => {
    inp.addEventListener("change", (e) => {
      if (e.target.value === "new") renderNewRepoForm(state);
      else renderExistingRepoForm(state);
    });
  });
}

function renderNewRepoForm(state) {
  const area = document.getElementById("repo-form-area");
  area.replaceChildren(
    el("label", { class: "field" },
      el("span", {}, "Repo name"),
      el("input", {
        type: "text",
        id: "new-repo-name",
        value: defaultSlug(state.context.projectName || state.context.projectId),
        autocomplete: "off",
      }),
    ),
    el("label", { class: "field" },
      el("span", {}, "Visibility"),
      el("div", { class: "radio-row" },
        el("label", {},
          el("input", { type: "radio", name: "vis", value: "private", checked: "" }),
          " Private",
        ),
        el("label", {},
          el("input", { type: "radio", name: "vis", value: "public" }),
          " Public",
        ),
      ),
    ),
  );
}

async function renderExistingRepoForm(state) {
  const area = document.getElementById("repo-form-area");
  area.replaceChildren(
    el("p", { class: "muted" }, el("span", { class: "spinner" }), " Loading your repos…"),
  );
  const r = await send("list-repos");
  if (!r?.ok) {
    area.replaceChildren(el("div", { class: "error" }, r?.error || "Failed to load repos."));
    return;
  }
  const repos = r.data || [];
  if (repos.length === 0) {
    area.replaceChildren(el("p", { class: "muted" }, "No repos found on your account."));
    return;
  }
  area.replaceChildren(
    el("label", { class: "field" },
      el("span", {}, "Pick a repo"),
      (() => {
        const sel = el("select", { id: "existing-repo-select" });
        for (const r of repos) {
          const opt = el("option", { value: r.fullName }, `${r.fullName}${r.private ? " (private)" : ""}`);
          sel.appendChild(opt);
        }
        return sel;
      })(),
    ),
    el("p", { class: "muted" },
      "The repo must either be empty, or have already been pushed by this extension for the same AI Studio project.",
    ),
  );
}

function defaultSlug(s) {
  return String(s || "ai-studio-project")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "ai-studio-project";
}

async function onBeginPush() {
  const kind = (document.querySelector('input[name="repokind"]:checked') || {}).value || "new";
  let choice;
  if (kind === "new") {
    const name = (document.getElementById("new-repo-name") || {}).value?.trim();
    if (!name) {
      $view.prepend(el("div", { class: "error" }, "Repo name is required."));
      return;
    }
    const isPrivate = (document.querySelector('input[name="vis"]:checked') || {}).value !== "public";
    choice = { kind: "new", name, isPrivate };
  } else {
    const full = (document.getElementById("existing-repo-select") || {}).value;
    if (!full) {
      $view.prepend(el("div", { class: "error" }, "Pick a repo."));
      return;
    }
    const [owner, name] = full.split("/");
    choice = { kind: "existing", owner, name };
  }
  document.getElementById("begin-push-btn").disabled = true;
  const r = await send("begin-push", choice);
  if (!r?.ok) {
    $view.prepend(el("div", { class: "error" }, r?.error || "Push failed to start."));
    document.getElementById("begin-push-btn").disabled = false;
    return;
  }
  await refresh();
}

// --- View: ready (mapping exists) ---

function viewReady(state) {
  const m = state.mapping;
  $view.replaceChildren(
    el("h1", {}, "Sync ready"),
    el("div", { class: "card" },
      el("div", {}, "AI Studio project:"),
      el("div", { style: "font-weight:600; margin-bottom:6px;" },
        state.context.projectName || state.context.projectId,
      ),
      el("div", {}, "GitHub repo:"),
      el("div", { style: "font-weight:600;" },
        el("a", { href: m.repoUrl, target: "_blank", rel: "noopener" }, m.repoFullName),
      ),
      el("div", { class: "muted", style: "margin-top:6px;" },
        "Last synced: " + (m.lastSyncedAt ? new Date(m.lastSyncedAt).toLocaleString() : "never"),
      ),
    ),
    el("button", {
      class: "btn btn-primary",
      onclick: async () => {
        document.querySelector(".btn-primary").disabled = true;
        const r = await send("begin-push", {
          kind: "existing",
          owner: m.repoOwner,
          name: m.repoName,
        });
        if (!r?.ok) {
          $view.prepend(el("div", { class: "error" }, r?.error || "Push failed to start."));
          document.querySelector(".btn-primary").disabled = false;
          return;
        }
        await refresh();
      },
    }, "Push update"),
    el("button", {
      class: "btn btn-secondary",
      onclick: async () => {
        await send("clear-mapping");
        await refresh();
      },
    }, "Push to a different repo"),
  );
}

// --- View: pushing (in flight) ---

const STEP_LABELS = {
  verifying: "Verifying",
  "checking-repo": "Checking repo",
  "creating-repo": "Creating repo",
  "fetching-files": "Fetching files from AI Studio",
  pushing: "Pushing to GitHub",
  "saving-mapping": "Saving link",
  done: "Done",
};
const STEP_ORDER = [
  "verifying",
  "checking-repo",
  "creating-repo",
  "fetching-files",
  "pushing",
  "saving-mapping",
  "done",
];

function viewPushing(state) {
  const p = state.activePush;
  const list = el("ul", { class: "progress-list" });
  // Render only the steps that are likely relevant; "creating-repo" and
  // "checking-repo" are mutually exclusive — show the one that has been
  // reached or the current one.
  const relevant = STEP_ORDER.filter((s) => {
    if (s === "creating-repo" || s === "checking-repo") return s === p.step || isStepBefore(p.step, s) === false;
    return true;
  });
  const reachedIndex = STEP_ORDER.indexOf(p.step);
  for (const s of relevant) {
    const idx = STEP_ORDER.indexOf(s);
    let cls = "pending";
    if (idx < reachedIndex) cls = "done";
    else if (idx === reachedIndex) cls = "active";
    list.appendChild(el("li", { class: cls }, STEP_LABELS[s] || s));
  }
  $view.replaceChildren(
    el("h1", {}, "Syncing…"),
    list,
    p.detail ? el("p", { class: "muted" }, p.detail) : null,
  );
  if (!pollTimer) pollTimer = setInterval(refresh, 1200);
}

function isStepBefore(currentStep, candidate) {
  return STEP_ORDER.indexOf(candidate) < STEP_ORDER.indexOf(currentStep);
}

function viewPushDone(state) {
  const r = state.activePush.result;
  $view.replaceChildren(
    el("div", { class: "success" }, `Pushed ${r.fileCount} files in one commit.`),
    el("div", { class: "card" },
      el("div", {}, "Repo:"),
      el("div", {}, el("a", { href: r.repoUrl, target: "_blank", rel: "noopener" }, r.repoUrl)),
      el("div", { style: "margin-top:6px;" }, "Commit:"),
      el("div", {}, el("a", { href: r.commitUrl, target: "_blank", rel: "noopener" }, r.commitSha.slice(0, 7))),
    ),
    el("button", {
      class: "btn btn-secondary",
      onclick: async () => {
        await send("clear-push-state");
        await refresh();
      },
    }, "Done"),
  );
}

function viewPushError(state) {
  const friendly = state.activePush.error || "Push failed.";
  const raw = state.activePush.errorRaw;
  const mentionsReload = /reload the extension/i.test(friendly);

  const children = [
    el("div", { class: "error" }, friendly),
  ];

  if (mentionsReload) {
    children.push(
      el("button", {
        class: "btn btn-secondary",
        onclick: () => chrome.tabs.create({ url: "chrome://extensions" }),
      }, "Open chrome://extensions"),
    );
  }

  if (raw && raw !== friendly) {
    const details = el("details", { style: "margin: 6px 0 12px; font-size: 11px; color: #6b7280;" },
      el("summary", { style: "cursor: pointer;" }, "Show technical details"),
      el("pre", {
        style: "white-space: pre-wrap; word-break: break-word; margin: 6px 0; padding: 8px; background: #f3f4f6; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 11px;",
      }, raw),
    );
    children.push(details);
  }

  children.push(
    el("button", {
      class: "btn btn-primary",
      onclick: async () => {
        await send("clear-push-state");
        await refresh();
      },
    }, "Retry"),
  );

  $view.replaceChildren(...children);
}

// ---------- Boot ----------

refresh();
