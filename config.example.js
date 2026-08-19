// Template for forks of this extension. The shipped config.js already has
// a working Client ID — you only need this file if you want to ship your
// own version of the extension under a different OAuth App identity.
//
// To use your own OAuth App:
//   1. github.com/settings/developers → "New OAuth App"
//   2. Tick "Enable Device Flow" on the app's settings page
//   3. Copy the Client ID below
//   4. cp config.example.js config.js   (overwrite the shipped one)

export const GITHUB_CLIENT_ID = "Ov23liREPLACE_ME_WITH_YOUR_CLIENT_ID";
export const GITHUB_SCOPES = "repo";
