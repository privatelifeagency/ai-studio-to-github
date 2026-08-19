// Client ID of the public GitHub OAuth App used by this extension for the
// Device Flow login. Not a secret — Client IDs are visible to any user who
// goes through the authorization screen. Each user's access token stays
// local to their browser; nothing about the auth flow touches the OAuth
// App owner's machine.
//
// If you fork this extension and want to use your own OAuth App: copy
// config.example.js to config.js and paste your own Client ID here.

export const GITHUB_CLIENT_ID = "Ov23liOr9V8RNH5rgR57";

// OAuth scopes requested during Device Flow. `repo` gives read+write access
// to private and public repos, which is required so users can push backups
// to either visibility.
export const GITHUB_SCOPES = "repo";
