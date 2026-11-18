import { CloseCode, type RoomId, type UserId } from "@ember/protocol";
import { DISCORD_ISSUER, MENTION_REPLY_WINDOW_MS, type CheckInRoom, type CheckInRule } from "@ember/protocol/check-ins";
import { hasDiscord, leaveCheckInRoomsIfUnlinked } from "./check-in-rule";
import { statement, type Db, type Statement } from "./db";
import type { DiscordUser } from "./discord-api";
import type { RoomEvent } from "./room-log";
import { CONNECTABLE } from "./workspace-store";

// Check-in rooms' own SQL (docs/specs/discord-check-in-rooms.md; tables in migrations/0067), kept by
// the Workspace beside its store. Three parts: which rooms ask people to check in and who's let in,
// the link to someone's Discord account, and the mentions that must be answered within three days.
// The rule Ember's own queries carry is in check-in-rule.ts.

/** A trip to Discord that Connect Discord started, as the callback takes it. */
export interface PendingDiscordConnection {
  userId: UserId;
  /** The check-in room to put them in once they're back, or null. */
  roomId: RoomId | null;
  passwordDigest: string;
  sealedVerifier: string;
  createdAt: number;
}

/** How long a trip to Discord and back may take: long enough to sign in there. */
export const DISCORD_ROUND_TRIP_MS = 10 * 60 * 1000;

/** How linking a Discord account went. */
export type DiscordLink = "linked" | "another" | "claimed" | "refused";

const IS_CHECK_IN_ROOM = `SELECT 1 FROM check_in_rooms JOIN rooms ON rooms.id = check_in_rooms.room_id WHERE check_in_rooms.room_id = ? AND rooms.kind = 'closed'`;

const ROOMS_TO_JOIN = `SELECT rooms.id, rooms.name, rooms.icon, (SELECT count(*) FROM memberships AS members WHERE members.room_id = rooms.id) AS memberCount
  FROM check_in_rooms JOIN rooms ON rooms.id = check_in_rooms.room_id
  WHERE rooms.kind = 'closed' AND NOT EXISTS (SELECT 1 FROM memberships WHERE memberships.room_id = rooms.id AND memberships.user_id = ?1)
  ORDER BY rooms.name, rooms.id`;

/** Puts person ?2 in check-in room ?1 at ?3, if they can connect accounts and have Discord linked. */
const CHECK_IN = `INSERT INTO memberships (room_id, user_id, created_at, updated_at)
  SELECT rooms.id, users.id, ?3, ?3 FROM check_in_rooms JOIN rooms ON rooms.id = check_in_rooms.room_id, users
  WHERE check_in_rooms.room_id = ?1 AND rooms.kind = 'closed' AND users.id = ?2 AND ${CONNECTABLE} AND ${hasDiscord("users.id")}
  ON CONFLICT DO NOTHING RETURNING user_id`;

