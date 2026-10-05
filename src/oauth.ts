export interface StoredAuthCode {
  code: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  atlassianAccessToken: string;
  atlassianRefreshToken?: string;
  expiresAt: number;
}

export interface StoredSession {
  mcpAccessToken: string;
  mcpRefreshToken: string;
  atlassianAccessToken: string;
  atlassianRefreshToken?: string;
  expiresAt: number;
  createdAt: number;
}

export interface OAuthStatePayload {
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientId: string;
  atlassianCodeVerifier?: string;
  timestamp: number;
}

/**
 * Generates a high-entropy PKCE code verifier (base64url encoded 32 random bytes).
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Computes S256 code challenge for PKCE.
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Signs state with HMAC-SHA256.
 */
export async function signState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = JSON.stringify(payload);
  const base64Data = btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base64Data));
  const base64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${base64Data}.${base64Sig}`;
}

/**
 * Verifies signed state.
 */
export async function verifyState(signedState: string, secret: string): Promise<OAuthStatePayload | null> {
  const parts = signedState.split(".");
  if (parts.length !== 2) return null;

  const [base64Data, base64Sig] = parts;
  const encoder = new TextEncoder();

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigStr = atob(base64Sig.replace(/-/g, "+").replace(/_/g, "/"));
    const sigBytes = new Uint8Array(sigStr.length);
    for (let i = 0; i < sigStr.length; i++) {
      sigBytes[i] = sigStr.charCodeAt(i);
    }

    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(base64Data));
    if (!valid) return null;

    const jsonStr = atob(base64Data.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(jsonStr) as OAuthStatePayload;

    // Check expiration (max 15 mins)
    if (Date.now() - payload.timestamp > 15 * 60 * 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Verifies a PKCE code_verifier against a code_challenge.
 */
export async function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  codeChallengeMethod: string = "S256"
): Promise<boolean> {
  if (codeChallengeMethod === "plain") {
    return codeVerifier === codeChallenge;
  }

  if (codeChallengeMethod === "S256") {
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return base64 === codeChallenge;
  }

  return false;
}

/**
 * Exchanges authorization code with Atlassian.
 */
export async function exchangeAtlassianCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const bodyPayload: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri
  };

  if (codeVerifier) {
    bodyPayload.code_verifier = codeVerifier;
  }

  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(bodyPayload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to exchange Atlassian code: ${res.status} ${errorText}`);
  }

  return res.json();
}

/**
 * Refreshes an expired Atlassian access token.
 */
export async function refreshAtlassianToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to refresh Atlassian token: ${res.status} ${errorText}`);
  }

  return res.json();
}
