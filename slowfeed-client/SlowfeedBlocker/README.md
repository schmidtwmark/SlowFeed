# Slowfeed Blocker (Safari Web Extension)

Blocks the infinite-feed surfaces of Reddit, Bluesky, and YouTube so you read
your scheduled Slowfeed digest instead of doomscrolling. Bundled inside the
Slowfeed app — installing the app installs the extension.

## What it blocks

| Site | Blocked (full-screen overlay) | Still works |
|------|-------------------------------|-------------|
| **Reddit** | home `/`, `/r/all`, `/r/popular`, any subreddit listing | individual posts (`/r/<sub>/comments/…`), so Slowfeed links open |
| **Bluesky** | home feed (`bsky.app/`) | profiles + individual posts |
| **YouTube** | home `/`, the Shorts feed, Explore/Trending; recommendation rail + end screens hidden on `/watch`; Shorts shelves hidden everywhere; the algorithmic **"Most relevant"** shelf hidden on Subscriptions | Subscriptions (the chronological "Latest" list), watching a video, **a single linked Short**, search, channel pages |

Mastodon is intentionally not covered.

### Single Shorts

A Short someone links you plays; the Shorts *feed* does not. The first
`/shorts/<id>` a page load sees is allowed — that's the one the link opened —
and every other short is blocked, so swiping to the next one hits the overlay
instead. The next/previous controls are hidden while a permitted short is
playing. Opening a different link is a fresh page load, so it gets its own
allowance; scrolling never does.

## Chrome

The same code ships as a Chrome extension — see [`chrome-extension/`](../../chrome-extension/)
at the repo root. `Resources/` here is the source of truth; the scripts bind
`browser` or `chrome` at runtime, so the same files run in both. After editing
anything here, re-sync with:

```bash
./scripts/build-chrome-extension.sh
```

## Enabling it

**macOS:** run the Slowfeed app once, then Safari → Settings → Extensions →
enable **Slowfeed Blocker** → set it to "Allow" on the three sites (or "Always
Allow on Every Website").

**iOS:** installing the app installs the extension. Settings → Apps → Safari →
Extensions → Slowfeed Blocker → turn on, then allow the sites.

The toolbar popup has a master **Enable blocking** switch to pause it without
uninstalling. Changes apply on the next navigation (no reload needed).

## Files

- `Resources/manifest.json` — MV3 manifest; one content script over the three
  domains at `document_start`.
- `Resources/rules.js` — pure per-site routing logic (`SlowfeedRules.decide`).
- `Resources/block.js` — mounts/removes the overlay, follows SPA navigation,
  toggles the YouTube "hide recommendations" class.
- `Resources/block.css` — overlay styling + YouTube element-hiding.
- `Resources/popup.html` / `popup.js` — master on/off toggle.
- `SafariWebExtensionHandler.swift` — required no-op native handler.

## The "Open Slowfeed" button

The blocked overlay's **Open Slowfeed** button navigates to `slowfeed://open`.
The `slowfeed` URL scheme is registered on the app (Target → Info → URL Types,
persisted via `slowfeed-client/Info.plist`), so the button launches the app.

## iOS: per-site permission (important)

Safari grants extension access **per host**, and these sites use different hosts
on mobile vs. desktop — most notably YouTube is `www.youtube.com` on desktop but
`m.youtube.com` on iPhone. Allowing the extension on the desktop host does **not**
cover the mobile host. If a site isn't being blocked on iOS, open it in Safari,
tap the **page-settings (ᴀA / extensions) button → Slowfeed Blocker → Allow** (or
set "Always Allow"), for each of: `m.youtube.com`, `www.youtube.com`,
`reddit.com`, `bsky.app`. The path-based blocking is host-independent once the
extension is permitted on that host.
