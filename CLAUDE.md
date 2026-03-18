# Slowfeed — Project Plan for Claude Code

## Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Create .env file (if not exists)
cp .env.example .env

# Start the database (required before running the app)
docker compose up db -d

# Run in development mode (with auto-reload)
npm run dev

# Or run the built version
npm start

# Or run everything with Docker Compose (full stack)
docker compose up --build

# Stop the database when done
docker compose down
```

**Local URLs:**
- Web UI: http://localhost:3000
- RSS Feed: http://localhost:3000/feed.rss
- Atom Feed: http://localhost:3000/feed.atom

**Default login password:** `changeme` (change this in Settings)

---

## Overview

Build a self-hosted RSS feed aggregator called **Slowfeed** that runs on a Mac Mini inside Docker. It polls Reddit, Bluesky, and YouTube on a configurable schedule, deduplicates posts, and serves a valid RSS/Atom feed to any RSS reader. A web UI allows configuration and manual control. The service is accessible remotely via Cloudflare Tunnel.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Docker Compose (Mac Mini)                          │
│                                                     │
│  ┌──────────────┐   ┌──────────────┐               │
│  │  slowfeed  │   │  PostgreSQL  │               │
│  │  (Node.js)   │──▶│  (state DB)  │               │
│  └──────┬───────┘   └──────────────┘               │
│         │                                           │
│  ┌──────▼───────────────────────────────┐          │
│  │  Exposed ports (internal only)       │          │
│  │  :3000  Web UI + RSS feed endpoint   │          │
│  └──────────────────────────────────────┘          │
└─────────────────────────────────────────────────────┘
         │
         ▼
   Cloudflare Tunnel  ──▶  Public HTTPS URL (your RSS reader)
```

**Stack:**
- **Runtime:** Node.js 20 (TypeScript)
- **Database:** PostgreSQL (via Docker) for seen-post deduplication and config storage
- **Scheduler:** node-cron for polling intervals
- **RSS output:** feed (npm) library
- **Web UI:** Simple HTML/JS frontend served by the same Express app
- **Auth for Web UI:** Optional basic auth (username/password, configurable)

---

## Project Structure

```
slowfeed/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── README.md
├── src/
│   ├── index.ts              # Entry point, Express server
│   ├── scheduler.ts          # Schedule-based cron jobs
│   ├── schedules.ts          # Schedule CRUD operations
│   ├── digest.ts             # Digest creation and formatting
│   ├── feed.ts               # RSS/Atom feed generator (from digests)
│   ├── db.ts                 # PostgreSQL connection + migrations
│   ├── dedup.ts              # Deduplication logic (hash-based)
│   ├── config.ts             # Config read/write from DB
│   ├── logger.ts             # Logging utility
│   ├── types/
│   │   └── index.ts          # TypeScript type definitions
│   ├── sources/
│   │   ├── reddit.ts         # Reddit polling (returns DigestPost[])
│   │   ├── bluesky.ts        # Bluesky polling (returns DigestPost[])
│   │   ├── youtube.ts        # YouTube polling (returns DigestPost[])
│   │   └── discord.ts        # Discord polling (returns DigestPost[])
│   ├── notifications/
│   │   ├── reddit-mail.ts    # Reddit inbox (returns DigestPost[])
│   │   └── bluesky-replies.ts # Bluesky notifications (returns DigestPost[])
│   └── ui/
│       ├── routes.ts         # Express routes for Web UI + API
│       └── public/           # Static frontend files
│           ├── index.html
│           ├── app.js
│           └── style.css
├── migrations/
│   ├── 001_initial.sql
│   └── 002_schedules_and_digests.sql
└── scripts/
    └── setup-cloudflare-tunnel.sh
```

---

## Database Schema

