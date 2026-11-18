import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_PASSWORD_LENGTH, type RoomId } from "@ember/protocol";
import type { DiscordStatus } from "@ember/protocol/check-ins";
import { AUTH_FORM } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { discordStatus, disconnectDiscord, startDiscordConnection } from "@/lib/check-ins";
import { openPage } from "@/lib/page";

// Connecting Discord, for check-in rooms (docs/specs/discord-check-in-rooms.md). The form asks for your
// Ember password first, as Connect Memberful does, then sends the browser to Discord, which sends it
// back to the Worker's callback. The profile shows it as a card; a check-in page shows the form alone.

/**
 * Connect Discord: your password, when you have one, then off to Discord. With `roomId`, coming back
 * checks you in to that room too.
 */
export function ConnectDiscordForm({ hasPassword, roomId, onFailed }: { hasPassword: boolean; roomId?: RoomId; onFailed: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    startDiscordConnection(hasPassword ? (password.current?.value ?? "") : undefined, roomId).then(
      ({ url }) => openPage(url),
      (error: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        if (password.current) password.current.value = "";
        onFailed(error);
      },
    );
  };
  return (
    <form onSubmit={connect} className={AUTH_FORM}>
      {hasPassword && (
        <Field id="discord_password" label="Password" translation="password">
          <Input
            ref={password}
            id="discord_password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="Enter your Ember password"
            maxLength={MAX_PASSWORD_LENGTH}
            className={FIELD_INPUT}
          />
        </Field>
      )}
      <SubmitButton disabled={busy}>Connect Discord</SubmitButton>
    </form>
  );
}

/** Your profile's Discord card: the account you've connected with Disconnect, or Connect Discord. Hidden while this Ember can't connect Discord. */
export function DiscordConnection({ onFailed }: { onFailed: (error: unknown) => void }) {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  // A status that doesn't come leaves the card out, rather than alerting on a page that's about something else.
  useEffect(() => {
    discordStatus().then(
      (found) => mounted.current && setStatus(found),
      () => {},
    );
  }, [mounted]);
  if (!status || (!status.available && !status.connected)) return null;

  const disconnect = () => {
    setBusy(true);
    disconnectDiscord().then(
      () => mounted.current && setStatus({ ...status, connected: null }),
      onFailed,
    ).finally(() => mounted.current && setBusy(false));
  };

  return (
    <section aria-labelledby="discord-connection-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <h2 id="discord-connection-heading" className="text-base font-semibold">
        Discord
      </h2>
      {status.connected ? (
        <>
          <p>Connected to Discord as {status.connected.name}, so you can check in to rooms that ask for it.</p>
          <p className="text-sm text-muted-foreground">Disconnecting takes you out of every room you checked in to.</p>
          <Button type="button" variant="outline" disabled={busy} onClick={disconnect} className="self-start">
            Disconnect Discord
          </Button>
        </>
      ) : (
        <>
          <p>Some rooms ask you to check in with Discord before you join. Connect your Discord account once, and checking in takes one click.</p>
          <ConnectDiscordForm hasPassword={status.needsPassword} onFailed={onFailed} />
        </>
      )}
    </section>
  );
}
