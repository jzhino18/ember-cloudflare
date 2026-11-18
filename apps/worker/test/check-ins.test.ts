import { type Me, type NewWorkspace, type RoomId, type SharedRoom } from "@ember/protocol";
import {
  CHECK_IN_ROOMS_PATH,
  checkInPath,
  checkInRulePath,
  DISCORD_CALLBACK_PATH,
  DISCORD_CONNECTION_PATH,
  MENTION_REPLY_WINDOW_MS,
  type CheckInRoom,
  type CheckInRule,
  type DiscordConnectionStart,
  type DiscordStatus,
} from "@ember/protocol/check-ins";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomEvent } from "../src/room-log";
import { ROOM_ACCESS } from "../src/workspace-store";
import { api, apiWith, cookieOf, createRoom, freshDeploy, shown, workspaceSql, workspaceStub, type Session } from "./support";

// Check-in rooms (src/check-ins.ts, src/discord.ts): connecting Discord, who a check-in room lets in,
// and the three days a mention gives someone to post.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };

const KEYS = { DISCORD_CLIENT_ID: "ember-discord-client", DISCORD_CLIENT_SECRET: "ember-discord-secret" };
const CODE = "a-discord-code";
const ADA_DISCORD = "100000000000000001";
const GRACE_DISCORD = "100000000000000002";

