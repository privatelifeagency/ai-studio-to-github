// Marker file written to the root of any repo this extension manages.
// Path: .ghl-aistudio-sync.json
//
// Presence + matching projectId is how we tell "this repo is OURS to overwrite"
// vs "this repo has unrelated content, refuse to push".

export const MARKER_FILENAME = ".ghl-aistudio-sync.json";

export function buildMarkerContent({
  projectId,
  locationId,
  projectName,
  firstSyncedAt,
  lastSyncedAt,
  extensionVersion,
}) {
  if (!projectId || !locationId) {
    throw new Error("buildMarkerContent: projectId and locationId are required");
  }
  const obj = {
    schema: "ghl-aistudio-sync@1",
    aiStudioProjectId: String(projectId),
    aiStudioLocationId: String(locationId),
    projectName: projectName || null,
    firstSyncedAt,
    lastSyncedAt,
    extensionVersion: extensionVersion || null,
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

export function parseMarker(jsonString) {
  if (typeof jsonString !== "string" || jsonString.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.aiStudioProjectId) return null;
  return {
    schema: parsed.schema || null,
    projectId: String(parsed.aiStudioProjectId),
    locationId: parsed.aiStudioLocationId ? String(parsed.aiStudioLocationId) : null,
    projectName: parsed.projectName || null,
    firstSyncedAt: parsed.firstSyncedAt || null,
    lastSyncedAt: parsed.lastSyncedAt || null,
    extensionVersion: parsed.extensionVersion || null,
  };
}
