// Thin typed wrapper over chrome.storage.local. Schema documented in spec §6.

const KEY_GITHUB = "github";
const KEY_MAPPINGS = "projectMappings";

export async function getGithubAuth() {
  const r = await chrome.storage.local.get(KEY_GITHUB);
  return r[KEY_GITHUB] || null;
}

export async function setGithubAuth(accessToken, user) {
  await chrome.storage.local.set({
    [KEY_GITHUB]: {
      accessToken,
      tokenObtainedAt: new Date().toISOString(),
      user,
    },
  });
}

export async function clearGithubAuth() {
  await chrome.storage.local.remove(KEY_GITHUB);
}

export async function getProjectMapping(projectId) {
  const r = await chrome.storage.local.get(KEY_MAPPINGS);
  const all = r[KEY_MAPPINGS] || {};
  return all[projectId] || null;
}

export async function setProjectMapping(projectId, mapping) {
  const r = await chrome.storage.local.get(KEY_MAPPINGS);
  const all = r[KEY_MAPPINGS] || {};
  all[projectId] = mapping;
  await chrome.storage.local.set({ [KEY_MAPPINGS]: all });
}

export async function removeProjectMapping(projectId) {
  const r = await chrome.storage.local.get(KEY_MAPPINGS);
  const all = r[KEY_MAPPINGS] || {};
  delete all[projectId];
  await chrome.storage.local.set({ [KEY_MAPPINGS]: all });
}
