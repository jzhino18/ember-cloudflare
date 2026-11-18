import { CURRENT_PASSWORD_WRONG, isPasswordTooLong, isRoomId, PROFILE_PATH, SIGN_IN_LIMITED, type RoomId } from "@ember/protocol";
import {
  CHECK_IN_ROOMS_PATH,
  DISCORD_CALLBACK_PATH,
  DISCORD_CONNECTION_PATH,
  DISCORD_ISSUER,
  DISCORD_OUTCOMES,
  DISCORD_PROBLEM_PARAM,
  type DiscordConnectionStart,
  type DiscordOutcome,
  type DiscordStatus,
} from "@ember/protocol/check-ins";
import { authenticate, cookieValues, credentialsOf, hostCookie, hostCookieName, newSessionToken, tokenDigest } from "./auth";
import { jsonBodyOf } from "./bodies";
import { DISCORD_ROUND_TRIP_MS } from "./check-ins";
import { authorizeUrl, discordKeysOf, discordUserFor, newPkce } from "./discord-api";
import type { Env } from "./env";
import { passwordHasher } from "./passwords";
import { urlOf } from "./request-url";
import { seal, unseal } from "./sealed";
import { isToken } from "./secrets";
import { workspace } from "./workspace";

// The Worker's routes for check-in rooms (docs/specs/discord-check-in-rooms.md): connecting Discord,
// the callback Discord sends the browser back to, and checking in. Connecting follows Connect
// Memberful (memberful.ts): the password first, then a one-time state kept in a cookie and, as its
// digest, by the Workspace, plus PKCE, whose verifier the Workspace keeps sealed.

/** The cookie that keeps a trip's state until Discord sends the browser back. */
const STATE_COOKIE = "discord_state";

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);
const problem = (status: number, message: string) => json({ error: message }, { status });
const ipOf = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/** Where Discord sends the browser back: this address's callback, which the Discord application must list exactly. */
const redirectUriFor = (request: Request) => new URL(DISCORD_CALLBACK_PATH, urlOf(request).origin).href;

/** A room's page in the web app. */
const roomPage = (roomId: RoomId) => `/rooms/${encodeURIComponent(roomId)}`;

/** The Discord API's routes, if one takes the request. The callback, a page, is `finishDiscordConnection`. */
export function discordAction(request: Request, env: Env, pathname: string): (() => Promise<Response>) | null {
  const { method } = request;
  if (pathname === DISCORD_CONNECTION_PATH && method === "GET") return () => discordStatus(request, env);
  if (pathname === DISCORD_CONNECTION_PATH && method === "POST") return () => startConnecting(request, env);
  if (pathname === DISCORD_CONNECTION_PATH && method === "DELETE") return () => disconnect(request, env);
  if (pathname === CHECK_IN_ROOMS_PATH && method === "GET") return () => roomsToJoin(request, env);
  // Room ids never need percent-encoding, so an encoded segment can only be an unknown room.
  const checkIn = pathname.match(/^\/api\/rooms\/([^/]+)\/check_in$/)?.[1];
  if (checkIn && method === "POST") return () => inRoom(checkIn, (roomId) => checkInTo(request, env, roomId));
  const rule = pathname.match(/^\/api\/rooms\/([^/]+)\/check_in_rule$/)?.[1];
  if (rule && method === "GET") return () => inRoom(rule, (roomId) => ruleOf(request, env, roomId));
  if (rule && (method === "PUT" || method === "DELETE")) return () => inRoom(rule, (roomId) => setRule(request, env, roomId, method === "PUT"));
  return null;
}

const inRoom = async (roomId: string, answer: (roomId: RoomId) => Promise<Response>) => (isRoomId(roomId) ? answer(roomId) : problem(404, "Room not found"));

