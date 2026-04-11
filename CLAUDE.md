# Slowfeed

## Overview

Slowfeed is a self-hosted feed aggregator that polls Reddit, Bluesky, YouTube, and Discord on configurable schedules, deduplicates posts, and serves digests via a JSON API consumed by a native iOS/macOS app. The server is a Node.js/TypeScript API backed by PostgreSQL, hosted on Railway. A SwiftUI client app provides the reading experience and full administration (configuration, schedules, logs).

## Components

### Server (`src/`)
- **Runtime:** Node.js 20, TypeScript, Express
- **Database:** PostgreSQL
- **Hosting:** Railway (production URL: `slowfeed-production.up.railway.app`)
- **Auth:** WebAuthn/Passkeys via `@simplewebauthn/server`
- **Role:** JSON API only — no web UI, no HTML rendering, no RSS/Atom feeds

### Native Client App (`slowfeed-client/`)
- **Language:** Swift, SwiftUI
- **Platforms:** macOS, iOS, visionOS
- **Dependencies:** None (pure Apple frameworks)
- **Auth:** Passkeys via AuthenticationServices
- **Project:** Xcode project (`slowfeed-client.xcodeproj`), no SPM/CocoaPods
- **Bundle ID:** `com.markschmidt.slowfeed-client`
- **Role:** Primary UI for reading digests, managing schedules, configuring sources, viewing server logs

## Development Commands

```bash
# Server
npm install
npm run build          # TypeScript compile
npm run dev            # Dev mode with auto-reload (tsx watch)
npm start              # Run built version

# Database (local dev)
docker compose up db -d
docker compose down

# Full stack (Docker)
docker compose up --build

# Swift client
cd slowfeed-client
xcodebuild -scheme slowfeed-client -destination 'platform=macOS' build
# Or open slowfeed-client.xcodeproj in Xcode
```

**Local URLs:**
- API: http://localhost:3000
- Health check: http://localhost:3000/health

## Project Structure

```
slowfeed/
├── src/
│   ├── index.ts                # Entry point, Express server
│   ├── scheduler.ts            # node-cron schedule execution
│   ├── schedules.ts            # Schedule CRUD
│   ├── digest.ts               # Digest creation + storage
│   ├── db.ts                   # PostgreSQL connection + migrations
│   ├── dedup.ts                # Deduplication (sha256-based)
│   ├── config.ts               # Config read/write from DB
│   ├── logger.ts               # Winston logging (console + in-memory buffer)
│   ├── webauthn.ts             # Passkey auth
│   ├── saved-posts.ts          # Saved/bookmarked posts
│   ├── types/index.ts          # TypeScript types
│   ├── sources/
│   │   ├── reddit.ts           # Reddit polling (cookie-based scraping)
│   │   ├── bluesky.ts          # Bluesky polling (AT Protocol API)
│   │   ├── youtube.ts          # YouTube polling (cookie-based scraping)
│   │   └── discord.ts          # Discord polling
│   ├── notifications/
│   │   ├── reddit-mail.ts      # Reddit inbox
│   │   └── bluesky-replies.ts  # Bluesky notifications
│   └── ui/
│       └── routes.ts           # All API routes
├── slowfeed-client/
│   └── slowfeed-client/
│       ├── slowfeed_clientApp.swift     # App entry point
│       ├── ContentView.swift            # Root navigation
│       ├── Models/Models.swift          # Data models
│       ├── Services/
│       │   ├── APIClient.swift          # REST client, session auth
│       │   ├── AuthService.swift        # Passkey auth
│       │   └── HTTPLogger.swift         # Network debugging
│       ├── ViewModels/AppState.swift    # Central @Observable state
│       └── Views/
│           ├── MainView.swift           # Tab bar / sidebar
│           ├── DigestView.swift         # Digest + post rendering
│           ├── SavedPostsView.swift     # Bookmarked posts
│           ├── SettingsView.swift       # All settings (general, sources, schedules, logs, passkeys, account)
│           ├── AuthenticationView.swift # Passkey login
│           ├── ServerSetupView.swift    # Server URL config
│           └── HTTPLogView.swift        # Network log viewer
├── migrations/                 # 7 SQL migrations (001-007)
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## Database

7 migrations in `migrations/`:
1. `001_initial.sql` — config, seen_posts, feed_items, oauth_tokens
2. `002_schedules_and_digests.sql` — poll_schedules, digest_items
3. `003_poll_runs.sql` — poll_runs tracking
4. `004_passkey_credentials.sql` — WebAuthn credentials + challenges
5. `005_digest_read_tracking.sql` — read_at on digests
6. `006_digest_posts_json.sql` — structured post data (posts_json column)
7. `007_saved_posts.sql` — saved_posts table

Key tables: `config`, `seen_posts`, `poll_schedules`, `poll_runs`, `digest_items`, `passkey_credentials`, `saved_posts`

## Environment Variables

```bash
DATABASE_URL=postgresql://slowfeed:slowfeed@localhost:5432/slowfeed
ENCRYPTION_KEY=<random-32-char-string>
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
BASE_URL=http://localhost:3000    # or Railway production URL
WEBAUTHN_RP_ID=localhost          # domain for passkey binding
WEBAUTHN_RP_NAME=Slowfeed
WEBAUTHN_ORIGIN=http://localhost:3000
APPLE_TEAM_ID=C2UW47HS8X
APPLE_BUNDLE_ID=com.markschmidt.slowfeed-client
```

## Sources

- **Reddit** — Scrapes old.reddit.com; optionally uses browser cookies for personalized feed
- **Bluesky** — AT Protocol API with app password; scores posts by engagement; fetches timeline + notifications
- **YouTube** — Scrapes youtube.com/feed/subscriptions using browser cookies (no API quota)
- **Discord** — Polls Discord channels

## Key Architecture Notes

- Digests store structured post data in `posts_json` (JSONB); the native app renders posts natively in SwiftUI
- Server is a pure JSON API — no HTML rendering, no web UI, no RSS/Atom feeds
- The native app is the sole UI: it handles digest reading, source configuration, schedule management, server log viewing, and passkey management
- Auth uses passkeys throughout; sessions via `X-Session-Id` header + `slowfeed_session` cookie
- Deduplication: `sha256(source + ":" + platform_post_id)` checked against `seen_posts` table
