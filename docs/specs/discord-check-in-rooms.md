# Check-in rooms: join by connecting Discord

Status: built on `spec/discord-check-in-rooms`, uncommitted. Line numbers are from `main` at `dc19628a` and
will drift. The code: `apps/worker/src/{discord,discord-api,check-ins,check-in-rule}.ts`,
`apps/worker/migrations/0067_check_in_rooms.sql`, `packages/protocol/src/check-ins.ts`,
`apps/web/src/lib/check-ins.ts` and `apps/web/src/components/workspace/{check-in,discord-connection}.tsx`.
Everything else is a one-line hook into Ember's own code, each with a comment that points back here.

## What it is

A check-in room is a private room that people let themselves into, but only after they check in by
connecting a Discord account through Discord's own sign-in. Any Discord account will do: the room asks
for no particular server, role or account age. Until then they can see that the room exists, and
nothing else: no messages, no members, no files. Checking in is only that Discord check; there are no
rules to accept.

**Anyone mentioned has three days to answer.** When a message in a check-in room @mentions someone in
it, they have three full days (72 hours) to post anything in that room, in the room or a thread. If
they don't, they're taken out of it the moment the time is up, and their open tabs of it close. Only
the oldest unanswered mention counts, and posting answers every mention before it. Being taken out is
not a ban: the room goes back under Rooms to join, and checking in again takes one click.

The point is that being in the room means something. Each person in it has a real Discord account tied
to their Ember account, proved through Discord's own sign-in, and one Discord account can stand behind
only one Ember account.

## How it works for people

**Whoever deploys Ember sets Discord up once.** Make an application in the Discord Developer Portal,
add `https://<ember>/auth/discord/callback` under OAuth2, Redirects, and give Ember its keys as the
`DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` secrets (in `.dev.vars` locally, where the redirect is
`http://localhost:5173/auth/discord/callback`). A Set up Discord dialog in workspace settings, keeping
the keys sealed as Memberful's are, is left for later.

**An administrator makes a check-in room.** A private room's settings get a switch, **Ask people to
check in with Discord**, for whoever can change the room. Turning it on takes out everyone in the room
without Discord connected, so it needs the person turning it on to have connected first. Making the room
open to everyone turns it off.

**Anyone signed in finds it and checks in.** The sidebar gets a **Rooms to join** section listing the
check-in rooms someone isn't in, with each room's name, icon and how many people are in it. Opening one
shows a check-in page instead of the room:

1. **Not connected yet: Connect Discord.** Ember asks for their password, then sends them to Discord,
   which asks them to let Ember see who they are (their username and avatar; not their email or
   servers). Back in Ember, their Discord is connected and they're in the room.
2. **Already connected: Check in.** One click puts them in the room, with no trip to Discord, because
   there's nothing new to confirm.

If it doesn't work, the page says why: they cancelled at Discord, or that Discord account is already
connected to someone else.

**Disconnecting Discord takes them out of every check-in room**, and closes their open connections
to those rooms at once. So does resetting their password or setting a new one, which already
disconnects every outside account.

Guests and bots can't check in, as they can't connect Memberful (`CONNECTABLE`,
`workspace-store.ts:887`). Agents and @ember are never added to check-in rooms automatically, since
those rooms are private.

## Security

| Threat | What stops it |
|---|---|
| Someone forges the return from Discord (CSRF, login fixation) | A one-time `state`: a random token kept only as its digest in a pending row, also in a `__Host-` cookie, compared in constant time, taken with `DELETE ... RETURNING`, gone after 10 minutes |
| Someone steals the code on its way back | PKCE: Discord advertises `code_challenge_methods_supported: ["S256"]`; the verifier is sealed in the pending row and sent with the code |
| A response from another provider is mixed up with Discord's | The callback's `iss` must be `https://discord.com` |
| Someone joins without checking in, by any of Ember's ways in | The rule lives in the SQL that adds members (below), so every path that adds someone is covered, in the same statement as the insert |
| Someone checks in, joins, then disconnects | Disconnecting removes their memberships in check-in rooms and queues revocations in the same batch |
| One Discord account vouches for many Ember accounts | `identities` already allows one account per `(issuer, subject)` and one issuer per user |
| Someone takes over a signed-in browser and connects their own Discord | Connecting asks for the account's password first, as Connect Memberful does (`index.ts:708-729`), and the link only lands if the password hasn't changed since |
| The client secret leaks | It's a deployment secret, `DISCORD_CLIENT_SECRET`, never stored or sent to the browser |
| Someone mentioned can't be removed in time because the Workspace was asleep | The Workspace's alarm is set for the next deadline whenever a mention opens, and again after every run |
| Discord tokens leak | Ember keeps none: the callback uses the access token once, then revokes it (`/oauth2/token/revoke`) |
| Someone hammers the callback | It counts against `signInAttempts` (10 per 3 minutes per address), and banned addresses get 429, as Memberful's callback does |
| Discord rate limits Ember | Ember calls Discord only while someone connects: three requests (token, `@me`, revoke). A 429 becomes "Discord is busy, try again in a moment", using `retry_after`. No retries in the request, which keeps Ember far from Discord's 10,000 invalid requests per 10 minutes |

