import { useEffect, useState } from "react";
import type { RoomId } from "@ember/protocol";
import {
  CHECK_IN_ROOMS_PATH,
  checkInPath,
  checkInRulePath,
  DISCORD_CONNECTION_PATH,
  DISCORD_OUTCOMES,
  DISCORD_PROBLEM_PARAM,
  isDiscordOutcome,
  type CheckInRoom,
  type CheckInRule,
  type DiscordConnectionStart,
  type DiscordStatus,
} from "@ember/protocol/check-ins";
import { ApiError } from "./api";
import type { FlashMessage } from "./flash";

// The web app's side of check-in rooms (docs/specs/discord-check-in-rooms.md): the requests to the
// Worker's routes in apps/worker/src/discord.ts, the hook that keeps Rooms to join current, and the
// message the address carries back from Discord.

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  return data;
}

export const discordStatus = () => send<DiscordStatus>(DISCORD_CONNECTION_PATH);

/** Starts connecting Discord: the page at Discord to send the browser to. With `roomId`, coming back checks you in there too. */
export const startDiscordConnection = (currentPassword: string | undefined, roomId?: RoomId) =>
  send<DiscordConnectionStart>(DISCORD_CONNECTION_PATH, { method: "POST", body: JSON.stringify({ currentPassword, roomId }) });

export const disconnectDiscord = () => fetch(DISCORD_CONNECTION_PATH, { method: "DELETE" }).then((response) => {
  if (!response.ok && response.status !== 404) throw new ApiError(response.status, "Disconnecting Discord didn't work. Try again.");
});

export const checkInRooms = () =>
  send<{ checkInRooms?: unknown }>(CHECK_IN_ROOMS_PATH).then((answer) => (Array.isArray(answer.checkInRooms) ? (answer.checkInRooms as CheckInRoom[]) : []));

export const checkIn = (roomId: RoomId) => send<{ roomId: RoomId }>(checkInPath(roomId), { method: "POST" });

export const checkInRule = (roomId: RoomId) => send<CheckInRule>(checkInRulePath(roomId));

export const setCheckInRule = (roomId: RoomId, on: boolean) => send<CheckInRule>(checkInRulePath(roomId), { method: on ? "PUT" : "DELETE" });

/**
 * The check-in rooms you aren't in, asked again whenever the rooms you're in change, as joining one or
 * being taken out of one does. Null until the first answer; empty if it fails, so a room page never
 * waits on it. `roomIds` is the ids of your rooms, or null before they've loaded.
 */
export function useCheckInRooms(roomIds: RoomId[] | null): CheckInRoom[] | null {
  const [listed, setListed] = useState<CheckInRoom[] | null>(null);
  const key = roomIds?.join(" ") ?? null;
  useEffect(() => {
    if (key === null) return;
    let current = true;
    checkInRooms().then(
      (found) => current && setListed(found),
      () => current && setListed((kept) => kept ?? []),
    );
    return () => {
      current = false;
    };
  }, [key]);
  return listed;
}

/** What this page's address says connecting Discord came to, as a flash, taking it out of the address so a reload doesn't say it again. */
export function takeDiscordFlash(): FlashMessage | null {
  const params = new URLSearchParams(location.search);
  const outcome = params.get(DISCORD_PROBLEM_PARAM);
  if (outcome === null) return null;
  params.delete(DISCORD_PROBLEM_PARAM);
  const search = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
  if (!isDiscordOutcome(outcome)) return null;
  return { kind: outcome === "connected" ? "notice" : "alert", text: DISCORD_OUTCOMES[outcome] };
}

/** "in 2 days", "in 5 hours", "in 12 minutes": how long until `time`, roughly. */
export function timeUntil(time: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((time - now) / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}
