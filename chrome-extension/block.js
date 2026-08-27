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

  // Safari and Firefox expose `browser`; Chrome exposes only `chrome`. The
  // same bundle ships to both, so bind whichever is present.
  var api = (typeof browser !== "undefined" && browser.storage) ? browser
          : (typeof chrome !== "undefined" && chrome.storage) ? chrome
          : null;

  // Which single Short this document may show.
  //
  // Shorts is an infinite vertical feed: opening /shorts/<id> and swiping
  // pulls sibling shorts in via SPA navigation, no page load. So we allow the
  // FIRST short this document sees — the one the link opened — and block
  // every other one. A short a friend sends plays; the feed behind it doesn't.
  //
  // Deliberately per-document: a fresh link is a fresh page load and gets its
  // own allowance, while swiping never does.
  var allowedShortId = null;

  function decision() {
    try {
      var d = SlowfeedRules.decide(location.hostname, location.pathname);
      if (d && d.shortId) {
        if (allowedShortId === null) allowedShortId = d.shortId;
        if (d.shortId === allowedShortId) {
          return { block: false, singleShort: true };
        }
        // A different short than the one we landed on — this is the feed.
      }
      return d;
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
  // Element-hiding is done with inline styles, tagged by REASON, so it can be
  // undone: turning the extension off (or navigating to a page where a rule
  // no longer applies) must restore the page without a reload. YouTube's
  // Polymer also recycles renderer nodes across SPA navigations, so a node
  // hidden on one page can reappear on another — untagged inline styles would
  // leak a permanent blank gap there.
  var HIDDEN_ATTR = "data-slowfeed-hidden";

  function hideEl(el, reason) {
    el.style.setProperty("display", "none", "important");
    el.setAttribute(HIDDEN_ATTR, reason);
  }

  function unhide(reason) {
    var sel = reason
      ? '[' + HIDDEN_ATTR + '="' + reason + '"]'
      : "[" + HIDDEN_ATTR + "]";
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      els[i].style.removeProperty("display");
      els[i].removeAttribute(HIDDEN_ATTR);
    }
  }

  function hideShortsShelves() {
    if (!isYouTube) return;
    // The MutationObserver calls this directly, so it needs its own enabled
    // check — without it, switching the extension off left Shorts shelves
    // hidden for the rest of the session.
    if (!enabled) {
      unhide("shorts");
      return;
    }
    var links = document.querySelectorAll(
      'a[href^="/shorts/"], a[href*="youtube.com/shorts/"]'
    );
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      for (var depth = 0; depth < 10 && el && el !== document.body; depth++) {
        var tag = (el.tagName || "").toLowerCase();
        if (/(shelf|reel|rich-section|item-section|rich-grid-row)/.test(tag)) {
          hideEl(el, "shorts");
          break;
        }
        el = el.parentElement;
      }
    }
  }

  // Subscriptions is the one feed we deliberately KEEP — but YouTube tops it
  // with a "Most relevant" shelf of algorithmically re-ranked picks, which is
  // the recommendation engine sneaking back into the chronological surface.
  // Hide that shelf; "Latest" survives. Matched by header TEXT rather than
  // element names (same rename-proofing rationale as hideShortsShelves): a
  // heading-like node reading exactly "Most relevant", walked up to its
  // nearest shelf/section ancestor. The walk bails if it crosses a video item
  // first, so a video literally titled "Most relevant" can never hide the row
  // it sits in. English-only match — add translations if the UI language ever
  // changes.
  function hideMostRelevantShelf() {
    if (!isYouTube) return;
    // Reveal again when switched off, or when we've navigated off
    // Subscriptions onto a page where this rule doesn't apply (Polymer can
    // recycle the very node we hid).
    if (!enabled || !decision().hideMostRelevant) {
      unhide("relevant");
      return;
    }
    // `#title` (any element) covers YouTube's shelf heading whether it ships
    // as a <span>, a <yt-formatted-string>, or whatever replaces them next.
    // Video titles also use #title, but the walk below bails out on video
    // containers before it can hide one.
    var heads = document.querySelectorAll(
      'h2, h3, [role="heading"], #title, .rich-shelf-title'
    );
    for (var i = 0; i < heads.length; i++) {
      if ((heads[i].textContent || "").trim().toLowerCase() !== "most relevant") continue;
      var el = heads[i];
      for (var depth = 0; depth < 12 && el && el !== document.body; depth++) {
        var tag = (el.tagName || "").toLowerCase();
        if (/(rich-item|video-renderer|lockup|reel-item)/.test(tag)) break;
        if (/(shelf|rich-section|item-section)/.test(tag)) {
          hideEl(el, "relevant");
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
      document.documentElement.classList.remove("slowfeed-single-short");
      // Restore everything we hid, so the popup's off switch fully reverts
      // the page instead of leaving blank gaps until a reload.
      unhide();
      return;
    }
    var d = decision();
    if (d.block) showOverlay();
    else hideOverlay();
    document.documentElement.classList.toggle("slowfeed-hide-recs", !!d.hideRecs);
    document.documentElement.classList.toggle("slowfeed-single-short", !!d.singleShort);
    hideShortsShelves();
    hideMostRelevantShelf();
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
    if (!api) return; // No extension storage — fail open to "enabled".
    try {
      api.storage.local.get("enabled").then(function (res) {
        enabled = res.enabled !== false; // default ON when unset
        apply();
      });
      api.storage.onChanged.addListener(function (changes, area) {
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

  // The feed streams in lazily, so re-run the shelf hiders as the DOM grows
  // (debounced to once per frame).
  if (isYouTube) {
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        hideShortsShelves();
        hideMostRelevantShelf();
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
