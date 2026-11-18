-- Check-in rooms (scope "workspace" in src/migrations.ts; docs/specs/discord-check-in-rooms.md): private
-- rooms people let themselves into once they've connected a Discord account, where a mention has to be
-- answered within three days. src/check-ins.ts holds all the SQL that reads these tables.

-- A private room that asks people to check in with Discord. The room itself stays kind 'closed'.
CREATE TABLE IF NOT EXISTS check_in_rooms (
  room_id TEXT PRIMARY KEY,
  -- When check-in was turned on, in milliseconds since the epoch.
  created_at INTEGER NOT NULL
);

-- One trip to Discord and back, from Connect Discord until the callback takes it (at most ten minutes).
-- Kept apart from pending_identities, so Memberful's callback never takes one of these.
CREATE TABLE IF NOT EXISTS pending_discord_connections (
  -- The state's HMAC under SESSION_SECRET, as pending_identities keeps it.
  state_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- The check-in room to put them in once they're back, or null when they connected from their profile.
  room_id TEXT,
  -- The digest of the password that checked out, or '' without one: the link lands only if it's unchanged.
  password_digest TEXT NOT NULL,
  -- The PKCE code verifier, sealed under SESSION_SECRET as "discord-verifier".
  sealed_verifier TEXT NOT NULL,
  -- When it was started, in milliseconds since the epoch.
  created_at INTEGER NOT NULL
);

-- A mention in a check-in room that its person hasn't answered by posting there yet. Only the oldest
-- unanswered one counts, so there's one row a person a room. Three days after `mentioned_at`, they're
-- removed from the room.
CREATE TABLE IF NOT EXISTS open_mentions (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- When the mention was written, in milliseconds since the epoch.
  mentioned_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS index_open_mentions_on_mentioned_at ON open_mentions (mentioned_at);
