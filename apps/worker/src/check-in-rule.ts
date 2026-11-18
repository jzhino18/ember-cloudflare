import { DISCORD_ISSUER } from "@ember/protocol/check-ins";
import type { CloseCode, UserId } from "@ember/protocol";
import { statement, type Statement } from "./db";

// The one rule of check-in rooms that Ember's own queries carry (docs/specs/discord-check-in-rooms.md):
// nobody is in a check-in room without a Discord account linked. It sits in the statement that puts
// people in private rooms (GRANT_ROOM_TO_USERS) and in the check every room socket's upgrade makes
// (ROOM_ACCESS), so no way in skips it. The rest of the feature's SQL is in check-ins.ts.

/** SQL that's true when person `user` has a Discord account linked. `user` is an SQL expression, such as `?2` or `users.id`. */
export const hasDiscord = (user: string) => `EXISTS (SELECT 1 FROM identities WHERE identities.user_id = ${user} AND identities.issuer = '${DISCORD_ISSUER}')`;

/** SQL that's true when person `user` may be in room `room`: it isn't a check-in room, or they have Discord linked. */
export const checkInAllows = (room: string, user: string) => `(NOT EXISTS (SELECT 1 FROM check_in_rooms WHERE check_in_rooms.room_id = ${room}) OR ${hasDiscord(user)})`;

/**
 * For the batch that unlinks someone's accounts: if that left them without Discord, takes them out of
 * every check-in room, closing their sockets there with `code` at `dueAt`, and forgets their open
 * mentions. Goes after the statement that unlinks. The first statement answers a row for each
 * revocation it queued.
 */
export const leaveCheckInRoomsIfUnlinked = (userId: UserId, code: CloseCode, dueAt: number): Statement[] => [
  statement(
    `INSERT INTO pending_revocations (room_id, tag, code, due_at)
      SELECT memberships.room_id, memberships.user_id, ?2, ?3 FROM memberships JOIN check_in_rooms ON check_in_rooms.room_id = memberships.room_id
      WHERE memberships.user_id = ?1 AND NOT ${hasDiscord("?1")} RETURNING id`,
    userId,
    code,
    dueAt,
  ),
  statement(`DELETE FROM memberships WHERE user_id = ?1 AND room_id IN (SELECT room_id FROM check_in_rooms) AND NOT ${hasDiscord("?1")} RETURNING room_id`, userId),
  statement(`DELETE FROM open_mentions WHERE user_id = ?1 AND NOT ${hasDiscord("?1")}`, userId),
];