/** Stands in for Discord: trades `CODE` for a token, describes `discord.user` to it, and records every request. */
function fakeDiscord() {
  const discord = { user: { id: ADA_DISCORD, username: "ada", global_name: "Ada" }, requests: [] as Array<{ url: string; body: string; authorization: string | null }> };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = new TextDecoder().decode(await request.arrayBuffer());
    discord.requests.push({ url: request.url, body, authorization: request.headers.get("Authorization") });
    const basic = `Basic ${btoa(`${KEYS.DISCORD_CLIENT_ID}:${KEYS.DISCORD_CLIENT_SECRET}`)}`;
    if (request.url === "https://discord.com/api/oauth2/token") {
      const form = new URLSearchParams(body);
      const valid = request.headers.get("Authorization") === basic && form.get("code") === CODE && form.get("code_verifier");
      return valid ? Response.json({ access_token: "a-token", token_type: "Bearer" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (request.url === "https://discord.com/api/v10/users/@me" && request.headers.get("Authorization") === "Bearer a-token") return Response.json(discord.user);
    if (request.url === "https://discord.com/api/oauth2/token/revoke") return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  });
  return discord;
}

const withKeys = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith(KEYS, path, init);
const as = (session: Session) => ({ Cookie: session.cookie });

async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

async function joinAsGrace(): Promise<Session> {
  const [account] = (await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>;
  const response = await api(`/api/join/${account!.join_code}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** A new address for each trip, so that no test runs into sign-in's limit, which checking a password counts against. */
let trips = 0;
const nextIp = () => `10.0.${Math.floor(trips / 250)}.${(trips++ % 250) + 1}`;

/** Starts connecting Discord as `session`, answering how the Worker answered. */
const startConnecting = (session: Session, body: Record<string, unknown>, ip = nextIp()) =>
  withKeys(DISCORD_CONNECTION_PATH, { method: "POST", headers: { ...as(session), "CF-Connecting-IP": ip }, body: JSON.stringify(body) });

/** Goes to Discord and back as `session`, answering the callback's redirect. */
async function connectDiscord(session: Session, password: string, roomId?: RoomId): Promise<Response> {
  const ip = nextIp();
  const started = await startConnecting(session, { currentPassword: password, roomId }, ip);
  expect(started.status, await started.clone().text()).toBe(202);
  const { url } = (await started.json()) as DiscordConnectionStart;
  const state = new URL(url).searchParams.get("state")!;
  const params = new URLSearchParams({ code: CODE, state, iss: "https://discord.com" });
  return withKeys(`${DISCORD_CALLBACK_PATH}?${params}`, { headers: { Cookie: `${session.cookie}; ${cookieOf(started)}`, "CF-Connecting-IP": ip } });
}

const locationOf = (response: Response) => new URL(response.headers.get("Location")!).pathname + new URL(response.headers.get("Location")!).search;

const memberIds = async (roomId: RoomId) =>
  ((await workspaceSql("SELECT user_id FROM memberships WHERE room_id = ? ORDER BY user_id", roomId)) as Array<{ user_id: string }>).map((row) => row.user_id);

/** A private room for `people`, made a check-in room by `owner`, who has Discord connected. */
async function checkInRoom(owner: Session, ...people: Session[]): Promise<SharedRoom> {
  const room = await createRoom("Verified", { as: owner, closedTo: [owner, ...people].map(({ user }) => user.id) });
  const response = await withKeys(checkInRulePath(room.id), { method: "PUT", headers: as(owner) });
  expect(response.status, await response.clone().text()).toBe(200);
  return room;
}

let seq = 0;
/** A new message by `author` in a room's log, as the room sends it to the Workspace, mentioning `mentioned`, written `ago` milliseconds back. */
const message = (author: Session, mentioned: Session[], ago = 0): RoomEvent => ({
  seq: ++seq,
  kind: "message",
  userId: author.user.id,
  at: new Date(Date.now() - ago).toISOString(),
  message: { id: crypto.randomUUID(), plainText: "hi", mentionIds: mentioned.map(({ user }) => user.id) },
});

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("connecting Discord", () => {
  it("links the account through PKCE, revokes the token at once, and comes back to the profile", async () => {
    const discord = fakeDiscord();
    const administrator = await setUp();
    const back = await connectDiscord(administrator, ada.password);
    expect(locationOf(back)).toBe("/users/me/profile?discord=connected");
    expect(await workspaceSql("SELECT issuer, subject, name FROM identities")).toEqual([{ issuer: "https://discord.com", subject: ADA_DISCORD, name: "Ada" }]);

    const token = discord.requests.find(({ url }) => url.endsWith("/oauth2/token"))!;
    expect(new URLSearchParams(token.body).get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(discord.requests.map(({ url }) => url)).toContain("https://discord.com/api/oauth2/token/revoke");

    const status = (await (await withKeys(DISCORD_CONNECTION_PATH, { headers: as(administrator) })).json()) as DiscordStatus;
    expect(status).toEqual({ available: true, connected: { name: "Ada" }, needsPassword: true });
  });

  it("sends the S256 challenge of the verifier it later sends with the code", async () => {
    const discord = fakeDiscord();
    const administrator = await setUp();
    const started = await startConnecting(administrator, { currentPassword: ada.password });
    const authorize = new URL(((await started.json()) as DiscordConnectionStart).url);
    expect(authorize.searchParams.get("scope")).toBe("identify");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const params = new URLSearchParams({ code: CODE, state: authorize.searchParams.get("state")! });
    await withKeys(`${DISCORD_CALLBACK_PATH}?${params}`, { headers: { Cookie: `${administrator.cookie}; ${cookieOf(started)}` } });
    const verifier = new URLSearchParams(discord.requests[0]!.body).get("code_verifier")!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(authorize.searchParams.get("code_challenge")).toBe(challenge);
  });

  it("asks for the password first", async () => {
    fakeDiscord();
    const administrator = await setUp();
    expect((await startConnecting(administrator, {})).status).toBe(422);
    expect((await startConnecting(administrator, { currentPassword: "wrong" })).status).toBe(422);
  });

  it("connects nothing from a browser that didn't start the trip, or a second time with the same state", async () => {
    fakeDiscord();
    const administrator = await setUp();
    const started = await startConnecting(administrator, { currentPassword: ada.password });
    const state = new URL(((await started.json()) as DiscordConnectionStart).url).searchParams.get("state")!;
    const callback = (cookie: string) => withKeys(`${DISCORD_CALLBACK_PATH}?${new URLSearchParams({ code: CODE, state })}`, { headers: { Cookie: cookie } });

    expect(locationOf(await callback(administrator.cookie))).toBe("/users/me/profile?discord=failed");
    expect(await workspaceSql("SELECT * FROM identities")).toEqual([]);
    expect(locationOf(await callback(`${administrator.cookie}; ${cookieOf(started)}`))).toBe("/users/me/profile?discord=connected");
    expect(locationOf(await callback(`${administrator.cookie}; ${cookieOf(started)}`))).toBe("/users/me/profile?discord=failed");
  });

  it("refuses a Discord account someone else here has connected", async () => {
    const discord = fakeDiscord();
    const administrator = await setUp();
    await connectDiscord(administrator, ada.password);
    const member = await joinAsGrace();
    expect(locationOf(await connectDiscord(member, grace.password))).toBe("/users/me/profile?discord=another");
    discord.user = { id: GRACE_DISCORD, username: "grace", global_name: "Grace" };
    expect(locationOf(await connectDiscord(member, grace.password))).toBe("/users/me/profile?discord=connected");
  });

  it("isn't offered without the Discord application's keys", async () => {
    const administrator = await setUp();
    const response = await apiWith({}, DISCORD_CONNECTION_PATH, { method: "POST", headers: as(administrator), body: JSON.stringify({ currentPassword: ada.password }) });
    expect(response.status).toBe(403);
  });
});

describe("check-in rooms", () => {
  it("takes out everyone without Discord when it's turned on, and lets them back in once they connect", async () => {
    const discord = fakeDiscord();
    const administrator = await setUp();
    await connectDiscord(administrator, ada.password);
    const member = await joinAsGrace();
    const room = await checkInRoom(administrator, member);
    expect(await memberIds(room.id)).toEqual([administrator.user.id]);

    const listed = (await (await withKeys(CHECK_IN_ROOMS_PATH, { headers: as(member) })).json()) as { checkInRooms: CheckInRoom[] };
    expect(listed.checkInRooms).toEqual([{ id: room.id, name: "Verified", icon: null, memberCount: 1 }]);
    expect((await withKeys(checkInPath(room.id), { method: "POST", headers: as(member) })).status).toBe(409);

    discord.user = { id: GRACE_DISCORD, username: "grace", global_name: "Grace" };
    const back = await connectDiscord(member, grace.password, room.id);
    expect(locationOf(back)).toBe(`/rooms/${room.id}`);
    expect((await memberIds(room.id)).sort()).toEqual([administrator.user.id, member.user.id].sort());
  });

  it("won't turn on for someone without Discord, who'd be taken out", async () => {
    fakeDiscord();
    const administrator = await setUp();
    const room = await createRoom("Verified", { as: administrator, closedTo: [administrator.user.id] });
    expect((await withKeys(checkInRulePath(room.id), { method: "PUT", headers: as(administrator) })).status).toBe(409);
  });

  it("lets nobody without Discord be added in its settings, or open a socket to it", async () => {
    fakeDiscord();
    const administrator = await setUp();
    await connectDiscord(administrator, ada.password);
    const member = await joinAsGrace();
    const room = await checkInRoom(administrator);
    const changed = await api(`/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: as(administrator),
      body: JSON.stringify({ kind: "closed", memberIds: [administrator.user.id, member.user.id] }),
    });
    expect(changed.status).toBe(200);
    expect(await memberIds(room.id)).toEqual([administrator.user.id]);
    // As though a membership had outlived its link.
    await workspaceSql("INSERT INTO memberships (room_id, user_id, created_at, updated_at) VALUES (?, ?, '', '')", room.id, member.user.id);
    expect(await workspaceSql(ROOM_ACCESS, room.id, member.user.id, "")).toEqual([{ member: 0, banned: 0 }]);
  });

  it("stops asking once the room is made open to everyone", async () => {
    fakeDiscord();
    const administrator = await setUp();
    await connectDiscord(administrator, ada.password);
    const room = await checkInRoom(administrator);
    await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ kind: "open" }) });
    expect(await workspaceSql("SELECT * FROM check_in_rooms")).toEqual([]);
  });

  it("takes you out of every check-in room when you disconnect Discord", async () => {
    fakeDiscord();
    const administrator = await setUp();
    await connectDiscord(administrator, ada.password);
    const room = await checkInRoom(administrator);
    expect((await withKeys(DISCORD_CONNECTION_PATH, { method: "DELETE", headers: as(administrator) })).status).toBe(204);
    expect(await memberIds(room.id)).toEqual([]);
    expect(await workspaceSql("SELECT * FROM identities")).toEqual([]);
  });
});

