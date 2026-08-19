// AI Studio ("vibe") API client. These functions run from the content script
// context (inside the leadgen-vibe-ai-builder iframe), because the bearer
// token lives in that iframe's session and CORS only permits *.leadconnectorhq.com
// origins.

const BACKEND = "https://backend.leadconnectorhq.com";

function ghlHeaders(bearer) {
  return {
    authorization: `Bearer ${bearer}`,
    channel: "APP",
    source: "WEB_USER",
    version: "2021-07-28",
    accept: "application/json, text/plain, */*",
  };
}

async function ghlGet(bearer, path) {
  const r = await fetch(`${BACKEND}${path}`, {
    method: "GET",
    headers: ghlHeaders(bearer),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`GHL GET ${path} → ${r.status}${text ? ": " + text.slice(0, 200) : ""}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function fetchProjectMetadata(bearer, projectId, locationId) {
  return ghlGet(bearer, `/vibe-ai/projects/${encodeURIComponent(projectId)}?alt_id=${encodeURIComponent(locationId)}&alt_type=location`);
}

export async function fetchProjectFiles(bearer, projectId, locationId) {
  const arr = await ghlGet(bearer, `/vibe-ai/projects/${encodeURIComponent(projectId)}/files?alt_id=${encodeURIComponent(locationId)}&alt_type=location`);
  if (!Array.isArray(arr)) {
    throw new Error("GHL /files returned non-array");
  }
  return arr;
}