/** GET: whether this Ember can connect Discord, and the account you've connected. */
async function discordStatus(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const status = credentials && (await workspace(env).discordStatusOf(credentials));
  if (!status) return problem(401, "Not signed in");
  const answer: DiscordStatus = {
    available: discordKeysOf(env) !== null,
    connected: status.name === null ? null : { name: status.name },
    needsPassword: status.hasPassword,
  };
  return json(answer, { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST `{ currentPassword, roomId? }`: once your password checks out (while you have one, so that holding
 * your session isn't enough), answers the page at Discord to go to, with the cookie that keeps the trip's
 * state. With `roomId`, coming back also checks you in to that room. 401 signed out, 403 for a guest or
 * without Discord's keys, 409 once you've connected, 422 for a missing or wrong password, 429 past
 * sign-in's limit.
 */
async function startConnecting(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, "Not signed in");
  const keys = discordKeysOf(env);
  if (!keys) return problem(403, DISCORD_OUTCOMES.unavailable);
  const body = await jsonBodyOf(request);
  const { currentPassword, roomId = null } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (roomId !== null && (typeof roomId !== "string" || !isRoomId(roomId))) return problem(422, "Room must be a room's id");
  const check = await workspace(env).discordConnectionCheck(credentials, ipOf(request));
  if (!check) return problem(401, "Not signed in");
  if (check === "limited") return problem(429, SIGN_IN_LIMITED);
  if (check === "forbidden") return problem(403, "Guests can't connect Discord");
  if (check === "connected") return problem(409, "You've connected Discord already");
  if (check.passwordDigest !== "") {
    if (typeof currentPassword !== "string" || !currentPassword) return problem(422, "Enter your password to connect Discord");
    // One longer than the form takes is nobody's, as at sign-in.
    if (isPasswordTooLong(currentPassword) || !(await passwordHasher(env).verify(currentPassword, check.passwordDigest)).matches) return problem(422, CURRENT_PASSWORD_WRONG);
  }
  const state = newSessionToken();
  const { verifier, challenge } = await newPkce();
  const sealedVerifier = await seal(env.SESSION_SECRET, "discord-verifier", verifier);
  const stateDigest = await tokenDigest(state, env.SESSION_SECRET);
  if (!(await workspace(env).startDiscordConnection(check.userId, check.passwordDigest, stateDigest, sealedVerifier, roomId))) {
    // Something changed meanwhile, such as their password.
    return problem(409, "Connecting Discord didn't start. Try again.");
  }
  const answer: DiscordConnectionStart = { url: authorizeUrl(keys, redirectUriFor(request), state, challenge) };
  const cookie = hostCookie(request, STATE_COOKIE, state, DISCORD_ROUND_TRIP_MS / 1000);
  return json(answer, { status: 202, headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
}

/** DELETE: unlinks your Discord account, which takes you out of every check-in room. 204, or 404 when you hadn't connected one. */
async function disconnect(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const done = credentials && (await workspace(env).disconnectDiscord(credentials));
  if (!done) return problem(401, "Not signed in");
  return done === "not connected" ? problem(404, "You haven't connected Discord") : new Response(null, { status: 204 });
}

/**
 * `GET /auth/discord/callback`, where Discord sends the browser back: takes the trip its cookie's state
 * started (once, within ten minutes), trades the code for who signed in, links that Discord account, and
 * checks them in to the room the trip was for. Then opens that room, or the page it came from, saying
 * how it went. The state cookie is forgotten whatever happens.
 */
export async function finishDiscordConnection(request: Request, env: Env): Promise<Response> {
  const answer = await connectedWithDiscord(request, env);
  answer.headers.append("Set-Cookie", hostCookie(request, STATE_COOKIE, "", 0));
  return answer;
}

async function connectedWithDiscord(request: Request, env: Env): Promise<Response> {
  const params = urlOf(request).searchParams;
  const [kept] = cookieValues(request, hostCookieName(request, STATE_COOKIE));
  const state = params.get("state");
  const keys = discordKeysOf(env);
  if (!keys) return backTo(request, PROFILE_PATH, "unavailable");
  // A state this browser didn't start with, as another site's link to the callback would bring, connects nothing.
  if (!kept || state === null || !(await isToken(state, kept))) return backTo(request, PROFILE_PATH, "failed");
  const pending = await workspace(env).takeDiscordConnection(ipOf(request), await tokenDigest(kept, env.SESSION_SECRET));
  if (pending === "limited") return backTo(request, PROFILE_PATH, "limited");
  if (pending === "expired") return backTo(request, PROFILE_PATH, "failed");
  const page = pending.roomId === null ? PROFILE_PATH : roomPage(pending.roomId);
  // Only whoever started the trip, still signed in on this browser, finishes it.
  if ((await authenticate(request, env))?.user.id !== pending.userId) return backTo(request, page, "failed");
  // RFC 9207: Discord names itself as the issuer, so a code from anywhere else is refused.
  const issuer = params.get("iss");
  if (issuer !== null && issuer !== DISCORD_ISSUER) return backTo(request, page, "failed");
  if (params.get("error") === "access_denied") return backTo(request, page, "denied");
  const code = params.get("code");
  const verifier = await unseal(env.SESSION_SECRET, "discord-verifier", pending.sealedVerifier);
  if (!code || !verifier) return backTo(request, page, "failed");
  const discord = await discordUserFor(keys, code, verifier, redirectUriFor(request));
  if (discord === "busy" || discord === "failed") return backTo(request, page, discord);
  const linked = await workspace(env).connectDiscord(pending, discord);
  if (linked === "refused") return backTo(request, page, "failed");
  if (linked !== "linked") return backTo(request, page, linked);
  return pending.roomId === null ? backTo(request, page, "connected") : redirect(new URL(page, request.url).href);
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });

/** Sends the browser to `page` of the web app, which says how connecting went. */
function backTo(request: Request, page: string, outcome: DiscordOutcome): Response {
  const url = new URL(page, request.url);
  url.searchParams.set(DISCORD_PROBLEM_PARAM, outcome);
  return redirect(url.href);
}

/** GET: the check-in rooms you aren't in, for Rooms to join. */
async function roomsToJoin(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const rooms = credentials && (await workspace(env).checkInRooms(credentials));
  return rooms ? json({ checkInRooms: rooms }, { headers: { "Cache-Control": "no-store" } }) : problem(401, "Not signed in");
}

/** POST: checks you in to a check-in room, once you've connected Discord. 200 with the room's id, 409 before you've connected. */
async function checkInTo(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const joined = credentials && (await workspace(env).checkIn(credentials, roomId));
  if (!joined) return problem(401, "Not signed in");
  if (joined === "not found") return problem(404, "Room not found");
  if (joined === "not connected") return problem(409, "Connect Discord first");
  return json({ roomId });
}

/** GET: what a room's check-in rule says to you, one of its members. */
async function ruleOf(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const rule = credentials && (await workspace(env).checkInRule(credentials, roomId));
  if (!rule) return problem(401, "Not signed in");
  return rule === "not found" ? problem(404, "Room not found") : json(rule, { headers: { "Cache-Control": "no-store" } });
}

/** PUT turns check-in on for a private room, DELETE turns it off, for whoever can change the room. */
async function setRule(request: Request, env: Env, roomId: RoomId, on: boolean): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const rule = credentials && (await workspace(env).setCheckInRule(credentials, roomId, on));
  if (!rule) return problem(401, "Not signed in");
  if (rule === "not found") return problem(404, "Room not found");
  if (rule === "forbidden") return problem(403, "Only administrators and the room's creator can change it");
  if (rule === "open") return problem(422, "Only private rooms can ask people to check in");
  if (rule === "not connected") return problem(409, "Connect Discord first, or turning check-in on would take you out of the room");
  return json(rule);
}
