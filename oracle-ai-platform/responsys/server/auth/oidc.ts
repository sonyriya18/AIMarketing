/**
 * OIDC Authorization Code flow with PKCE, state, and nonce (openid-client).
 * Login state is persisted server-side for ten minutes and consumed exactly once.
 */
import * as client from 'openid-client';
import type { Db } from '../db/pool';
import type { AppConfig } from '../config';
import { AppError } from '../http/errors';

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;

  constructor(private readonly cfg: AppConfig, private readonly db: Db) {}

  get redirectUri() {
    return new URL('/api/v1/auth/oidc/callback', this.cfg.APP_BASE_URL).toString();
  }

  private config(): Promise<client.Configuration> {
    if (!this.configPromise) {
      const issuer = new URL(this.cfg.OIDC_ISSUER_URL);
      const insecure = issuer.protocol === 'http:';
      if (insecure && this.cfg.isProduction) throw new AppError('dependency_unavailable', 'OIDC issuer must use https');
      this.configPromise = client
        .discovery(issuer, this.cfg.OIDC_CLIENT_ID, this.cfg.OIDC_CLIENT_SECRET || undefined, undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined)
        .catch((err) => {
          this.configPromise = null;
          throw new AppError('dependency_unavailable', `Identity provider discovery failed: ${(err as Error).message}`, undefined, true);
        });
    }
    return this.configPromise;
  }

  async beginLogin(returnTo: string): Promise<string> {
    const config = await this.config();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    await this.db.withSystem(async (tx) => {
      await tx.query(`DELETE FROM oidc_login_states WHERE expires_at < now()`);
      await tx.query(
        `INSERT INTO oidc_login_states (state, code_verifier, nonce, return_to, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [state, codeVerifier, nonce, safeReturnTo(returnTo)]
      );
    });
    return client
      .buildAuthorizationUrl(config, {
        redirect_uri: this.redirectUri,
        scope: 'openid email profile',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      .toString();
  }

  async completeLogin(callbackUrl: URL): Promise<{ identity: OidcIdentity; returnTo: string }> {
    const config = await this.config();
    const state = callbackUrl.searchParams.get('state') || '';
    const saved = await this.db.withSystem(async (tx) => {
      const { rows } = await tx.query<{ code_verifier: string; nonce: string; return_to: string }>(
        `DELETE FROM oidc_login_states WHERE state = $1 AND expires_at > now() RETURNING code_verifier, nonce, return_to`,
        [state]
      );
      return rows[0];
    });
    if (!saved) throw new AppError('unauthenticated', 'The sign-in attempt expired or was already used. Please sign in again.');
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: saved.code_verifier,
        expectedState: state,
        expectedNonce: saved.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw new AppError('unauthenticated', `Sign-in failed: ${(err as Error).message}`);
    }
    const claims = tokens.claims();
    if (!claims?.sub || typeof claims.email !== 'string') {
      throw new AppError('unauthenticated', 'The identity provider did not return an email address');
    }
    return {
      identity: {
        issuer: String(claims.iss),
        subject: String(claims.sub),
        email: claims.email.toLowerCase(),
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === 'string' ? claims.name : '',
      },
      returnTo: saved.return_to,
    };
  }
}

/** Only same-origin relative paths are accepted as post-login destinations. */
export function safeReturnTo(v: string | undefined | null): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 300);
}
