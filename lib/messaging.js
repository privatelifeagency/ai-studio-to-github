// Typed message names exchanged between layers. Single source of truth so
// content-script ↔ background ↔ popup stay in sync.

export const MSG = {
  // page-hook → content-script (via window.postMessage)
  WINDOW_CONTEXT: "window:context",
  WINDOW_BUTTON_CLICKED: "window:button-clicked",

  // content-script → background (chrome.runtime.sendMessage)
  CONTEXT_UPDATE: "context-update",
  BUTTON_CLICKED: "button-clicked",

  // popup → background
  GET_UI_STATE: "get-ui-state",
  BEGIN_LOGIN: "begin-login",
  CANCEL_LOGIN: "cancel-login",
  GET_LOGIN_PROGRESS: "get-login-progress",
  LIST_REPOS: "list-repos",
  BEGIN_PUSH: "begin-push",
  CLEAR_MAPPING: "clear-mapping",
  GET_PUSH_PROGRESS: "get-push-progress",
  LOGOUT: "logout",

  // background → content-script (request-response)
  FETCH_GHL_PROJECT_METADATA: "fetch-ghl-project-metadata",
  FETCH_GHL_PROJECT_FILES: "fetch-ghl-project-files",
};

// Postmessage origin marker so both ends can filter out foreign messages.
export const POSTMESSAGE_SOURCE = "ghl-aistudio-exporter";