```sql
-- Stores all config key/value pairs (JSON values)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deduplication: tracks every post ever added to the feed
CREATE TABLE seen_posts (
  id TEXT PRIMARY KEY,          -- sha256 of (source + post_id)
  source TEXT NOT NULL,         -- 'reddit', 'bluesky', 'youtube'
  post_id TEXT NOT NULL,        -- platform-native ID
  title TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

-- The feed items themselves (kept for TTL-based expiry)
CREATE TABLE feed_items (
  id TEXT PRIMARY KEY,          -- same as seen_posts.id
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT NOT NULL,
  author TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  is_notification BOOLEAN DEFAULT FALSE,  -- true for DMs/replies
  raw_json JSONB,               -- original API response for debugging
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- OAuth tokens (encrypted at rest)
CREATE TABLE oauth_tokens (
  service TEXT PRIMARY KEY,    -- 'google', 'reddit', 'bluesky'
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  scope TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Poll schedules (replaces poll_interval_hours)
CREATE TABLE poll_schedules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  days_of_week INTEGER[] NOT NULL,  -- 0-6 for Sun-Sat
  time_of_day TIME NOT NULL,         -- HH:MM:SS
  timezone TEXT NOT NULL,            -- e.g., 'America/Los_Angeles'
  sources TEXT[] NOT NULL,           -- ['reddit', 'bluesky', 'youtube', 'discord']
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Consolidated digest items (replaces individual feed_items)
CREATE TABLE digest_items (
  id TEXT PRIMARY KEY,              -- e.g., 'reddit_1710172800000'
  source TEXT NOT NULL,
  schedule_id INTEGER REFERENCES poll_schedules(id),
  title TEXT NOT NULL,              -- e.g., "Reddit Digest: 5 new posts"
  content TEXT NOT NULL,            -- HTML with all posts consolidated
  post_count INTEGER NOT NULL,
  post_ids TEXT[] NOT NULL,         -- Array of individual post IDs
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Configuration (stored in `config` table, editable via Web UI)

```jsonc
{
  // --- Scheduling ---
  // Schedules are now managed via the "Schedules" page in the Web UI
  // Each schedule specifies: time, timezone, days of week, and which sources to poll
  // Example: "Morning Digest" at 7:00 AM PT on weekdays for Reddit + Bluesky

  // --- Bluesky ---
  "bluesky_enabled": true,
  "bluesky_handle": "you.bsky.social",
  "bluesky_app_password": "xxxx-xxxx-xxxx-xxxx",  // App password, not main password
  "bluesky_top_n": 20,               // Y: number of top posts per window

  // --- YouTube ---
  "youtube_enabled": true,
  // YouTube credentials stored in oauth_tokens table (via OAuth flow)

  // --- Reddit ---
  "reddit_enabled": true,
  "reddit_top_n": 30,                // Z: number of posts from homepage
  "reddit_include_comments": true,
  "reddit_comment_depth": 3,         // Top N comments per post
  // Reddit credentials stored in oauth_tokens table (via OAuth flow)

  // --- Feed ---
  "feed_title": "Slowfeed",
  "feed_ttl_days": 14,               // How long to keep items in the feed

  // --- UI Auth ---
  "ui_password": "changeme"          // Basic auth for the Web UI
}
```

---

## Source Implementations

### Reddit (`src/sources/reddit.ts`)

**Auth:** OAuth2 via Reddit's installed app flow (no client secret needed for personal use).

**Polling logic:**
1. Call `GET /` (logged-in homepage) to get top `Z` posts
2. For each post, fetch `GET /r/{sub}/comments/{id}` to get top comments
3. Build feed item: title = post title, content = post body + top comments (formatted as HTML), url = reddit permalink, author = u/username
4. Dedup against `seen_posts` before inserting

**Notifications (`src/notifications/reddit-mail.ts`):**
1. Poll `GET /message/inbox` every N minutes
2. Each unread message/mention becomes a feed item with `is_notification = true`
3. Mark as read after ingesting (optional, configurable)

**Libraries:** `snoowrap` or raw `fetch` against `oauth.reddit.com`

---

### Bluesky (`src/sources/bluesky.ts`)

**Auth:** App Password + `@atproto/api` SDK. Store app password in config (not OAuth — Bluesky uses app passwords for third-party apps).

**Polling logic:**
1. Fetch the user's timeline: `agent.getTimeline({ limit: 100 })`
2. Score each post using an engagement heuristic:
   - Score = (likes × 1) + (reposts × 2) + (replies × 1.5) + recency_bonus
   - Recency bonus: decays posts older than 24h
3. Take top `Y` by score
4. Build feed item: content = post text + embedded images (as `<img>` tags if present), url = `https://bsky.app/profile/{did}/post/{rkey}`

**Notifications (`src/notifications/bluesky-replies.ts`):**
1. Poll `agent.listNotifications()` every N minutes, filter for `reply` and `mention` types
2. Each unread notification becomes a feed item with `is_notification = true`
3. Mark notifications as seen after ingesting

---

### YouTube (`src/sources/youtube.ts`)

**Auth:** Google OAuth2 via `googleapis` npm package.

