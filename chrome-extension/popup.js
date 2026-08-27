// Master on/off toggle, persisted to extension storage. block.js mirrors this
// and applies/clears the overlay live, so toggling here takes effect on the
// next navigation without a reload.
(function () {
  "use strict";
  var box = document.getElementById("enabled");

  // Safari and Firefox expose `browser`; Chrome exposes only `chrome`. The
  // same bundle ships to both, so bind whichever is present.
  var api = (typeof browser !== "undefined" && browser.storage) ? browser
          : (typeof chrome !== "undefined" && chrome.storage) ? chrome
          : null;
  if (!api) return;

  api.storage.local.get("enabled").then(function (res) {
    box.checked = res.enabled !== false; // default ON
  });

  box.addEventListener("change", function () {
    api.storage.local.set({ enabled: box.checked });
  });
})();
