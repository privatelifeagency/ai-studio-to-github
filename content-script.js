// content-script.js — runs in the ISOLATED world of the iframe at
// leadgen-vibe-ai-builder.leadconnectorhq.com.
//
// Three jobs:
//   (1) Inject page-hook.js into the MAIN world so it can patch fetch/XHR.
//   (2) Bridge window.postMessage from the MAIN world to the background
//       service worker (chrome.runtime.sendMessage).
//   (3) On demand from the service worker, fetch GHL API data using the
//       captured bearer (must run from this origin to satisfy CORS).

(function () {
  const POSTMESSAGE_SOURCE = "ghl-aistudio-exporter";
  const BACKEND = "https://backend.leadconnectorhq.com";

  // --- Inject page-hook.js into MAIN world ---
  // The script tag is removed after load so the SPA's DOM stays clean.
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page-hook.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    console.warn("[ghl-aistudio-exporter] failed to inject page-hook:", e);
  }

  // --- Receive messages from MAIN world ---
  let context = { bearer: null, projectId: null, locationId: null, projectName: null, capturedAt: 0 };
  let metadataFetchedFor = null; // projectId for which we already pre-fetched metadata

  async function maybePrefetchProjectName() {
    // Lazy-fetch project metadata when we have everything needed but no name yet.
    // This makes the popup's default repo name a slugified project name instead
    // of the raw numeric project ID.
    if (!context.bearer || !context.projectId || !context.locationId) return;
    if (context.projectName) return;
    if (metadataFetchedFor === context.projectId) return;
    metadataFetchedFor = context.projectId;
    try {
      const data = await ghlGet(
        `/vibe-ai/projects/${encodeURIComponent(context.projectId)}?alt_id=${encodeURIComponent(context.locationId)}&alt_type=location`,
      );
      if (data && data.name) {
        context = { ...context, projectName: data.name };
        chrome.runtime.sendMessage({ type: "context-update", payload: context }).catch(() => {});
      }
    } catch {
      // Best-effort only — popup will fall back to the project ID.
      metadataFetchedFor = null; // allow a retry on next context update
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== POSTMESSAGE_SOURCE) return;

    if (data.type === "window:context") {
      const incoming = data.payload;
      // When the projectId actually changes (user switched to another AI
      // Studio project without reloading), drop any cached projectName so
      // the prefetch re-runs for the new project. Without this reset the
      // truthy-projectName guard in maybePrefetchProjectName would short-
      // circuit and we'd keep showing the previous project's name.
      if (incoming.projectId && incoming.projectId !== context.projectId) {
        context.projectName = null;
        metadataFetchedFor = null;
      }
      context = { ...context, ...incoming };
      chrome.runtime.sendMessage({ type: "context-update", payload: context }).catch(() => {});
      maybePrefetchProjectName();
    } else if (data.type === "window:button-clicked") {
      // Show the in-page modal. The whole flow (login → choose repo → push)
      // happens inside it; the user never needs to click the extension icon.
      showModal();
      // Also notify background (used as a heartbeat / hook for telemetry).
      chrome.runtime.sendMessage({ type: "button-clicked", payload: { projectId: context.projectId } }).catch(() => {});
    } else if (data.type === "window:close-modal") {
      closeModal();
    }
  });

  // --- In-page modal hosting popup.html ---
  const MODAL_ID = "ghl-aistudio-exporter-modal";

  function ensureModalStyles() {
    if (document.getElementById(MODAL_ID + "-styles")) return;
    const style = document.createElement("style");
    style.id = MODAL_ID + "-styles";
    style.textContent = `
      @keyframes ghl-exp-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes ghl-exp-scale {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: scale(1); }
      }
      #${MODAL_ID} {
        position: fixed; inset: 0;
        background: rgba(15,23,42,0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        animation: ghl-exp-fade 0.18s ease;
      }
      #${MODAL_ID} .ghl-exp-card {
        position: relative;
        width: 420px;
        max-width: calc(100vw - 32px);
        height: 620px;
        max-height: calc(100vh - 32px);
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 24px 60px rgba(0,0,0,0.30);
        overflow: hidden;
        animation: ghl-exp-scale 0.20s ease;
      }
      #${MODAL_ID} .ghl-exp-close {
        position: absolute; top: 8px; right: 8px;
        width: 28px; height: 28px;
        border: none; background: rgba(0,0,0,0.05);
        color: #374151; font-size: 18px; font-weight: 500;
        border-radius: 50%; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        z-index: 2; line-height: 1; padding: 0;
        transition: background 0.12s ease;
      }
      #${MODAL_ID} .ghl-exp-close:hover { background: rgba(0,0,0,0.10); }
      #${MODAL_ID} iframe {
        width: 100%; height: 100%;
        border: 0; display: block;
      }
    `;
    document.documentElement.appendChild(style);
  }

  let escHandlerInstalled = null;

  function showModal() {
    ensureModalStyles();
    if (document.getElementById(MODAL_ID)) return; // already open

    const backdrop = document.createElement("div");
    backdrop.id = MODAL_ID;

    const card = document.createElement("div");
    card.className = "ghl-exp-card";

    const closeBtn = document.createElement("button");
    closeBtn.className = "ghl-exp-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.onclick = closeModal;

    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("popup.html") + "?inline=1";
    frame.title = "GHL AI Studio → GitHub";

    card.append(frame, closeBtn);
    backdrop.append(card);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal();
    });

    escHandlerInstalled = (e) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", escHandlerInstalled);

    document.body.appendChild(backdrop);
  }

  function closeModal() {
    const m = document.getElementById(MODAL_ID);
    if (m) m.remove();
    if (escHandlerInstalled) {
      document.removeEventListener("keydown", escHandlerInstalled);
      escHandlerInstalled = null;
    }
  }

  // --- Respond to background requests ---
  // The service worker can't call backend.leadconnectorhq.com directly with
  // a user bearer (CORS would reject from an extension origin). So it asks
  // the content script to perform the call.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;

    if (msg.type === "fetch-ghl-project-metadata") {
      handleFetchMetadata().then(sendResponse).catch((e) =>
        sendResponse({ ok: false, error: String(e?.message || e), status: e?.status })
      );
      return true; // keep channel open for async response
    }

    if (msg.type === "fetch-ghl-project-files") {
      handleFetchFiles().then(sendResponse).catch((e) =>
        sendResponse({ ok: false, error: String(e?.message || e), status: e?.status })
      );
      return true;
    }

    if (msg.type === "get-current-context") {
      sendResponse({ ok: true, data: context });
      return false;
    }

    return false;
  });

  async function handleFetchMetadata() {
    requireContext();
    const data = await ghlGet(
      `/vibe-ai/projects/${encodeURIComponent(context.projectId)}?alt_id=${encodeURIComponent(context.locationId)}&alt_type=location`,
    );
    return { ok: true, data };
  }

  async function handleFetchFiles() {
    requireContext();
    const data = await ghlGet(
      `/vibe-ai/projects/${encodeURIComponent(context.projectId)}/files?alt_id=${encodeURIComponent(context.locationId)}&alt_type=location`,
    );
    if (!Array.isArray(data)) {
      throw new Error("GHL /files returned non-array");
    }
    return { ok: true, data };
  }

  function requireContext() {
    if (!context.bearer) {
      const err = new Error("No bearer captured yet — interact with AI Studio once, then retry.");
      err.status = 0;
      throw err;
    }
    if (!context.projectId || !context.locationId) {
      const err = new Error("Project context not detected — open an AI Studio project first.");
      err.status = 0;
      throw err;
    }
  }

  async function ghlGet(path) {
    const r = await fetch(`${BACKEND}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${context.bearer}`,
        channel: "APP",
        source: "WEB_USER",
        version: "2021-07-28",
        accept: "application/json, text/plain, */*",
      },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(`GHL GET ${path} → ${r.status}${text ? ": " + text.slice(0, 200) : ""}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }
})();
