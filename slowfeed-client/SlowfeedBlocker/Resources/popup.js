// Master on/off toggle, persisted to extension storage. block.js mirrors this
// and applies/clears the overlay live, so toggling here takes effect on the
// next navigation without a reload.
(function () {
  "use strict";
  var box = document.getElementById("enabled");

  browser.storage.local.get("enabled").then(function (res) {
    box.checked = res.enabled !== false; // default ON
  });

  box.addEventListener("change", function () {
    browser.storage.local.set({ enabled: box.checked });
  });
})();
