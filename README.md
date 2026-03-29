# Slowfeed

A self-hosted RSS feed aggregator that polls Reddit, Bluesky, and YouTube on a configurable schedule, deduplicates posts, and serves a valid RSS/Atom feed to any RSS reader.

## Features

- **Multi-source aggregation**: Reddit front page, Bluesky timeline, YouTube subscriptions
- **Smart polling**: Configurable intervals for content (hours) and notifications (minutes)
- **Engagement scoring**: Bluesky posts ranked by likes, reposts, replies, and recency
- **Notifications**: Bluesky mentions/replies appear at the top of your feed
- **Deduplication**: SHA-256 hashing ensures you never see the same post twice
- **Web UI**: Configure sources, view feed preview, trigger manual refreshes
- **Passkey authentication**: Secure passwordless login using WebAuthn
- **Docker-ready**: Single `docker-compose up` to run everything
- **Cloud deployment**: Easy deployment to Railway or other platforms

## Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local development)
- Bluesky account with app password (for Bluesky integration)
- Browser cookies for YouTube and Reddit (for personalized feeds)

## Quick Start

### 1. Clone and Configure

```bash
git clone <your-repo-url> slowfeed
cd slowfeed
cp .env.example .env
```

Edit `.env` and set:

```bash
# Required - generate a random 32-character string
ENCRYPTION_KEY=your-random-32-char-encryption-key
```

### 2. Start with Docker

```bash
docker-compose up --build
```

### 3. Access the Web UI

Open http://localhost:3000 in your browser.

On first visit, you'll be prompted to create a passkey for secure authentication. Passkeys use your device's biometrics (Face ID, Touch ID, Windows Hello) or security key for passwordless login.

### 4. Subscribe to Your Feed

Add one of these URLs to your RSS reader:

- RSS 2.0: `http://localhost:3000/feed.rss`
- Atom: `http://localhost:3000/feed.atom`

Filter by source: `http://localhost:3000/feed.rss?source=reddit`

## Source Setup

### Reddit

Reddit is scraped from old.reddit.com. For a personalized feed based on your subscriptions, you can provide your browser cookies.

In the Web UI Settings:
1. Enable Reddit
2. (Optional) Add your browser cookies for personalized feed:
   - Open https://old.reddit.com in your browser and log in
   - Press F12 to open DevTools → Network tab
   - Refresh the page
   - Click any request to old.reddit.com
   - Find the `Cookie` header in the request headers
   - Copy the entire cookie value and paste it in Settings
3. Set the number of posts to fetch
4. Optionally enable comment fetching

### Bluesky

In the Web UI Settings:

1. Enable Bluesky
2. Enter your handle (e.g., `you.bsky.social`)
3. Generate an app password at https://bsky.app/settings/app-passwords
4. Enter the app password
5. Click "Test Connection" to verify

### YouTube

YouTube is scraped from youtube.com/feed/subscriptions using your browser cookies. No API quota limits!

In the Web UI Settings:
1. Enable YouTube
2. Add your browser cookies:
   - Open https://www.youtube.com in your browser and log in
   - Press F12 to open DevTools → Network tab
   - Refresh the page
   - Click any request to youtube.com
   - Find the `Cookie` header in the request headers
   - Copy the entire cookie value and paste it in Settings

**Note**: Cookies may expire over time. If YouTube stops working, simply re-copy your cookies from the browser.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Yes | 32-character string for encrypting tokens |
| `WEBAUTHN_RP_ID` | No | Domain for passkey binding (default: `localhost`) |
| `WEBAUTHN_RP_NAME` | No | Display name for passkeys (default: `Slowfeed`) |
| `WEBAUTHN_ORIGIN` | No | Full origin URL (default: `http://localhost:3000`) |
| `BASE_URL` | No | Base URL for feed links (default: `http://localhost:3000`) |
| `PORT` | No | Server port (default: `3000`) |

### Web UI Settings

All other settings are managed through the Web UI.

| Setting | Default | Description |
|---------|---------|-------------|
| Poll Interval | 4 hours | How often to fetch new content |
| Notification Interval | 5 minutes | How often to check for Bluesky notifications |
| Feed TTL | 14 days | How long items stay in your feed |
| Reddit Top N | 30 | Number of posts from front page |
| Reddit Comment Depth | 3 | Levels of comments to include |
| Bluesky Top N | 20 | Number of top-scored posts to keep |

## Deployment on Railway

Railway provides an easy way to deploy Slowfeed with a managed PostgreSQL database.

### 1. Create a Railway Project

