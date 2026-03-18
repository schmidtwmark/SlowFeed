# Slowfeed

A self-hosted RSS feed aggregator that polls Reddit, Bluesky, and YouTube on a configurable schedule, deduplicates posts, and serves a valid RSS/Atom feed to any RSS reader.

## Features

- **Multi-source aggregation**: Reddit front page, Bluesky timeline, YouTube subscriptions
- **Smart polling**: Configurable intervals for content (hours) and notifications (minutes)
- **Engagement scoring**: Bluesky posts ranked by likes, reposts, replies, and recency
- **Notifications**: Bluesky mentions/replies appear at the top of your feed
- **Deduplication**: SHA-256 hashing ensures you never see the same post twice
- **Web UI**: Configure sources, view feed preview, trigger manual refreshes
- **Docker-ready**: Single `docker-compose up` to run everything
- **Remote access**: Cloudflare Tunnel support for secure external access

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

Default password: `changeme` (change this in Settings after logging in)

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

All settings are managed through the Web UI at http://localhost:3000.

| Setting | Default | Description |
|---------|---------|-------------|
| Poll Interval | 4 hours | How often to fetch new content |
| Notification Interval | 5 minutes | How often to check for Bluesky notifications |
| Feed TTL | 14 days | How long items stay in your feed |
| Reddit Top N | 30 | Number of posts from front page |
| Reddit Comment Depth | 3 | Levels of comments to include |
| Bluesky Top N | 20 | Number of top-scored posts to keep |

## Remote Access with Cloudflare Tunnel

To access Slowfeed from outside your network (e.g., for mobile RSS readers):

### Automatic Setup

```bash
./scripts/setup-cloudflare-tunnel.sh
```

### Manual Setup

1. Install cloudflared:
   ```bash
   # macOS
   brew install cloudflare/cloudflare/cloudflared

   # Linux
   curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared.deb
   ```

2. Authenticate:
   ```bash
   cloudflared tunnel login
   ```

3. Create tunnel:
   ```bash
   cloudflared tunnel create slowfeed
   ```

4. Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <TUNNEL_ID>
   credentials-file: /path/to/.cloudflared/<TUNNEL_ID>.json

   ingress:
     - hostname: slowfeed.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

5. Add DNS route:
   ```bash
   cloudflared tunnel route dns slowfeed slowfeed.yourdomain.com
   ```

6. Run as service:
   ```bash
   sudo cloudflared service install
   ```

7. Update `.env`:
   ```bash
   BASE_URL=https://slowfeed.yourdomain.com
   ```

8. Add `https://slowfeed.yourdomain.com/auth/google/callback` to your Google OAuth redirect URIs

Your feed is now available at `https://slowfeed.yourdomain.com/feed.rss`

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
| `POST /api/login` | Authenticate |
| `GET /api/config` | Get configuration |
| `POST /api/config` | Update configuration |
| `GET /api/stats` | Dashboard statistics |
| `POST /api/poll` | Trigger manual poll |
| `GET /auth/google` | Start YouTube OAuth |

## Troubleshooting

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
