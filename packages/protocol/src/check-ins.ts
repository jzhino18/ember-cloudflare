import type { RoomIconName, RoomId } from "./index";

// Check-in rooms (docs/specs/discord-check-in-rooms.md): private rooms that people let themselves into
// once they've connected a Discord account, and where anyone mentioned has three days to post in the
// room before they're taken out of it. What the Worker and the web app share about them is here.

/** The issuer a Discord account is linked under, in the Workspace's table of linked accounts. */
export const DISCORD_ISSUER = "https://discord.com";

/** How long someone mentioned in a check-in room has to post there before they're removed: three full days. */
export const MENTION_REPLY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** GET your Discord status, POST to start connecting, DELETE to disconnect. */
export const DISCORD_CONNECTION_PATH = "/api/users/me/discord_connection";
/** Where Discord sends the browser back. Register `<Ember's address>/auth/discord/callback` as a redirect in Discord. */
export const DISCORD_CALLBACK_PATH = "/auth/discord/callback";
/** GET the check-in rooms you aren't in. */
export const CHECK_IN_ROOMS_PATH = "/api/check_in_rooms";
/** POST to check in to a room, once you've connected Discord. */
export const checkInPath = (roomId: RoomId) => `/api/rooms/${encodeURIComponent(roomId)}/check_in`;
/** GET whether a room asks people to check in; PUT turns it on, DELETE turns it off. */
export const checkInRulePath = (roomId: RoomId) => `/api/rooms/${encodeURIComponent(roomId)}/check_in_rule`;

/** Where you stand with Discord. */
export interface DiscordStatus {
  /** Whether this Ember has a Discord application's keys. Without them, nobody can connect. */
  available: boolean;
  /** The Discord account you've connected, by its name there, or null. */
  connected: { name: string } | null;
  /** Whether connecting asks for your Ember password, as it does once you have one. */
  needsPassword: boolean;
}

/** What starting to connect Discord answers: the page at Discord to send the browser to. */
export interface DiscordConnectionStart {
  url: string;
}

/** A check-in room you aren't in, as Rooms to join lists it. */
export interface CheckInRoom {
  id: RoomId;
  name: string;
  icon: RoomIconName | null;
  memberCount: number;
}

/** What a room's check-in rule says to one of its members. */
export interface CheckInRule {
  checkIn: boolean;
  /** When you'll be removed unless you post in the room, as milliseconds since the epoch, or null. */
  removeAt: number | null;
}

/** The query parameter that tells a page how connecting Discord went. */
export const DISCORD_PROBLEM_PARAM = "discord";

/** How connecting Discord can end, and what to tell the person. */
export const DISCORD_OUTCOMES = {
  connected: "Discord is connected.",
  denied: "Discord wasn't allowed, so nothing changed.",
  failed: "Connecting Discord didn't work. Try again.",
  another: "That Discord account is already connected to someone else here.",
  claimed: "You've already connected a different Discord account.",
  limited: "Too many tries. Wait a few minutes and try again.",
  busy: "Discord is busy. Try again in a moment.",
  unavailable: "This Ember isn't set up for Discord yet.",
} as const;

export type DiscordOutcome = keyof typeof DISCORD_OUTCOMES;

export const isDiscordOutcome = (value: unknown): value is DiscordOutcome => typeof value === "string" && Object.hasOwn(DISCORD_OUTCOMES, value);
