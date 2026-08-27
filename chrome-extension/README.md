# Slowfeed Blocker — Chrome

The Chrome build of the Slowfeed blocker. Same behavior as the Safari
extension: it blocks the infinite-feed surfaces of Reddit, Bluesky, and YouTube
so you read your scheduled digest instead of doomscrolling.

Having it in both browsers is the point — blocking only Safari leaves Chrome as
a one-click way around your own rules.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `chrome-extension/` folder

It stays installed across restarts. Chrome may show "Disable developer mode
extensions" prompts on launch; dismissing that leaves the extension working.

The toolbar popup has a master **Enable blocking** switch to pause it without
uninstalling. Changes apply on the next navigation, no reload needed.

## What it blocks

| Site | Blocked | Still works |
|------|---------|-------------|
| **Reddit** | home, `/r/all`, `/r/popular`, any subreddit listing | individual posts, so Slowfeed links open |
| **Bluesky** | home feed | profiles + individual posts |
| **YouTube** | home, the Shorts feed, Explore/Trending; the "Most relevant" shelf on Subscriptions; recommendation rail + end screens on `/watch`; Shorts shelves everywhere | Subscriptions ("Latest"), watching a video, a single linked Short, search, channel pages |

A Short someone sends you plays; the Shorts feed does not. The first
`/shorts/<id>` a page load sees is allowed and every other one is blocked, so
swiping to the next short hits the overlay.

## This directory is generated

Do not edit these files directly. The source of truth is the Safari extension's
resources at `slowfeed-client/SlowfeedBlocker/Resources/` — the scripts are
written against MV3 and bind `browser` or `chrome` at runtime, so one copy runs
in both browsers. To pull changes through:

```bash
./scripts/build-chrome-extension.sh
```

To verify this folder hasn't drifted from the source:

```bash
./scripts/build-chrome-extension.sh --check
```

## The "Open Slowfeed" button

The blocked overlay's **Open Slowfeed** button navigates to `slowfeed://open`.
That scheme is registered by the macOS app, so the button works if the app is
installed; otherwise Chrome ignores it and the overlay still blocks.
