// page-hook.js — runs in the MAIN world of the iframe at
// leadgen-vibe-ai-builder.leadconnectorhq.com.
//
//   (1) Capture the live `Authorization: Bearer <jwt>` header on outgoing
//       requests to backend.leadconnectorhq.com/vibe-ai/... so the rest of
//       the extension can replay GHL API calls.
//   (2) Inject the "Export to GitHub" button into the editor toolbar,
//       left of the Publish button.
//   (3) On button click, show an in-page tooltip pointing at the extension
//       icon (since opening the popup programmatically from a content-script-
//       relayed click isn't supported reliably).

(function () {
  const POSTMESSAGE_SOURCE = "ghl-aistudio-exporter";
  const BACKEND_HOST = "backend.leadconnectorhq.com";

  let latestBearer = null;
  let latestProjectId = null;
  let latestLocationId = null;

  // Try the iframe URL first — it carries /vibe/projects/{id}.
  function tryReadIdsFromUrl() {
    try {
      const m = window.location.pathname.match(/\/location\/([^\/]+)\/vibe\/projects\/([^\/?#]+)/);
      if (m) {
        if (latestLocationId !== m[1]) latestLocationId = m[1];
        if (latestProjectId !== m[2]) latestProjectId = m[2];
      }
    } catch {}
  }
  tryReadIdsFromUrl();

  function broadcastContext() {
    if (!latestProjectId) return;
    window.postMessage(
      {
        source: POSTMESSAGE_SOURCE,
        type: "window:context",
        payload: {
          bearer: latestBearer,
          projectId: latestProjectId,
          locationId: latestLocationId,
          capturedAt: Date.now(),
        },
      },
      "*",
    );
  }

  function captureFromUrl(url) {
    try {
      const u = new URL(url, window.location.href);
      if (u.host !== BACKEND_HOST) return false;
      const m = u.pathname.match(/\/vibe-ai\/projects\/([^\/?#]+)/);
      let changed = false;
      if (m && latestProjectId !== m[1]) {
        latestProjectId = m[1];
        changed = true;
      }
      const loc = u.searchParams.get("alt_id");
      if (loc && latestLocationId !== loc) {
        latestLocationId = loc;
        changed = true;
      }
      return changed;
    } catch {
      return false;
    }
  }

  function captureFromAuthHeader(value) {
    if (typeof value !== "string") return false;
    const m = value.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    if (latestBearer !== m[1]) {
      latestBearer = m[1];
      return true;
    }
    return false;
  }

  // --- Patch window.fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      const urlChanged = url ? captureFromUrl(url) : false;
      let authChanged = false;
      const hdrs = init?.headers;
      if (hdrs) {
        let auth;
        if (hdrs instanceof Headers) auth = hdrs.get("authorization");
        else if (Array.isArray(hdrs)) {
          const found = hdrs.find((h) => h[0]?.toLowerCase() === "authorization");
          auth = found?.[1];
        } else if (typeof hdrs === "object") {
          auth = hdrs.authorization || hdrs.Authorization;
        }
        if (auth) authChanged = captureFromAuthHeader(auth);
      }
      if (urlChanged || authChanged) broadcastContext();
    } catch {}
    return originalFetch.apply(this, arguments);
  };

  // --- Patch XMLHttpRequest ---
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (captureFromUrl(url)) broadcastContext();
    } catch {}
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (name && name.toLowerCase() === "authorization") {
        if (captureFromAuthHeader(value)) broadcastContext();
      }
    } catch {}
    return xhrSetHeader.apply(this, arguments);
  };

  const BUTTON_ID = "ghl-aistudio-exporter-btn";

  // Match Publish's height (h-8 = 32px), rounded-md (~6px), text-xs (~12px).
  // Distinct color (indigo gradient) so it's clearly third-party.
  const BUTTON_BASE_STYLE = [
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "gap: 6px",
    "height: 32px",
    "padding: 0 14px",
    "font-family: inherit",
    "font-size: 12px",
    "font-weight: 500",
    "color: #fff",
    "background: linear-gradient(135deg, #1f2937 0%, #4f46e5 100%)",
    "border: 1px solid rgba(255,255,255,0.08)",
    "border-radius: 6px",
    "cursor: pointer",
    "white-space: nowrap",
    "transition: filter 0.12s ease, transform 0.12s ease",
    "user-select: none",
    "outline: none",
  ].join(";");

  function buildButton(opts = {}) {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.setAttribute("aria-label", "Export to GitHub");
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:1px;"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg><span>Export to GitHub</span>';
    btn.style.cssText = BUTTON_BASE_STYLE + (opts.floating
      ? ";position: fixed;top: 12px;right: 12px;z-index: 2147483647;box-shadow: 0 4px 12px rgba(0,0,0,0.15)"
      : "");
    btn.onmouseenter = () => { btn.style.filter = "brightness(1.1)"; };
    btn.onmouseleave = () => { btn.style.filter = "none"; };
    btn.onmousedown = () => { btn.style.transform = "translateY(1px)"; };
    btn.onmouseup = () => { btn.style.transform = "translateY(0)"; };
    btn.onclick = () => {
      // The content script (ISOLATED world) owns the modal — we just signal.
      window.postMessage(
        { source: POSTMESSAGE_SOURCE, type: "window:button-clicked" },
        "*",
      );
    };
    return btn;
  }

  // --- Toolbar anchoring ---

  function findPublishButton() {
    return document.querySelector('[data-testid="publish-button"]')
      || Array.from(document.querySelectorAll("button")).find(
        (b) => (b.textContent || "").trim() === "Publish",
      );
  }

  function ensureButton() {
    if (!latestProjectId) return;

    const publishBtn = findPublishButton();
    const existing = document.getElementById(BUTTON_ID);

    if (existing) {
      const mode = existing.dataset.ghlExpMode;
      // If we're currently floating but Publish just appeared, upgrade
      // to anchored so the button lives in the toolbar instead of floating.
      if (mode === "floating" && publishBtn) {
        existing.remove();
        // fall through to inject anchored
      } else {
        // Already anchored, or no Publish yet — leave the current button alone.
        return;
      }
    }

    if (publishBtn) {
      // Insert as a sibling left of Publish (or its wrapper).
      // The toolbar uses flexbox with gap-2, so spacing is automatic.
      let anchor = publishBtn;
      // If Publish is wrapped (e.g. <div class="relative">), insert before
      // the wrapper to stay on the flex level.
      if (anchor.parentElement && anchor.parentElement.children.length === 1) {
        anchor = anchor.parentElement;
      }
      const btn = buildButton({ floating: false });
      btn.dataset.ghlExpMode = "anchored";
      anchor.parentNode.insertBefore(btn, anchor);
      return;
    }

    // Fallback: floating button until Publish loads.
    if (!document.body) return;
    const btn = buildButton({ floating: true });
    btn.dataset.ghlExpMode = "floating";
    document.body.appendChild(btn);
  }

  // Re-attach if the SPA strips the button.
  const observer = new MutationObserver(() => ensureButton());
  function startObserver() {
    if (!document.body) return false;
    observer.observe(document.body, { childList: true, subtree: true });
    ensureButton();
    return true;
  }
  if (!startObserver()) {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }

  // Re-evaluate periodically as a safety net (URL changes, SPA re-renders).
  setInterval(() => {
    tryReadIdsFromUrl();
    ensureButton();
  }, 2000);

  // If we already have IDs from the URL, broadcast immediately so the
  // service worker knows which project we're on (even before any XHR fires).
  if (latestProjectId && latestLocationId) broadcastContext();
})();