1. Go to [railway.app](https://railway.app) and create a new project
2. Add a PostgreSQL database to your project
3. Add a new service from your GitHub repository

### 2. Configure Environment Variables

In your Railway service settings, add these environment variables:

```bash
# Required
DATABASE_URL=${{Postgres.DATABASE_URL}}    # Railway auto-fills this
ENCRYPTION_KEY=your-random-32-char-string  # Generate a secure random string

# WebAuthn Configuration (use your Railway domain)
WEBAUTHN_RP_ID=your-app.up.railway.app     # Your Railway domain (without https://)
WEBAUTHN_RP_NAME=Slowfeed
WEBAUTHN_ORIGIN=https://your-app.up.railway.app

# Feed URLs
BASE_URL=https://your-app.up.railway.app
```

**Important**: The `WEBAUTHN_RP_ID` must match your deployment domain exactly (without the protocol). Passkeys are bound to this domain and won't work if it's incorrect.

### 3. Deploy

Railway will automatically build and deploy your app. Once deployed:

1. Visit `https://your-app.up.railway.app`
2. Create your first passkey to set up authentication
3. Configure your feed sources in Settings

### 4. Subscribe to Your Feed

Add this URL to your RSS reader:
```
https://your-app.up.railway.app/feed.rss?token=YOUR_FEED_TOKEN
```

Get your feed token from the Dashboard in the Web UI.

### Custom Domain (Optional)

1. In Railway, go to your service Settings → Domains
2. Add your custom domain (e.g., `slowfeed.example.com`)
3. Update your DNS records as instructed by Railway
4. Update your environment variables:
   ```bash
   WEBAUTHN_RP_ID=slowfeed.example.com
   WEBAUTHN_ORIGIN=https://slowfeed.example.com
   BASE_URL=https://slowfeed.example.com
   ```

**Note**: After changing `WEBAUTHN_RP_ID`, existing passkeys will stop working. You'll need to clear the `passkey_credentials` table and create new passkeys.

## Development

### Local Setup

```bash
npm install
cp .env.example .env
# Edit .env with your settings

# Start PostgreSQL
docker-compose up db

# Run in development mode
npm run dev
```

### Build

```bash
npm run build
npm start
```

### Project Structure

```
src/
├── index.ts              # Express server entry point
├── db.ts                 # PostgreSQL connection + migrations
├── config.ts             # Configuration management
├── dedup.ts              # Deduplication logic
├── feed.ts               # RSS/Atom feed generation
├── scheduler.ts          # Cron job management
├── webauthn.ts           # Passkey authentication (WebAuthn)
├── oauth.ts              # Token encryption/storage
├── logger.ts             # Winston logging
├── sources/
│   ├── reddit.ts         # Reddit scraping (old.reddit.com)
│   ├── bluesky.ts        # Bluesky auth + polling
│   └── youtube.ts        # YouTube OAuth + polling
├── notifications/
│   └── bluesky-replies.ts # Bluesky notifications
└── ui/
    ├── routes.ts         # API routes
    └── public/           # Web UI static files
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /feed.rss` | RSS 2.0 feed |
| `GET /feed.atom` | Atom feed |
| `GET /feed.rss?source=reddit` | Filtered feed |
| `GET /health` | Health check |
| `GET /api/auth/setup-status` | Check if passkeys are configured |
| `POST /api/auth/register/start` | Start passkey registration |
| `POST /api/auth/register/finish` | Complete passkey registration |
| `POST /api/auth/login/start` | Start passkey authentication |
| `POST /api/auth/login/finish` | Complete passkey authentication |
| `GET /api/passkeys` | List registered passkeys |
| `GET /api/config` | Get configuration |
| `POST /api/config` | Update configuration |
| `GET /api/stats` | Dashboard statistics |
| `POST /api/poll` | Trigger manual poll |

## Troubleshooting

### Passkey not working / "Invalid or expired challenge"
- Ensure `WEBAUTHN_RP_ID` matches your domain exactly (without `https://`)
- Ensure `WEBAUTHN_ORIGIN` includes the full URL with protocol (e.g., `https://your-app.up.railway.app`)
- If you changed domains, existing passkeys won't work. Clear the `passkey_credentials` table and create new ones.

### "No passkeys registered"
Visit the web UI and create your first passkey. This happens on first-time setup.

### Passkey prompt doesn't appear
- Make sure you're using HTTPS (passkeys require a secure context)
- Try a different browser - some older browsers don't support WebAuthn
- Check that your device supports passkeys (most modern devices do)

### "YouTube cookies not configured"
Add your browser cookies in Settings. See the YouTube setup instructions above.

### "Bluesky login failed"
Verify your handle and app password. Use the "Test Connection" button to debug.

### YouTube/Reddit stopped working
Browser cookies expire over time. Re-copy your cookies from the browser and update them in Settings.

### Reddit posts not appearing
Reddit scraping depends on old.reddit.com being accessible. Check if the site is reachable from your server.

### Feed items not appearing
Check the dashboard for error messages. Ensure at least one source is enabled and configured.

## License

MIT
