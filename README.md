# GHL AI Studio → GitHub Exporter

A Chrome extension (MV3) that adds an **"Export to GitHub"** button to GoHighLevel's AI Studio editor. One click and your project is backed up to GitHub as a clean, atomic commit.

- Zero backend. All API calls run from your browser.
- GitHub OAuth Device Flow for auth. No client secret stored anywhere.
- Single atomic commit per push using the Git Data API.
- Tracks the link between the GHL project and its GitHub repo locally, so subsequent clicks re-sync to the same repo without re-prompting.
- Refuses to overwrite repos that already have unrelated content (uses a marker file at the repo root for safety).

## Install

This is an unpacked extension (not on the Chrome Web Store yet).

1. Download or clone this repo:
   ```bash
   git clone https://github.com/privatelifeagency/AI-Studio-to-Github.git
   ```
2. Open `chrome://extensions` in Chrome (or any Chromium-based browser).
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the folder you just cloned.
5. Pin the extension icon to your toolbar.

That's it. No GitHub OAuth App registration needed to get started. The extension ships with a pre-configured Client ID. On first use it asks GitHub to authorize **your** account against the extension's app, and the resulting access token lives only in your browser's local storage.

> Want to authorize against your own GitHub OAuth App instead? See [Use your own GitHub OAuth App](#use-your-own-github-oauth-app) below.

## Use

1. Open an AI Studio project in GoHighLevel.
2. An **"Export to GitHub"** button appears in the editor toolbar, next to **Publish**.
3. Click it. A modal opens centered on the editor with the full flow:
   - First time: **Login with GitHub** runs Device Flow (an 8-character code you paste on `github.com/login/device`).
   - Pick **Create new repo** (name + private/public) or **Use existing repo** (typeahead).
   - Push. All your AI Studio source files land in one commit on `main`.
4. On the next click for the same project, the modal goes straight to **Push update**, with no re-prompt.

The pushed repo is a stock Vite + React + TypeScript + Tailwind + shadcn/ui scaffold (which is what AI Studio produces). After cloning:

```bash
npm install
npm run dev
```

It runs.

## Use your own GitHub OAuth App

This step is optional. The extension already works with its bundled Client ID.

Swap in your own Client ID if you'd rather authorize against your own GitHub OAuth App, so the authorization screen shows your app and you aren't depending on anyone else's registration. It takes about two minutes.

**A Client ID is not a secret.** It is visible to anyone who reaches the authorization screen, and Device Flow uses no client secret. Each user's access token is issued straight to their own browser and never leaves it, so the person who owns the OAuth App never sees anyone else's token.

### 1. Create an OAuth App

Go to `https://github.com/settings/developers`.

Click **OAuth Apps**, then **New OAuth App**.

### 2. Fill in the form

Application name: anything you want.

Homepage URL: any valid URL (your site or your GitHub profile).

Authorization callback URL: any valid URL. Device Flow does not use it, but the field is required.

Click **Register application**.

### 3. Enable Device Flow (required)

On the app's settings page, find **Enable Device Flow** and turn it on, then save.

This is mandatory. Without it, GitHub rejects the login with a 400 error and the extension's login button will fail.

### 4. Copy your Client ID

On the same page, copy the **Client ID**. Note it is different from the App ID, so grab the one labeled Client ID.

You do not need the Client Secret. Device Flow does not use one.

### 5. Paste it into the extension

Open `config.js` in the extension folder and replace the Client ID on this line:

```js
export const GITHUB_CLIENT_ID = "your-client-id-here";
```

### 6. Reload and re-login

Go to `chrome://extensions` and click the reload icon on the extension.

Open the extension, log out, then log back in. The new login runs against your own OAuth App.

If you had already authorized a different app, revoke it at `https://github.com/settings/applications`.

## How the safety check works

On first push to any repo, the extension writes a tiny `.ghl-aistudio-sync.json` file at the repo root with the AI Studio project ID. On every subsequent push, it reads that marker:

- Marker matches the current project → push (overwriting code, preserving history).
- Marker matches a different project → refuse (you picked the wrong repo).
- Marker missing and repo has unrelated content → refuse (you'd lose someone else's work).
- Marker missing and repo is empty (or only an auto-generated README) → accept as first push.

## Running the tests

```bash
npm test
```

Pure-Node unit tests covering the marker round-trip and the GitHub push pipeline (bootstrap-on-empty-repo, the blob to tree to commit to ref sequence, and error surfacing).

## Project layout

```
manifest.json          MV3 manifest
page-hook.js           MAIN-world script (captures bearer, injects button)
content-script.js      ISOLATED-world bridge + modal host
background.js          service worker / orchestrator
popup.html/css/js      shared UI (toolbar popup AND modal iframe)
config.js              holds the GitHub OAuth Client ID
config.example.js      template for your own Client ID
lib/                   pure modules: github-client, ghl-client, marker, storage,
                       messaging, github-device-flow
tests/                 node --test unit tests
icons/                 toolbar icons
```