## Discord, as used here

From Discord's docs (docs.discord.com/developers/topics/oauth2, resources/user) and its metadata at
`https://discord.com/.well-known/oauth-authorization-server`:

- **Authorize:** `https://discord.com/oauth2/authorize` with `response_type=code`, `client_id`,
  `redirect_uri` (exactly as registered), `scope`, `state`, `code_challenge`,
  `code_challenge_method=S256`, and `prompt=none` so someone reconnecting after a disconnect isn't
  asked again. If they cancel, Discord comes back with `error=access_denied`.
- **Scope:** `identify` only. Skip `email` and `guilds`: Ember doesn't need them, and asking for less
  makes people more willing to allow it.
- **Token:** `POST https://discord.com/api/oauth2/token`, form-encoded (JSON is refused),
  `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, with the client ID and
  secret as HTTP Basic.
- **Who:** `GET https://discord.com/api/v10/users/@me` gives `id`, `username`, `global_name`,
  `avatar`, `mfa_enabled`.
- **Revoke:** `POST https://discord.com/api/oauth2/token/revoke` with `token`. This revokes every
  token of that authorization.

Ember needs no bot, no bot token and no webhooks: everything goes through the person's own consent.

## Data

One workspace migration, `0067_check_in_rooms.sql`. Main skips 0064 and 0065, which are on upstream
branches, so 0067 is the next free number. It only adds tables, as `docs/development.md#releasing`
asks.

```sql
-- A room someone lets themselves into once they've connected Discord. The room stays kind 'closed'.
CREATE TABLE check_in_rooms (
  room_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- One Discord round trip in flight. Kept apart from pending_identities so Memberful's code never
-- takes a Discord row.
CREATE TABLE pending_discord_connections (
  state_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  room_id TEXT,                  -- the room to check into on the way back, or null from the profile
  password_digest TEXT,          -- what connecting was confirmed with, as pending_identities keeps
  sealed_verifier TEXT NOT NULL, -- the PKCE verifier, sealed as "discord-verifier"
  created_at INTEGER NOT NULL
);

-- A mention in a check-in room its person hasn't answered by posting there yet: the oldest only.
CREATE TABLE open_mentions (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mentioned_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
```

(The migration has the three tables, with comments; this shows their shape.)

There's no table of check-ins. The membership is the check-in, and what it rests on is the Discord
link: an `identities` row with `issuer = 'https://discord.com'` and `subject` = the Discord user ID,
with `name` set to `global_name` or `username`. That table already has the uniqueness this needs.

The keys are the deployment's `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` (`discordKeysOf`).

## Enforcement

Every way into a room ends in an `INSERT INTO memberships` in `workspace-store.ts`. No WebSocket frame
adds members, and the ChatRoom object trusts the Worker's headers rather than checking membership.
So the rule goes in that SQL, as one shared fragment:

```sql
-- true unless the room asks for a check-in and this person has no Discord connected
NOT EXISTS (SELECT 1 FROM check_in_rooms WHERE room_id = :room)
OR EXISTS (SELECT 1 FROM identities WHERE user_id = :user AND issuer = 'https://discord.com')
```

