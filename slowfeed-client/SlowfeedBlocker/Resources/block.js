// Slowfeed blocker content script. Runs at document_start on Reddit, Bluesky,
// and YouTube. Decides (via SlowfeedRules) whether the current route is a
// feed surface; if so, covers the page with an opaque "blocked" overlay. The
// overlay is mounted/removed live on SPA navigation so going post -> home
// re-blocks without a reload. On YouTube /watch it toggles a class that
// block.css uses to hide the recommendation rail.
(function () {
  "use strict";

  var OVERLAY_ID = "slowfeed-block";
  var enabled = true; // master toggle, mirrored from extension storage

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
      // Best-effort app launch; no-op if the slowfeed:// scheme isn't
      // registered. The overlay still does its job either way.
      location.href = "slowfeed://open";
    });
    actions.appendChild(open);

    // On YouTube, offer a one-tap escape to the one allowed feed.
    if (/(^|\.)youtube\.com$/.test(location.hostname)) {
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
    // Append to <html> — it exists at document_start before <body>, so the
    // feed never flashes underneath.
    (document.documentElement || document.body).appendChild(buildOverlay());
    document.documentElement.classList.add("slowfeed-blocked");
  }

  function hideOverlay() {
    var o = document.getElementById(OVERLAY_ID);
    if (o) o.remove();
    document.documentElement.classList.remove("slowfeed-blocked");
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
  }

  // Coalesce rapid re-evaluations (history spam during SPA boot) into one.
  var pending = 0;
  function queueApply() {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(function () {
      pending = 0;
      apply();
    });
  }

  // Hook client-side navigation so route changes re-evaluate.
  function hookHistory() {
    var push = history.pushState;
    var replace = history.replaceState;
    history.pushState = function () {
      var r = push.apply(this, arguments);
      queueApply();
      return r;
    };
    history.replaceState = function () {
      var r = replace.apply(this, arguments);
      queueApply();
      return r;
    };
    window.addEventListener("popstate", queueApply);
    window.addEventListener("hashchange", queueApply);
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
      // No storage access (shouldn't happen) — fail open to "enabled".
    }
  }

  hookHistory();
  watchEnabled();
  apply();
  document.addEventListener("DOMContentLoaded", apply);
})();
