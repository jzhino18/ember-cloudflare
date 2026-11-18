import type { Env } from "./env";

// Discord's OAuth2, as check-in rooms use it (docs.discord.com/developers/topics/oauth2): the
// authorization code grant with PKCE, asking only for `identify`. Ember reads who signed in, then
// revokes the token at once, so it never keeps one.

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const REVOKE_URL = "https://discord.com/api/oauth2/token/revoke";
const ME_URL = "https://discord.com/api/v10/users/@me";
const TIMEOUT_MS = 10_000;

export interface DiscordKeys {
  clientId: string;
  clientSecret: string;
}

/** A Discord account: its id, a snowflake, and the name it shows. */
export interface DiscordUser {
  id: string;
  name: string;
}

/** The Discord application's keys, from the deployment's secrets, or null without both. */
export function discordKeysOf(env: Env): DiscordKeys | null {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Bytes as unpadded base64url, the alphabet PKCE allows. */
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A new PKCE code verifier and its S256 challenge. */
export async function newPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** The page at Discord that asks the person to let Ember see who they are, then sends them to `redirectUri`. */
export function authorizeUrl(keys: DiscordKeys, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: keys.clientId,
    redirect_uri: redirectUri,
    scope: "identify",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "none",
  }).toString();
  return url.href;
}

const basicAuth = ({ clientId, clientSecret }: DiscordKeys) => `Basic ${btoa(`${clientId}:${clientSecret}`)}`;

/** A request to Discord that gives up after ten seconds and never follows a redirect. */
const ask = (url: string, init: RequestInit) => fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });

/**
 * Who signed in at Discord, by trading the callback's `code` (with the PKCE verifier) for a token, reading
 * `/users/@me` with it, and revoking it. "busy" when Discord rate limits Ember, "failed" for anything else.
 */
export async function discordUserFor(keys: DiscordKeys, code: string, verifier: string, redirectUri: string): Promise<DiscordUser | "busy" | "failed"> {
  try {
    const tokenAnswer = await ask(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(keys), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    if (tokenAnswer.status === 429) return "busy";
    if (!tokenAnswer.ok) {
      console.error(`Discord refused the code: ${tokenAnswer.status}`);
      return "failed";
    }
    const { access_token: token } = (await tokenAnswer.json()) as { access_token?: unknown };
    if (typeof token !== "string") return "failed";
    try {
      return await userOf(token);
    } finally {
      await revoke(keys, token);
    }
  } catch (error) {
    console.error("Asking Discord failed", error);
    return "failed";
  }
}

async function userOf(token: string): Promise<DiscordUser | "busy" | "failed"> {
  const answer = await ask(ME_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (answer.status === 429) return "busy";
  if (!answer.ok) return "failed";
  const { id, username, global_name } = (await answer.json()) as { id?: unknown; username?: unknown; global_name?: unknown };
  if (typeof id !== "string" || !/^\d{17,20}$/.test(id) || typeof username !== "string") return "failed";
  return { id, name: typeof global_name === "string" && global_name ? global_name : username };
}

/** Revokes the token, and with it every token of this authorization. A failure is logged, not thrown. */
async function revoke(keys: DiscordKeys, token: string): Promise<void> {
  try {
    const answer = await ask(REVOKE_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(keys), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }),
    });
    if (!answer.ok) console.error(`Discord didn't revoke a token: ${answer.status}`);
  } catch (error) {
    console.error("Revoking a Discord token failed", error);
  }
}
