export interface StoredAuthCode {
  code: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  trelloToken: string;
  expiresAt: number;
}

export interface StoredSession {
  mcpAccessToken: string;
  mcpRefreshToken: string;
  trelloToken: string;
  expiresAt: number;
  createdAt: number;
}

export interface PendingAuthRequest {
  nonce: string;
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientId: string;
  expiresAt: number;
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