1. **In the two places a closed room is reached:** `GRANT_ROOM_TO_USERS`, the only grant that puts
   people in a private room (creating one, and its settings' member list), and `ROOM_ACCESS`, which
   every room socket's upgrade asks. The other grants only touch open rooms, and a check-in room can't
   be open (3). `check-in-rule.ts` holds the fragment, `checkInAllows`.
2. **Admins can only add people who have connected Discord.** The fragment in `GRANT_ROOM_TO_USERS`
   leaves the rest out.
3. **An open room can't ask anyone to check in.** Making a check-in room open to everyone turns its
   check-in off first (`Workspace.changeRoom`), and the switch is refused on an open room.
4. **Removing the link removes the access.** Disconnecting, and the batches of `UNLINK_ON_RESET` and
   `UNLINK_ON_NEW_PASSWORD`, take the person out of every check-in room and queue their sockets there
   to close (`leaveCheckInRoomsIfUnlinked`).
5. **Memberful ignores Discord rows.** `linkedSite()` skips the Discord issuer; `memberfulStatusOf`
   already finds accounts by the Memberful site.
6. Any later migration that backfills memberships, as 0053 did, includes the fragment.

## Worker

Routes, with their paths as constants in `packages/protocol` beside Memberful's (`index.ts:1278-1297`):

| Route | Does |
|---|---|
| `GET /api/users/me/discord_connection` | Whether Discord can be connected, the account you've connected, and whether connecting asks for your password |
| `POST /api/users/me/discord_connection` | Body `{ currentPassword, roomId? }`. Checks the password, makes the state and PKCE verifier, stores the pending row, sets the `discord_state` cookie, answers 202 `{ url: <authorize URL> }` |
| `DELETE /api/users/me/discord_connection` | Disconnects, with the removals above. No password: it only takes access away |
| `GET /auth/discord/callback` | The round trip's end (below) |
| `GET /api/check_in_rooms` | Check-in rooms the person isn't in: id, name, icon, how many people are in it |
| `POST /api/rooms/:id/check_in` | Already connected: puts the person in (`CHECK_IN`) and sends `room.saved` to their tabs. 409 if they have no Discord link |
| `GET /api/rooms/:id/check_in_rule` | For a member: whether the room asks people to check in, and when they'll be removed unless they post |
| `PUT` / `DELETE /api/rooms/:id/check_in_rule` | Turns check-in on or off, for whoever can change the room |

The callback, in `discord.ts`, follows `signedInWithMemberful` (`memberful.ts:198-227`):

1. Refuse a banned address with 429; expire the state cookie on every answer.
2. Compare `?state=` with the cookie (`isToken`), count the try against `signInAttempts`, then take
   the pending row (`DELETE ... RETURNING`, younger than 10 minutes). Only whoever started it, still
   signed in on this browser, goes on, and `iss`, when Discord sends it, must be Discord.
3. If Discord sent `error=access_denied`, stop there as "denied".
4. Exchange the code with the unsealed verifier, read `/users/@me`, then revoke the token.
5. Link the identity, one change at a time ("another" if that Discord account belongs to someone else,
   "claimed" if this person already linked a different one), and if the pending row names a room,
   check them in and send `room.saved` to their tabs.
6. Redirect to the room, or to the page it came from with `?discord=<outcome>`. The outcomes are
   `DISCORD_OUTCOMES` in protocol.

Fetches use `redirect: "manual"` and a 10-second timeout, and log statuses only, never tokens, as
`memberful-api.ts` does.

## The three-day rule

The Workspace already hears of every new message in every room: the room's log sends it each message's
author and the people it mentions (`applyRoomEvents`, `room-log.ts`). In a check-in room,
`CheckIns.noteMessages` closes the author's open mention, if it came before their message, and opens one
for each member the message mentions, unless they have an older one open. The Workspace's alarm, which
already runs the outbox, is set for the next mention's deadline too (`scheduleDelivery`), and each time
it rings, `removeUnanswered` takes out everyone whose mention is 72 hours old, queuing their sockets
there to close, and tells their tabs the room is gone. A member's room shows a notice with the time left.

## Protocol and web app

- **protocol:** `packages/protocol/src/check-ins.ts`, exported as `@ember/protocol/check-ins`: the paths,
  the types, the outcomes the callback sends back, and the three days. Room types are unchanged; the
  check-in switch has its own route.
- **web:**
  - the check-in switch in a private room's settings;
  - a **Rooms to join** section in `sidebar.tsx`, fed by `/api/check_in_rooms`;
  - a check-in page shown for a check-in room the person isn't in, in place of the "Room not found"
    redirect, with Connect Discord or Check in;
  - a Discord section on the profile page, beside Memberful's;
  - the `?discord=` message read and cleared as `lib/memberful.ts` does;
  - a notice in a check-in room while a mention of you is waiting, with the time left.
  - No Discord mark: icons are the owner's to pick (`components/icons/README`).

## Tests

`apps/worker/test/check-ins.test.ts` runs in workerd on both backends, with a `fakeDiscord()` built
like `fakeMemberful()` that answers the token, `@me` and revoke URLs. It covers: the round trip with
PKCE (the challenge is the S256 of the verifier sent with the code) and the token revoked; the password
asked first; a callback from a browser that didn't start the trip, and a state used twice; a Discord
account someone else has; no keys; turning check-in on taking out people without Discord and letting
them back once they connect; refusing to turn it on for someone without Discord; settings that can't
add people without Discord, and `ROOM_ACCESS` refusing a membership that outlived its link; making the
room open; disconnecting; and the three days: removed when up, not before, answered by posting, the
oldest mention counting, their own mention not counting, ordinary rooms untouched, and checking in
again afterwards.

Still to write: e2e through a fake Discord, and the password reset and new password paths.

## Decided

0. **Anyone mentioned in a check-in room has three full days to post there, or is taken out.** "Open"
   means a message that @mentions them; any post of theirs in the room answers it. Being taken out
   isn't a ban: they can check in again with one click. It's on for every check-in room.

1. **Checking in is the Discord check and nothing else.** There's no rules page to accept, no
   welcome form, and no step that an administrator writes.
2. **Any Discord account will do.** A room asks for no server, no role and no account age, so the
   only scope is `identify` and Ember never reads anyone's servers. It follows that:
   - Connecting happens once. Checking into each further room is one click, with no trip to
     Discord, since a fresh trip would confirm nothing new.
   - Nobody is re-checked later. There's no role to lose, so Ember keeps no Discord tokens and runs
     no daily check.
   - There's no table of check-ins. Having a Discord link is the whole rule.

## Not built yet

- A Set up Discord dialog in workspace settings, with the keys sealed in the account, as Memberful's.
- Room settings saying "hasn't connected Discord" beside people it can't add; today they're left out
  silently.
- e2e tests and `docs/self-hosting.md`.

## Open questions

1. **Who can make check-in rooms?** As written, whoever may create rooms. It could be administrators
   only.
2. **Should people without a password** (Memberful-only accounts) connect Discord by signing in
   with Memberful again, rather than with a password?
