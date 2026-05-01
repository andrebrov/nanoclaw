/**
 * OAuth 2.0 token manager for MCP server authentication.
 *
 * Supports client_credentials (machine-to-machine) and refresh_token
 * (user-delegated) grant types. Tokens are cached in-process and refreshed
 * before expiry so the agent never sees a 401 from stale credentials.
 *
 * Token state is per-container — on restart the agent-runner re-acquires
 * fresh tokens. For short-lived sessions this is acceptable; for long
 * sessions the cache.expiresAt guard triggers a mid-session refresh.
 */

export interface OAuthConfig {
  /** Token endpoint (e.g. https://auth.example.com/oauth/token) */
  tokenUrl: string;
  /** Grant type: service-to-service or user-delegated refresh */
  grantType: 'client_credentials' | 'refresh_token';
  clientId: string;
  clientSecret?: string;
  /** Required for refresh_token grant; may be updated on each refresh response */
  refreshToken?: string;
  /** Space-separated scope string (optional) */
  scope?: string;
}

interface TokenState {
  accessToken: string;
  /** unix ms: when to stop using the cached token (60 s before actual expiry) */
  expiresAt: number;
  /** Updated refresh token returned by some servers on each refresh exchange */
  refreshToken?: string;
}

function log(msg: string): void {
  console.error(`[oauth] ${msg}`);
}

function cacheKey(cfg: OAuthConfig): string {
  return `${cfg.tokenUrl}\x00${cfg.clientId}\x00${cfg.grantType}`;
}

const tokenCache = new Map<string, TokenState>();

async function fetchToken(cfg: OAuthConfig, overrideRefreshToken?: string): Promise<TokenState> {
  const params = new URLSearchParams();
  params.set('grant_type', cfg.grantType);
  params.set('client_id', cfg.clientId);
  if (cfg.clientSecret) params.set('client_secret', cfg.clientSecret);
  if (cfg.scope) params.set('scope', cfg.scope);

  if (cfg.grantType === 'refresh_token') {
    const rt = overrideRefreshToken ?? cfg.refreshToken;
    if (!rt) throw new Error('refresh_token grant requires a refresh_token value');
    params.set('refresh_token', rt);
  }

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error('token response missing access_token field');
  }

  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  // Subtract 60 s so we refresh before the server rejects it.
  const expiresAt = Date.now() + Math.max(expiresIn - 60, 0) * 1000;

  return { accessToken: data.access_token, expiresAt, refreshToken: data.refresh_token };
}

/**
 * Return a current access token for the given OAuth config.
 *
 * - First call: exchanges credentials for a token and caches it.
 * - Subsequent calls within the token's lifetime: returns the cached token.
 * - After expiry: performs a refresh (refresh_token) or re-acquires
 *   (client_credentials) and updates the cache.
 */
export async function getAccessToken(cfg: OAuthConfig): Promise<string> {
  const key = cacheKey(cfg);
  const cached = tokenCache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  // Refresh or re-acquire
  let state: TokenState;
  if (cached?.refreshToken && cfg.grantType === 'refresh_token') {
    try {
      state = await fetchToken(cfg, cached.refreshToken);
    } catch (err) {
      log(`refresh failed, re-acquiring: ${err instanceof Error ? err.message : String(err)}`);
      state = await fetchToken(cfg);
    }
  } else {
    state = await fetchToken(cfg);
  }

  tokenCache.set(key, state);
  return state.accessToken;
}
