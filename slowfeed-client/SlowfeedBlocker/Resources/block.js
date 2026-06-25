// Slowfeed blocker content script. Runs at document_start on Reddit, Bluesky,
// and YouTube. Decides (via SlowfeedRules) whether the current route is a feed
// surface; if so, covers the page with an opaque "blocked" overlay. On YouTube
// it also hides Shorts shelves and (on /watch) the recommendation rail.
//
// SPA note: patching history.pushState here is useless — content scripts run in
// an isolated world, so the page's router calls a *different* history object we
// can't intercept. We instead POLL location for changes (works cross-world) and
// also listen to popstate / YouTube's own yt-navigate events.
(function () {
  "use strict";

  var OVERLAY_ID = "slowfeed-block";
  var enabled = true; // master toggle, mirrored from extension storage
  var isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
  var lastHref = location.href;

  function decision() {
    try {
      return SlowfeedRules.decide(location.hostname, location.pathname);
    } catch (e) {
      return { block: false };
    }
  }

  function buildOverlay() {
    var o = document.createElement("div");
    o.id = OVERLAY_ID;

    var card = document.createElement("div");
    card.className = "slowfeed-card";

    var title = document.createElement("div");
    title.className = "slowfeed-title";
    title.textContent = "Blocked by Slowfeed";

    var body = document.createElement("div");
    body.className = "slowfeed-body";
    body.textContent =
      "This is one of the endless feeds Slowfeed replaces. Open the app to read your scheduled digest — when you run out, you're done.";

    var actions = document.createElement("div");
    actions.className = "slowfeed-actions";

    var open = document.createElement("button");
    open.className = "slowfeed-btn slowfeed-btn-primary";
    open.textContent = "Open Slowfeed";
    open.addEventListener("click", function () {
      location.href = "slowfeed://open";
    });
    actions.appendChild(open);

    if (isYouTube) {
      var subs = document.createElement("button");
      subs.className = "slowfeed-btn";
      subs.textContent = "Go to Subscriptions";
      subs.addEventListener("click", function () {
        location.assign("/feed/subscriptions");
      });
      actions.appendChild(subs);
    }

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(actions);
    o.appendChild(card);
    return o;
  }

  function showOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    (document.documentElement || document.body).appendChild(buildOverlay());
    document.documentElement.classList.add("slowfeed-blocked");
  }

  function hideOverlay() {
    var o = document.getElementById(OVERLAY_ID);
    if (o) o.remove();
    document.documentElement.classList.remove("slowfeed-blocked");
  }

  // Hide Shorts shelves structurally: find every link to a Short and hide its
  // nearest shelf/section ancestor. This is DOM-name-agnostic, so it works on
  // both desktop (ytd-*) and mobile (ytm-* / lockup view-models) without
  // chasing YouTube's element renames. The bottom-nav "Shorts" tab uses
  // href="/shorts" (no id) and isn't matched, so navigation isn't broken —
  // tapping it just hits the path block instead.
  function hideShortsShelves() {
    if (!isYouTube) return;
    var links = document.querySelectorAll(
      'a[href^="/shorts/"], a[href*="youtube.com/shorts/"]'
    );
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      for (var depth = 0; depth < 10 && el && el !== document.body; depth++) {
        var tag = (el.tagName || "").toLowerCase();
        if (/(shelf|reel|rich-section|item-section|rich-grid-row)/.test(tag)) {
          el.style.setProperty("display", "none", "important");
          break;
        }
        el = el.parentElement;
      }
    }
  }

  function apply() {
    if (!enabled) {
      hideOverlay();
      document.documentElement.classList.remove("slowfeed-hide-recs");
      return;
    }
    var d = decision();
    if (d.block) showOverlay();
    else hideOverlay();
    document.documentElement.classList.toggle("slowfeed-hide-recs", !!d.hideRecs);
    hideShortsShelves();
  }

  // Re-evaluate when the URL changes (covers SPA navigation reliably).
  function onMaybeNavigated() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      apply();
    }
  }

  // Mirror the master on/off toggle from the popup.
  function watchEnabled() {
    try {
      browser.storage.local.get("enabled").then(function (res) {
        enabled = res.enabled !== false; // default ON when unset
        apply();
      });
      browser.storage.onChanged.addListener(function (changes, area) {
        if (area === "local" && changes.enabled) {
          enabled = changes.enabled.newValue !== false;
          apply();
        }
      });
    } catch (e) {
      // No storage access — fail open to "enabled".
    }
  }

  watchEnabled();
  apply();
  document.addEventListener("DOMContentLoaded", apply);

  // Navigation signals: popstate (back/forward), YouTube's own SPA events, and
  // a poll as the catch-all for pushState navigation we can't hook directly.
  window.addEventListener("popstate", onMaybeNavigated);
  window.addEventListener("hashchange", onMaybeNavigated);
  document.addEventListener("yt-navigate-finish", apply, true);
  document.addEventListener("yt-navigate-start", onMaybeNavigated, true);
  setInterval(onMaybeNavigated, 300);

  // The feed streams in lazily, so re-run the Shorts-shelf hider as the DOM
  // grows (debounced to once per frame).
  if (isYouTube) {
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        hideShortsShelves();
      });
    });
    var startObserving = function () {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    };
    if (document.body) startObserving();
    else document.addEventListener("DOMContentLoaded", startObserving);
  }
})();
