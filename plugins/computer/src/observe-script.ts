// OBSERVE — kod wykonywany W PRZEGLĄDARCE (page.evaluate). Trzymany jako string, nie funkcja TS:
// tsx/esbuild w dev dokleja do funkcji helper `__name`, którego strona nie zna → ReferenceError. String jest nietykalny.
// Czysty JS (bez typów). Wejście: { ATTR, maxElements, textChars }. Wyjście: { url, title, elements[], text, hints[] }.

export const OBSERVE_SRC = String.raw`function (a) {
  var ATTR = a.ATTR, maxElements = a.maxElements, textChars = a.textChars;
  var vw = window.innerWidth, vh = window.innerHeight;
  var str = function (v) { return typeof v === "string" ? v : ""; };
  var visible = function (el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return null;
    return r;
  };
  var sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role="button"], [role="link"], [role="textbox"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="option"], [contenteditable="true"], [onclick], canvas, video, img[alt]';
  var MEDIA = { canvas: 1, video: 1, img: 1 };
  var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
  Array.prototype.forEach.call(document.querySelectorAll("[" + ATTR + "]"), function (e) { e.removeAttribute(ATTR); });
  var items = [], errors = [], id = 0;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    try {
      var r = visible(el);
      if (!r) continue;
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute("type") || "").toLowerCase();
      var role = el.getAttribute("role") || tag;
      if (tag === "a") role = "link";
      else if (tag === "input") role = ["checkbox", "radio", "submit", "button", "file"].indexOf(type) !== -1 ? type : "textbox";
      else if (tag === "textarea" || el.getAttribute("contenteditable") === "true") role = "textbox";
      else if (tag === "select") role = "select";
      else if (tag === "summary") role = "button";
      var name = (str(el.getAttribute("aria-label")) || str(el.innerText) || str(el.textContent) || str(el.getAttribute("placeholder")) || str(el.getAttribute("title")) || str(el.getAttribute("alt")) || str(el.labels && el.labels[0] && el.labels[0].innerText) || str(el.value) || str(el.getAttribute("name")) || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (MEDIA[tag]) {
        if (tag === "img" && (r.width < 40 || r.height < 40)) continue;
        role = tag;
        if (!name) name = tag + " " + Math.round(r.width) + "x" + Math.round(r.height) + (el.id ? " #" + el.id : "");
      }
      if (!name && role !== "textbox") continue;
      id++;
      el.setAttribute(ATTR, String(id));
      var item = { id: id, role: role, name: name, inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw, top: r.top };
      if (MEDIA[tag]) item.box = [r.left / vw, r.top / vh, r.width / vw, r.height / vh].map(function (v) { return Math.round(v * 100) / 100; });
      if (tag === "a") {
        // <a> w SVG ma .href jako SVGAnimatedString — bierzemy atrybut i rozwiązujemy względem strony
        var raw = str(el.getAttribute("href"));
        if (raw && raw.indexOf("javascript:") !== 0) {
          var h = raw;
          try { h = new URL(raw, location.href).href; } catch (e) {}
          item.href = h.length > 100 ? h.slice(0, 97) + "…" : h;
        }
      }
      if (role === "textbox" && el.value) item.value = String(el.value).slice(0, 60);
      if (type === "password") item.role = "password";
      items.push(item);
    } catch (e) { errors.push(String(e && e.message || e)); }
  }
  items.sort(function (x, y) { return Number(y.inViewport) - Number(x.inViewport) || x.top - y.top; });
  var elements = items.slice(0, maxElements).map(function (e) { var c = Object.assign({}, e); delete c.top; return c; });
  var textParts = [];
  var tnodes = document.querySelectorAll("h1, h2, h3, p, li, td, th, [role=alert], [role=status]");
  for (var j = 0; j < tnodes.length; j++) {
    var te = tnodes[j];
    try {
      if (!visible(te)) continue;
      var t = String(te.innerText || te.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 2) textParts.push((/^H[1-3]$/.test(te.tagName) ? "# " : "") + t.slice(0, 220));
      if (textParts.join("\n").length > textChars) break;
    } catch (e) {}
  }
  var hints = [];
  var bodyHtml = document.body ? document.body.innerHTML.slice(0, 200000) : "";
  var bodyText = document.body ? String(document.body.innerText || "").slice(0, 4000) : "";
  if (document.querySelector('input[type="password"]')) hints.push("LOGIN_FORM_VISIBLE");
  if (/captcha|recaptcha|hcaptcha/i.test(bodyHtml)) hints.push("CAPTCHA_SUSPECTED");
  if (/cookie|ciasteczk|rodo|gdpr/i.test(bodyText) && document.querySelector('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]')) hints.push("COOKIE_BANNER");
  if (document.body && document.body.scrollHeight > vh * 1.5) hints.push("PAGE_SCROLLABLE");
  if (errors.length) hints.push("ELEMENT_ERRORS: " + errors.length + " (" + errors[0].slice(0, 80) + ")");
  return { url: location.href, title: document.title, elements: elements, text: textParts.join("\n").slice(0, textChars), hints: hints };
}`;

/** Awaryjna, najprostsza obserwacja (gdy pełna padnie): linki/przyciski po textContent. Wejście: ATTR. */
export const OBSERVE_BASIC_SRC = String.raw`function (ATTR) {
  Array.prototype.forEach.call(document.querySelectorAll("[" + ATTR + "]"), function (e) { e.removeAttribute(ATTR); });
  var out = [], id = 0;
  var nodes = document.querySelectorAll("a[href], button, input, textarea, select");
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var name = String(el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) continue;
    id++;
    el.setAttribute(ATTR, String(id));
    var raw = el.getAttribute("href");
    out.push({ id: id, role: el.tagName.toLowerCase() === "a" ? "link" : el.tagName.toLowerCase(), name: name, href: typeof raw === "string" ? raw : undefined, inViewport: true });
    if (id >= 60) break;
  }
  return { url: location.href, title: document.title, elements: out, text: String(document.body && document.body.innerText || "").slice(0, 1200) };
}`;
