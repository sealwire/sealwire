(function () {
  var KEY = "agent-relay.theme";
  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch (e) { return "auto"; }
  }
  function osLight() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }
  function apply() {
    var s = read();
    document.documentElement.dataset.theme = s === "auto" ? (osLight() ? "light" : "dark") : s;
  }
  apply();
  if (window.matchMedia) {
    var mql = window.matchMedia("(prefers-color-scheme: light)");
    var handler = function () { if (read() === "auto") apply(); };
    if (mql.addEventListener) mql.addEventListener("change", handler);
    else if (mql.addListener) mql.addListener(handler);
  }
})();
