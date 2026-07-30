// Pure routing rules for the Slowfeed blocker. No DOM side effects — just
// "given this host + path, should the page be blocked, and should YouTube
// recommendations be hidden?". Exposed as a shared global so block.js (which
// runs in the same content-script world) can call SlowfeedRules.decide().
//
// Declared with `var` so the binding lands on the shared content-script
// global and is visible to block.js, which is injected after this file.
var SlowfeedRules = (function () {
  "use strict";

  // Reddit: block the home feed and every listing (/r/all, /r/popular, any
  // subreddit + its sort tabs), but allow individual posts so Slowfeed's
  // deep-links (which point at /r/<sub>/comments/<id>/...) still open.
  function reddit(path) {
    if (path.includes("/comments/")) return { block: false };
    if (path === "/" || /^\/r\/[^/]+/.test(path)) return { block: true };
    return { block: false };
  }

  // Bluesky: block only the home feed (the SPA entry at "/"). Profiles and
  // individual posts (/profile/<handle>/post/<id>) stay reachable.
  function bluesky(path) {
    return { block: path === "/" };
  }

  // YouTube: block Home, Shorts, and Explore/Trending. Allow Subscriptions,
  // search, channel pages, playlists, and watching a video — but hide the
  // recommendation rail + end screens on /watch (handled via a class toggle
  // that block.css keys off of). Shorts *shelves* are hidden everywhere by
  // block.css regardless. On Subscriptions, the "Most relevant" shelf — the
  // recommendation engine re-ranking your own subs — is hidden so the feed
  // stays chronological ("Latest" survives).
  function youtube(path) {
    if (path === "/") return { block: true };
    if (path.startsWith("/shorts/")) return { block: true };
    if (path === "/feed/trending" || path === "/feed/explore") return { block: true };
    if (path === "/watch") return { block: false, hideRecs: true };
    if (path === "/feed/subscriptions") return { block: false, hideMostRelevant: true };
    return { block: false };
  }

  function decide(host, path) {
    if (/(^|\.)youtube\.com$/.test(host)) return youtube(path);
    if (host === "bsky.app") return bluesky(path);
    if (/(^|\.)reddit\.com$/.test(host)) return reddit(path);
    return { block: false };
  }

  return { decide: decide };
})();