**OAuth Setup Flow:**
1. On first run (or when no token exists), the Web UI shows an "Authorize YouTube" button
2. Clicking it redirects to Google OAuth consent screen
3. After approval, Google redirects back to `/auth/google/callback`
4. Access + refresh tokens are stored in `oauth_tokens` table
5. Token refresh is handled automatically before expiry

**Polling logic:**
1. Call `youtube.subscriptions.list` to get all subscribed channels
2. For each channel, call `youtube.search.list` with `publishedAfter` = last poll time
3. Each new video is a feed item: title = video title, content = description + thumbnail `<img>`, url = `https://youtube.com/watch?v={id}`
4. Dedup by video ID

**Note:** YouTube API quota is 10,000 units/day. Subscription list costs 1 unit per call; search costs 100 units per channel. Recommend caching the subscription list (refresh weekly) and only searching channels with recent activity. Warn in the UI if quota is at risk.

---

## RSS Feed Output (`src/feed.ts`)

- Serve at `GET /feed.rss` (RSS 2.0) and `GET /feed.atom` (Atom 1.0)
- Optional: `GET /feed.rss?source=reddit` to filter by source
- Feed is generated on-demand from the `digest_items` table
- Each digest is a consolidated post containing all new items from a single source since the last poll
- Items are sorted by `published_at` descending
- Content is HTML-escaped and sanitized
- Feed includes `<lastBuildDate>` and proper GUIDs

---

## Web UI (`src/ui/`)

Simple server-rendered + vanilla JS single-page app. No framework needed.

### Pages / Sections

**1. Dashboard (Home)**
- Feed health: last poll time per source, digest counts, any errors
- "Refresh Now" buttons per source (triggers manual poll, creates digest)
- Live preview: last 20 digest items in a simple list with source badges

**2. Schedules**
- List of configured poll schedules with enable/disable toggles
- Add/Edit schedule modal with:
  - Name (e.g., "Morning Digest")
  - Time and timezone
  - Days of week (with quick-select for weekdays/weekends/all)
  - Sources to poll (Reddit, Bluesky, YouTube, Discord)
- "Run Now" button per schedule
- Next/last run times displayed

**3. Settings — General**
- Feed TTL (days to keep items)
- Feed title
- UI password change

**3. Settings — Bluesky**
- Enable/disable toggle
- Handle + app password fields (password masked)
- Y (top posts count) slider/input
- Test connection button

**4. Settings — YouTube**
- Enable/disable toggle
- OAuth status ("Connected as you@gmail.com" or "Not connected")
- "Authorize YouTube" / "Revoke Access" button
- Subscription count (fetched from API)

**5. Settings — Reddit**
- Enable/disable toggle
- OAuth status + "Authorize Reddit" / "Revoke" button
- Z (top posts count) slider/input
- Comment depth setting
- Include/exclude notifications toggle

**6. Feed Preview**
- Full scrollable list of current feed items
- Filter by source
- Click to expand full content

---

## Deduplication Strategy (`src/dedup.ts`)

- Each potential feed item gets an ID: `sha256(source + ":" + platform_post_id)`
- Before inserting, check `seen_posts` for this ID
- If found: skip
- If not found: insert into both `seen_posts` and `feed_items`
- `seen_posts` is never pruned (keeps dedup working even after feed items expire)
- `feed_items` are pruned on schedule based on `feed_ttl_days`

---

## Docker Setup

### `docker-compose.yml`
```yaml
version: '3.9'
services:
  slowfeed:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # Localhost only; Cloudflare Tunnel connects here
    environment:
      - DATABASE_URL=postgresql://slowfeed:slowfeed@db:5432/slowfeed
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}  # For encrypting tokens at rest
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./data:/app/data       # For any local file storage if needed

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: slowfeed
      POSTGRES_PASSWORD: slowfeed
      POSTGRES_DB: slowfeed
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U slowfeed"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pg_data:
```

### `Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

---

## Remote Access: Cloudflare Tunnel

Cloudflare Tunnel exposes the local `:3000` port to a public HTTPS URL without opening firewall ports or needing a static IP. It's free.

### Setup Steps (document in README)

1. **Create a Cloudflare account** and add a domain (or use a free `*.trycloudflare.com` URL for testing)

2. **Install cloudflared** on the Mac Mini:
   ```bash
   brew install cloudflare/cloudflare/cloudflared
   ```

3. **Authenticate:**
   ```bash
   cloudflared tunnel login
   ```

4. **Create a named tunnel:**
   ```bash
   cloudflared tunnel create slowfeed
   ```