describe("the three days a mention gives", () => {
  async function twoInARoom() {
    const discord = fakeDiscord();
    const administrator = await setUp();
    await connectDiscord(administrator, ada.password);
    const member = await joinAsGrace();
    discord.user = { id: GRACE_DISCORD, username: "grace", global_name: "Grace" };
    await connectDiscord(member, grace.password);
    const room = await checkInRoom(administrator, member);
    expect((await memberIds(room.id)).length).toBe(2);
    return { administrator, member, room };
  }

  const ruleFor = async (session: Session, roomId: RoomId) => (await (await withKeys(checkInRulePath(roomId), { headers: as(session) })).json()) as CheckInRule;

  it("removes someone mentioned who hasn't posted in three full days, as soon as they're up", async () => {
    const { administrator, member, room } = await twoInARoom();
    await workspaceStub().applyRoomEvents(room.id, [message(administrator, [member], MENTION_REPLY_WINDOW_MS - 60_000)], []);
    const { removeAt } = await ruleFor(member, room.id);
    expect(removeAt).toBeGreaterThan(Date.now());
    await runDurableObjectAlarm(workspaceStub());
    expect((await memberIds(room.id)).length).toBe(2);

    await workspaceSql("UPDATE open_mentions SET mentioned_at = ?", Date.now() - MENTION_REPLY_WINDOW_MS);
    await runDurableObjectAlarm(workspaceStub());
    expect(await memberIds(room.id)).toEqual([administrator.user.id]);
    expect(await workspaceSql("SELECT * FROM open_mentions")).toEqual([]);

    // They can check in again.
    expect((await withKeys(checkInPath(room.id), { method: "POST", headers: as(member) })).status).toBe(200);
    expect((await memberIds(room.id)).length).toBe(2);
  });

  it("forgets the mention once they post in the room", async () => {
    const { administrator, member, room } = await twoInARoom();
    await workspaceStub().applyRoomEvents(room.id, [message(administrator, [member], 1000)], []);
    expect((await ruleFor(member, room.id)).removeAt).not.toBeNull();
    await workspaceStub().applyRoomEvents(room.id, [message(member, [])], []);
    expect((await ruleFor(member, room.id)).removeAt).toBeNull();
  });

  it("starts from the oldest mention they haven't answered, and ignores their own", async () => {
    const { administrator, member, room } = await twoInARoom();
    await workspaceStub().applyRoomEvents(room.id, [message(administrator, [member], 5000), message(administrator, [member], 1000), message(member, [member])], []);
    expect((await ruleFor(member, room.id)).removeAt).toBeNull();
    await workspaceStub().applyRoomEvents(room.id, [message(administrator, [member], 5000), message(administrator, [member], 1000)], []);
    const [mention] = (await workspaceSql("SELECT mentioned_at FROM open_mentions")) as Array<{ mentioned_at: number }>;
    expect(Date.now() - mention!.mentioned_at).toBeGreaterThanOrEqual(5000);
  });

  it("does nothing in rooms that don't ask people to check in", async () => {
    const { administrator, member } = await twoInARoom();
    const ordinary = await createRoom("Ordinary", { as: administrator, closedTo: [administrator.user.id, member.user.id] });
    await workspaceStub().applyRoomEvents(ordinary.id, [message(administrator, [member], MENTION_REPLY_WINDOW_MS + 1)], []);
    expect(await workspaceSql("SELECT * FROM open_mentions")).toEqual([]);
  });
});
