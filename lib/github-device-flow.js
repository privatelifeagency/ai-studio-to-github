// GitHub OAuth Device Flow client.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

export async function startDeviceFlow(clientId, scopes) {
  const r = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: scopes }),
  });
  if (!r.ok) {
    throw new Error(`device-code request failed: ${r.status}`);
  }
  const data = await r.json();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
  };
}

// pollForToken resolves when the user authorizes (returning {accessToken,
// tokenType, scope}), rejects on terminal error, or rejects with code:"cancelled"
// if the abortSignal fires.
export async function pollForToken(clientId, deviceCode, intervalSeconds, abortSignal) {
  let interval = intervalSeconds;
  while (true) {
    if (abortSignal?.aborted) {
      const err = new Error("Login cancelled");
      err.code = "cancelled";
      throw err;
    }
    await sleep(interval * 1000, abortSignal);
    if (abortSignal?.aborted) {
      const err = new Error("Login cancelled");
      err.code = "cancelled";
      throw err;
    }
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = await r.json();
    if (data.access_token) {
      return {
        accessToken: data.access_token,
        tokenType: data.token_type,
        scope: data.scope,
      };
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      interval = (data.interval || interval) + 1;
      continue;
    }
    // Terminal errors: expired_token, unsupported_grant_type, incorrect_client_credentials,
    // incorrect_device_code, access_denied, device_flow_disabled
    const err = new Error(`device flow error: ${data.error || "unknown"} — ${data.error_description || ""}`);
    err.code = data.error || "unknown";
    throw err;
  }
}

function sleep(ms, abortSignal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    }
  });
}