5. **Create config file** at `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <TUNNEL_ID>
   credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json
   ingress:
     - hostname: slowfeed.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

6. **Add DNS record:**
   ```bash
   cloudflared tunnel route dns slowfeed slowfeed.yourdomain.com
   ```

7. **Run as a macOS service (auto-start on boot):**
   ```bash
   sudo cloudflared service install
   ```

8. **Your RSS feed URL:** `https://slowfeed.yourdomain.com/feed.rss`

### Security Note
The Web UI will be publicly accessible. **Ensure you set a strong `ui_password` in settings before exposing via Cloudflare Tunnel.** The RSS feed endpoint itself does not require a password (RSS readers don't handle auth well), but an optional token-in-URL scheme can be added: `GET /feed.rss?token=<secret>`.

---

## OAuth Setup Details

### Reddit OAuth
- Register app at https://www.reddit.com/prefs/apps
- App type: "installed app" (no client secret)
- Redirect URI: `http://localhost:3000/auth/reddit/callback`
- Scopes needed: `read`, `privatemessages`, `identity`
- Client ID is stored in config; token stored in `oauth_tokens`

### Google/YouTube OAuth
- Create project at https://console.cloud.google.com
- Enable YouTube Data API v3
- Create OAuth 2.0 credentials (Web Application type)
- Authorized redirect URI: `http://localhost:3000/auth/google/callback`
  - Also add your Cloudflare Tunnel URL as a redirect URI: `https://slowfeed.yourdomain.com/auth/google/callback`
- Scopes needed: `https://www.googleapis.com/auth/youtube.readonly`
- Client ID and client secret stored in config; token in `oauth_tokens`

---

## Notification Behavior

Notifications (Reddit inbox, Bluesky replies/mentions) are included in digests when a schedule runs.

In the digest content, notifications appear with:
- A distinct title prefix: `[Reply] @user mentioned you on Bluesky` or `[Reddit Mail] Re: your comment in r/sub`
- `isNotification = true` flag in the post data
- Grouped separately within the digest HTML

---

## Environment Variables (`.env.example`)

```bash
# Required
DATABASE_URL=postgresql://slowfeed:slowfeed@db:5432/slowfeed
ENCRYPTION_KEY=generate-a-random-32-char-string-here

# Optional overrides (most config lives in the DB via Web UI)
PORT=3000
NODE_ENV=production
```

---

## Implementation Order (Suggested for Claude Code)

1. **Bootstrap:** TypeScript project, Express server, Docker Compose, DB migrations, config system
2. **Feed endpoint:** Basic RSS/Atom output from `feed_items` (even if empty)
3. **Web UI shell:** Dashboard + Settings pages with save/load against DB
4. **Dedup module:** Core deduplication utility
5. **Reddit integration:** OAuth flow → polling → feed items → notifications
6. **Bluesky integration:** App password auth → timeline → scoring → feed items → notifications
7. **YouTube integration:** Google OAuth flow → subscriptions → new videos
8. **Scheduler:** Wire up cron jobs for all sources + notification intervals
9. **Feed preview UI:** Live preview page in Web UI
10. **Polish:** Error handling, quota warnings, logging, README

---

## Key Dependencies (npm)

```json
{
  "dependencies": {
    "express": "^4.18",
    "pg": "^8.11",
    "node-cron": "^3.0",
    "feed": "^4.2",
    "googleapis": "^140",
    "@atproto/api": "^0.13",
    "snoowrap": "^1.23",
    "bcrypt": "^5.1",
    "dotenv": "^16",
    "winston": "^3.11"
  },
  "devDependencies": {
    "typescript": "^5.3",
    "@types/express": "^4.17",
    "@types/pg": "^8.10",
    "@types/node": "^20",
    "tsx": "^4.7"
  }
}
```

---

## Notes & Edge Cases to Handle

- **YouTube quota:** Cache subscription list; skip channels not updated recently; show quota usage in UI
- **Bluesky rate limits:** AT Protocol has rate limits; back off on 429 responses
- **Reddit token refresh:** snoowrap handles this, but log failures clearly
- **Feed reader compatibility:** Some readers are picky about GUIDs changing — use stable IDs
- **First run:** If DB is empty, poll immediately on startup rather than waiting for first cron tick
- **Timezone:** Store all timestamps in UTC; render in local time in Web UI only
- **Feed item content size:** Truncate very long Reddit posts to ~2000 chars with a "read more" link