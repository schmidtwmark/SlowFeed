# Slowfeed Blocker (Safari Web Extension)

Blocks the infinite-feed surfaces of Reddit, Bluesky, and YouTube so you read
your scheduled Slowfeed digest instead of doomscrolling. Bundled inside the
Slowfeed app — installing the app installs the extension.

## What it blocks

| Site | Blocked (full-screen overlay) | Still works |
|------|-------------------------------|-------------|
| **Reddit** | home `/`, `/r/all`, `/r/popular`, any subreddit listing | individual posts (`/r/<sub>/comments/…`), so Slowfeed links open |
| **Bluesky** | home feed (`bsky.app/`) | profiles + individual posts |
| **YouTube** | home `/`, Shorts, Explore/Trending; recommendation rail + end screens hidden on `/watch`; Shorts shelves hidden everywhere | Subscriptions, watching a video, search, channel pages |

Mastodon is intentionally not covered.

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

## Optional: the "Open Slowfeed" button

The blocked overlay has an **Open Slowfeed** button that navigates to
`slowfeed://open`. That URL scheme isn't registered on the app yet, so the
button is currently a no-op. To make it launch the app: in Xcode select the
**slowfeed-client** target → Info → URL Types → **+** → set URL Schemes to
`slowfeed`. (The generated-Info.plist build setup makes this awkward to do via
build settings, but the Xcode URL-Types editor handles it in one click.)