/** Takes everyone without Discord out of check-in room ?1, queuing their sockets there to close with ?2 at ?3. */
const QUEUE_UNLINKED_MEMBER_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT room_id, user_id, ?2, ?3 FROM memberships WHERE room_id = ?1 AND NOT ${hasDiscord("memberships.user_id")}`;
const REMOVE_UNLINKED_MEMBERS = `DELETE FROM memberships WHERE room_id = ?1 AND NOT ${hasDiscord("memberships.user_id")} RETURNING user_id`;

/** Keeps a new trip to Discord for person ?6, if they can connect accounts and their password's digest is still ?3, or '' without one. */
const START_CONNECTION = `INSERT INTO pending_discord_connections (state_digest, user_id, room_id, password_digest, sealed_verifier, created_at)
  SELECT ?1, id, ?2, ?3, ?4, ?5 FROM users WHERE id = ?6 AND ${CONNECTABLE} AND coalesce(password_digest, '') = ?3
  RETURNING user_id`;

/** Links Discord account ?2, named ?5, to person ?6 at ?3 (ms) and ?4 (ISO), if their password's digest is still ?7. */
const LINK_DISCORD = `INSERT INTO identities (issuer, subject, user_id, checked_at, created_at, updated_at, name, email_address)
  SELECT ?1, ?2, id, ?3, ?4, ?4, ?5, NULL FROM users WHERE id = ?6 AND ${CONNECTABLE} AND coalesce(password_digest, '') = ?7
  ON CONFLICT DO NOTHING RETURNING user_id`;

/** Removes, from every room, the people whose oldest open mention there came at ?1 or before, queuing their sockets there to close with ?2 at ?3. */
const QUEUE_UNANSWERED_REVOCATIONS = `INSERT INTO pending_revocations (room_id, tag, code, due_at)
  SELECT memberships.room_id, memberships.user_id, ?2, ?3 FROM open_mentions
    JOIN memberships ON memberships.room_id = open_mentions.room_id AND memberships.user_id = open_mentions.user_id
  WHERE open_mentions.mentioned_at <= ?1`;
const REMOVE_UNANSWERED = `DELETE FROM memberships WHERE (room_id, user_id) IN (SELECT room_id, user_id FROM open_mentions WHERE mentioned_at <= ?1)`;
const FORGET_UNANSWERED = `DELETE FROM open_mentions WHERE mentioned_at <= ?1 RETURNING room_id AS roomId, user_id AS userId`;

/** Opens a mention at ?3 for each member of room ?1 that the JSON list ?2 names, unless they have an older one open. */
const OPEN_MENTIONS = `INSERT INTO open_mentions (room_id, user_id, mentioned_at)
  SELECT room_id, user_id, ?3 FROM memberships WHERE room_id = ?1 AND user_id IN (SELECT value FROM json_each(?2))
  ON CONFLICT DO NOTHING`;
/** Closes person ?2's open mention in room ?1, if it came by ?3, when they post there. */
const ANSWER_MENTIONS = `DELETE FROM open_mentions WHERE room_id = ?1 AND user_id = ?2 AND mentioned_at <= ?3`;

export class CheckIns {
  constructor(private readonly db: Db) {}

  /** When the next person is due to be removed for a mention they haven't answered, or null. */
  async nextRemovalDue(): Promise<number | null> {
    const [row] = await this.db.all<{ due: number | null }>(`SELECT min(mentioned_at) + ? AS due FROM open_mentions`, MENTION_REPLY_WINDOW_MS);
    return row?.due ?? null;
  }

  // Which rooms ask people to check in, and who's let in.

  async isCheckInRoom(roomId: RoomId): Promise<boolean> {
    return (await this.db.all(IS_CHECK_IN_ROOM, roomId)).length > 0;
  }

  /** What room `roomId`'s check-in rule says to its member `userId`. */
  async ruleFor(roomId: RoomId, userId: UserId): Promise<CheckInRule> {
    const [mention] = await this.db.all<{ mentioned_at: number }>(`SELECT mentioned_at FROM open_mentions WHERE room_id = ? AND user_id = ?`, roomId, userId);
    const checkIn = await this.isCheckInRoom(roomId);
    return { checkIn, removeAt: checkIn && mention ? mention.mentioned_at + MENTION_REPLY_WINDOW_MS : null };
  }

  /**
   * Makes private room `roomId` a check-in room, taking out everyone in it without Discord, whose sockets
   * there close at `now`. Answers whom it took out.
   */
  async turnOn(roomId: RoomId, now: number): Promise<UserId[]> {
    const [, , removed] = await this.db.batch([
      statement(`INSERT INTO check_in_rooms (room_id, created_at) SELECT id, ? FROM rooms WHERE id = ? AND kind = 'closed' ON CONFLICT DO NOTHING`, now, roomId),
      statement(QUEUE_UNLINKED_MEMBER_REVOCATIONS, roomId, CloseCode.Reconnect, now),
      statement(REMOVE_UNLINKED_MEMBERS, roomId),
    ]);
    return (removed as Array<{ user_id: UserId }>).map((row) => row.user_id);
  }

  /** Makes room `roomId` an ordinary room again, forgetting its open mentions. Everyone in it stays. */
  async turnOff(roomId: RoomId): Promise<void> {
    await this.db.batch([statement(`DELETE FROM check_in_rooms WHERE room_id = ?`, roomId), statement(`DELETE FROM open_mentions WHERE room_id = ?`, roomId)]);
  }

  /** The check-in rooms `userId` isn't in, by name. */
  async roomsToJoin(userId: UserId): Promise<CheckInRoom[]> {
    return this.db.all<CheckInRoom>(ROOMS_TO_JOIN, userId);
  }

  /** Puts `userId` in check-in room `roomId`, if they have Discord linked: "joined", "in already", or "refused". */
  async checkIn(roomId: RoomId, userId: UserId, now: string): Promise<"joined" | "in already" | "refused"> {
    const [joined] = await this.db.all(CHECK_IN, roomId, userId, now);
    if (joined) return "joined";
    const [member] = await this.db.all(`SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ?`, roomId, userId);
    return member && (await this.isCheckInRoom(roomId)) ? "in already" : "refused";
  }

  // The link to someone's Discord account, an `identities` row under DISCORD_ISSUER.

  /** The name of the Discord account `userId` has linked, or null. */
  async discordNameOf(userId: UserId): Promise<string | null> {
    const [row] = await this.db.all<{ name: string | null }>(`SELECT name FROM identities WHERE user_id = ? AND issuer = ?`, userId, DISCORD_ISSUER);
    return row ? (row.name ?? "Discord") : null;
  }

  /**
   * Keeps a trip to Discord, by its state's digest, for `userId` (whose password's digest was
   * `passwordDigest`, or "" without one), forgetting trips started before `expiredBefore`. Whether it's kept.
   */
  async startConnection(stateDigest: string, userId: UserId, roomId: RoomId | null, passwordDigest: string, sealedVerifier: string, now: number, expiredBefore: number): Promise<boolean> {
    const [, kept] = await this.db.batch([
      statement(`DELETE FROM pending_discord_connections WHERE created_at < ?`, expiredBefore),
      statement(START_CONNECTION, stateDigest, roomId, passwordDigest, sealedVerifier, now, userId),
    ]);
    return kept!.length > 0;
  }

  /** Takes the trip whose state's digest is `stateDigest`, once: null unless it was started at `startedAfter` or later. */
  async takeConnection(stateDigest: string, startedAfter: number): Promise<PendingDiscordConnection | null> {
    const [row] = await this.db.all<{ user_id: UserId; room_id: RoomId | null; password_digest: string; sealed_verifier: string; created_at: number }>(
      `DELETE FROM pending_discord_connections WHERE state_digest = ? RETURNING user_id, room_id, password_digest, sealed_verifier, created_at`,
      stateDigest,
    );
    if (!row || row.created_at < startedAfter) return null;
    return { userId: row.user_id, roomId: row.room_id, passwordDigest: row.password_digest, sealedVerifier: row.sealed_verifier, createdAt: row.created_at };
  }

  /**
   * Links `discord` to `userId`, if their password's digest is still `passwordDigest`: "another" when that
   * Discord account is someone else's here, "claimed" when they've linked a different one, and "refused"
   * when they can't link one or their password changed. Linking the same account again is "linked".
   */
  async link(userId: UserId, passwordDigest: string, discord: DiscordUser, now: number): Promise<DiscordLink> {
    const [owner] = await this.db.all<{ user_id: UserId }>(`SELECT user_id FROM identities WHERE issuer = ? AND subject = ?`, DISCORD_ISSUER, discord.id);
    if (owner && owner.user_id !== userId) return "another";
    const [mine] = await this.db.all<{ subject: string }>(`SELECT subject FROM identities WHERE issuer = ? AND user_id = ?`, DISCORD_ISSUER, userId);
    if (mine) return mine.subject === discord.id ? "linked" : "claimed";
    const linked = await this.db.all(LINK_DISCORD, DISCORD_ISSUER, discord.id, now, new Date(now).toISOString(), discord.name, userId, passwordDigest);
    return linked.length > 0 ? "linked" : "refused";
  }

  /**
   * Unlinks `userId`'s Discord account, taking them out of every check-in room, with their sockets there
   * closing at `now`. Answers the rooms they left, or null when they had no Discord linked.
   */
  async disconnect(userId: UserId, now: number): Promise<RoomId[] | null> {
    const [unlinked, , , left] = await this.db.batch([
      statement(`DELETE FROM identities WHERE user_id = ? AND issuer = ? RETURNING subject`, userId, DISCORD_ISSUER),
      statement(`DELETE FROM pending_discord_connections WHERE user_id = ?`, userId),
      ...leaveCheckInRoomsIfUnlinked(userId, CloseCode.Reconnect, now),
    ]);
    if (unlinked!.length === 0) return null;
    return (left as Array<{ room_id: RoomId }>).map((row) => row.room_id);
  }

  // Mentions in check-in rooms: whoever's mentioned has three days to post in the room.

  /**
   * Goes through a check-in room's new messages, oldest first: a message answers its author's open
   * mention, and opens one for each member it mentions. Whether it opened any, which the alarm then
   * needs to come for. Events for any other room change nothing.
   */
  async noteMessages(roomId: RoomId, events: RoomEvent[]): Promise<boolean> {
    const messages = events.filter((event) => event.kind !== "read");
    if (messages.length === 0 || !(await this.isCheckInRoom(roomId))) return false;
    const statements: Statement[] = [];
    let opened = false;
    for (const { userId, at, message } of messages) {
      const writtenAt = Date.parse(at);
      statements.push(statement(ANSWER_MENTIONS, roomId, userId, writtenAt));
      const mentioned = (message?.mentionIds ?? []).filter((id) => id !== userId);
      if (mentioned.length === 0) continue;
      statements.push(statement(OPEN_MENTIONS, roomId, JSON.stringify(mentioned), writtenAt));
      opened = true;
    }
    await this.db.batch(statements);
    return opened;
  }

  /**
   * Takes everyone out of the rooms where a mention of them has waited three full days by `now`,
   * closing their sockets there at once. Answers who left which room.
   */
  async removeUnanswered(now: number): Promise<Array<{ roomId: RoomId; userId: UserId }>> {
    const mentionedBy = now - MENTION_REPLY_WINDOW_MS;
    const [, , removed] = await this.db.batch([
      statement(QUEUE_UNANSWERED_REVOCATIONS, mentionedBy, CloseCode.Reconnect, now),
      statement(REMOVE_UNANSWERED, mentionedBy),
      statement(FORGET_UNANSWERED, mentionedBy),
    ]);
    return removed as Array<{ roomId: RoomId; userId: UserId }>;
  }
}
