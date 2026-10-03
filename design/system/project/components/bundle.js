/* @ds-bundle: {"format":4,"namespace":"Materia","components":[]} */
/*
 * Materia preview runtime. Mirrors what the Angular Primitives directives do in the app: it sets
 * data-hover, data-press and data-focus-visible on interactive mt-* elements so the CSS states can be
 * tried in previews. Elements with data-static keep the state they were rendered with.
 */
(function () {
  var SEL = ".mt-btn,.mt-ibtn,.mt-nav,.mt-tab,.mt-seg-item,.mt-check,.mt-radio,.mt-switch,.mt-menu-item,.mt-input,.mt-chip,.mt-cite,.mt-matter-card,.mt-task,.mt-send,.mt-choice";
  function target(e) {
    var el = e.target && e.target.closest ? e.target.closest(SEL) : null;
    return el && !el.hasAttribute("data-static") && !el.hasAttribute("data-disabled") ? el : null;
  }
  var keyboard = false;
  document.addEventListener("keydown", function () { keyboard = true; }, true);
  document.addEventListener("pointerdown", function () { keyboard = false; }, true);
  document.addEventListener("pointerover", function (e) { var el = target(e); if (el) el.setAttribute("data-hover", ""); });
  document.addEventListener("pointerout", function (e) { var el = target(e); if (el && !el.contains(e.relatedTarget)) { el.removeAttribute("data-hover"); el.removeAttribute("data-press"); } });
  document.addEventListener("pointerdown", function (e) { var el = target(e); if (el) el.setAttribute("data-press", ""); });
  document.addEventListener("pointerup", function (e) { var el = target(e); if (el) el.removeAttribute("data-press"); });
  document.addEventListener("focusin", function (e) { var el = target(e); if (el && keyboard) el.setAttribute("data-focus-visible", ""); });
  document.addEventListener("focusout", function (e) { var el = target(e); if (el) el.removeAttribute("data-focus-visible"); });
  document.addEventListener("click", function (e) {
    var el = target(e); if (!el) return;
    if (el.matches(".mt-check,.mt-switch")) { el.toggleAttribute("data-checked"); el.removeAttribute("data-indeterminate"); el.setAttribute("aria-checked", el.hasAttribute("data-checked")); }
    if (el.matches(".mt-choice")) { var c = el.querySelector(".mt-check,.mt-switch,.mt-radio"); if (c && c !== e.target.closest(".mt-check,.mt-switch,.mt-radio")) c.click(); }
    if (el.matches(".mt-radio")) { var g = el.closest("[role=radiogroup]"); if (g) g.querySelectorAll(".mt-radio").forEach(function (r) { r.removeAttribute("data-checked"); r.setAttribute("aria-checked", "false"); }); el.setAttribute("data-checked", ""); el.setAttribute("aria-checked", "true"); }
    if (el.matches(".mt-tab,.mt-seg-item")) { var p = el.parentElement, a = el.matches(".mt-tab") ? "data-active" : "data-selected"; Array.prototype.forEach.call(p.children, function (s) { s.removeAttribute(a); }); el.setAttribute(a, ""); }
  });
  /* Chart tooltips: any element with data-tip="value|label|..." (first line bold). Text only, never HTML. */
  var tip = null;
  function showTip(el, x, y) {
    if (!tip) { tip = document.createElement("div"); tip.className = "mt-tip"; tip.setAttribute("role", "tooltip"); document.body.appendChild(tip); }
    tip.textContent = "";
    el.getAttribute("data-tip").split("|").forEach(function (line, i) { var n = document.createElement(i === 0 ? "b" : "span"); n.textContent = line; tip.appendChild(n); });
    tip.style.display = "flex";
    var r = tip.getBoundingClientRect(), vw = window.innerWidth;
    tip.style.left = Math.min(vw - r.width - 8, x + 12) + "px"; tip.style.top = Math.max(8, y - r.height - 12) + "px";
  }
  function hideTip() { if (tip) tip.style.display = "none"; }
  document.addEventListener("pointermove", function (e) {
    var el = e.target.closest && e.target.closest("[data-tip]");
    document.querySelectorAll("[data-tip][data-hover]").forEach(function (h) { if (h !== el) h.removeAttribute("data-hover"); });
    if (el) { el.setAttribute("data-hover", ""); showTip(el, e.clientX, e.clientY); } else hideTip();
  });
  document.addEventListener("focusin", function (e) { var el = e.target.closest && e.target.closest("[data-tip]"); if (el) { var r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } });
  document.addEventListener("focusout", hideTip);
  window.Materia = { version: "2.1.0", selector: SEL };
})();
