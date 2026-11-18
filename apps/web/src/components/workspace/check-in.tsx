import { useEffect, useState, type MouseEvent } from "react";
import type { RoomId } from "@ember/protocol";
import { MENTION_REPLY_WINDOW_MS, type CheckInRoom, type CheckInRule, type DiscordStatus } from "@ember/protocol/check-ins";
import { RoomIcon } from "@/components/icons/room-icon";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { roomPath } from "@/hooks/use-route";
import { checkIn, checkInRule, discordStatus, setCheckInRule, timeUntil } from "@/lib/check-ins";
import { ConnectDiscordForm } from "./discord-connection";

// The pages and pieces of check-in rooms (docs/specs/discord-check-in-rooms.md): the page shown for a
// check-in room you aren't in, Rooms to join in the sidebar, the switch in a room's settings, and the
// notice in a room when a mention is waiting on you.

const REPLY_DAYS = MENTION_REPLY_WINDOW_MS / (24 * 60 * 60 * 1000);

/** What every check-in room asks of the people in it, said the same way everywhere. */
const THE_RULE = `If someone mentions you here, post in the room within ${REPLY_DAYS} days, or you'll be taken out. You can check in again any time.`;

/** The page a check-in room shows someone who isn't in it: what it asks, then Connect Discord or Check in. */
export function CheckInPage({ room, onFailed }: { room: CheckInRoom; onFailed: (error: unknown) => void }) {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  useEffect(() => {
    discordStatus().then((found) => mounted.current && setStatus(found), onFailed);
  }, [mounted, onFailed]);

  // Once it's done, the workspace socket brings the room to the sidebar, and this page becomes the room.
  const checkInNow = () => {
    setBusy(true);
    checkIn(room.id)
      .catch(onFailed)
      .finally(() => mounted.current && setBusy(false));
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-10">
      <section aria-labelledby="check-in-heading" className="flex w-full max-w-md flex-col gap-4 rounded-[10px] border bg-surface px-6 py-6">
        <h1 id="check-in-heading" className="flex items-center gap-2 text-xl font-semibold">
          <RoomIcon icon={room.icon} size={22} className="text-muted-foreground" />
          <span className="wrap-anywhere">{room.name}</span>
        </h1>
        <p>This room asks you to check in with Discord before you join.</p>
        <p className="text-sm text-muted-foreground">{THE_RULE}</p>
        <p className="text-sm text-muted-foreground">
          {room.memberCount} {room.memberCount === 1 ? "person has" : "people have"} checked in.
        </p>
        {status === null ? null : status.connected ? (
          <Button type="button" disabled={busy} onClick={checkInNow} className="self-start">
            Check in as {status.connected.name}
          </Button>
        ) : status.available ? (
          <ConnectDiscordForm hasPassword={status.needsPassword} roomId={room.id} onFailed={onFailed} />
        ) : (
          <p className="text-sm">This Ember isn't set up for Discord yet, so nobody can check in. Ask an administrator.</p>
        )}
      </section>
    </main>
  );
}

/** Rooms to join: the check-in rooms you aren't in, in the sidebar. Nothing while there are none. */
export function RoomsToJoin({
  rooms,
  currentRoomId,
  rowClassName,
  onSelect,
}: {
  rooms: CheckInRoom[];
  currentRoomId: string | null;
  rowClassName: string;
  onSelect: (event: MouseEvent, roomId: RoomId) => void;
}) {
  if (rooms.length === 0) return null;
  return (
    <section aria-labelledby="rooms-to-join-heading" className="flex flex-col gap-[3px]">
      <h3 id="rooms-to-join-heading" className="mb-[5px] px-[9px] text-xs font-medium text-muted-foreground">
        Rooms to join
      </h3>
      {rooms.map((room) => (
        <a
          key={room.id}
          href={roomPath(room.id)}
          aria-current={room.id === currentRoomId ? "page" : undefined}
          onClick={(event) => onSelect(event, room.id)}
          className={rowClassName}
        >
          <RoomIcon icon={room.icon} size={19} className="w-[18px] shrink-0 text-center text-[22px] leading-none text-muted-foreground" />
          <span className="truncate text-muted-foreground">{room.name}</span>
        </a>
      ))}
    </section>
  );
}

/** A room's settings' switch: whether it asks people to check in with Discord. For private rooms, to whoever can change them. */
export function CheckInSetting({ roomId, onFailed }: { roomId: RoomId; onFailed: (error: unknown) => void }) {
  const [rule, setRule] = useState<CheckInRule | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  // A rule that doesn't come leaves the switch out, as the room's other settings don't depend on it.
  useEffect(() => {
    checkInRule(roomId).then(
      (found) => mounted.current && setRule(found),
      () => {},
    );
  }, [roomId, mounted]);
  if (!rule) return null;

  const change = (on: boolean) => {
    setBusy(true);
    setCheckInRule(roomId, on)
      .then((changed) => mounted.current && setRule(changed), onFailed)
      .finally(() => mounted.current && setBusy(false));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-3 font-medium">
        <Switch checked={rule.checkIn} disabled={busy} onCheckedChange={change} />
        Ask people to check in with Discord
      </label>
      <p className="text-sm text-muted-foreground">
        People see the room under Rooms to join and let themselves in once they've connected Discord. Turning it on takes out anyone here who hasn't. {THE_RULE}
      </p>
    </div>
  );
}

/** In a check-in room: says when you'll be taken out unless you post, while a mention of you is waiting. */
export function CheckInNotice({ roomId }: { roomId: RoomId }) {
  const [rule, setRule] = useState<CheckInRule | null>(null);
  useEffect(() => {
    let current = true;
    const look = () => checkInRule(roomId).then((found) => current && setRule(found), () => {});
    void look();
    // Mentions come and get answered while the room is open, so it looks again now and then.
    const every = setInterval(look, 60_000);
    return () => {
      current = false;
      clearInterval(every);
    };
  }, [roomId]);
  if (!rule?.checkIn || rule.removeAt === null) return null;
  return (
    <p role="status" className="mx-4 my-2 rounded-lg border bg-surface px-3 py-2 text-sm">
      Someone mentioned you. Post in this room {timeUntil(rule.removeAt)} or you'll be taken out of it.
    </p>
  );
}
