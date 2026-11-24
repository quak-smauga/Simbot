// OBSERVE — kod wykonywany W PRZEGLĄDARCE (page.evaluate). Trzymany jako string, nie funkcja TS:
// tsx/esbuild w dev dokleja do funkcji helper `__name`, którego strona nie zna → ReferenceError. String jest nietykalny.
// Czysty JS (bez typów). Wejście: { ATTR, maxElements, textChars, fullChars }. Wyjście: { url, title, elements[], text, hints[], fullText? }.
// text = to, co w WIDOKU (zmienia się po przewinięciu); fullText = cały innerText strony, tylko dla executora (sprawdzanie warunków), nie dla modelu.

export const OBSERVE_SRC = String.raw`function (a) {
  var ATTR = a.ATTR, maxElements = a.maxElements, textChars = a.textChars, fullChars = a.fullChars || 0;
  var vw = window.innerWidth, vh = window.innerHeight;
  var str = function (v) { return typeof v === "string" ? v : ""; };
  var clean = function (v) { return String(v || "").replace(/\s+/g, " ").trim(); };
  /** wyrenderowany (ma rozmiar, nie jest ukryty stylem) — NIE znaczy „w widoku”; od tego jest inView */
  var visible = function (el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return null;
    return r;
  };
  var inView = function (r) { return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
  var where = function (r) {
    var cx = (r.left + r.width / 2) / vw, cy = (r.top + r.height / 2) / vh;
    return (cy < 0.34 ? "góra" : cy > 0.66 ? "dół" : "środek") + ", " + (cx < 0.34 ? "lewo" : cx > 0.66 ? "prawo" : "środek");
  };
  var sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role="button"], [role="link"], [role="textbox"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="option"], [contenteditable="true"], [onclick], canvas, video, img[alt]';
  var MEDIA = { canvas: 1, video: 1, img: 1 };
  var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
  Array.prototype.forEach.call(document.querySelectorAll("[" + ATTR + "]"), function (e) { e.removeAttribute(ATTR); });
  var items = [], errors = [], id = 0, icons = 0;
  var describeEl = function (t) {
    var c = typeof t.className === "string" ? t.className.trim().split(/\s+/)[0] : "";
    return t.tagName.toLowerCase() + (t.id ? "#" + t.id : c ? "." + c : "");
  };
  /** Przycisk/link bez tekstu (sama ikona): nazwa z potomków (aria-label, title, alt, <title> w svg), z klasy (close, menu…) i położenie. */
  var iconName = function (el, r) {
    var inner = el.querySelector("[aria-label], [title], img[alt], svg title");
    var n = inner ? clean(str(inner.getAttribute("aria-label")) || str(inner.getAttribute("title")) || str(inner.getAttribute("alt")) || str(inner.textContent)).slice(0, 60) : "";
    if (!n) {
      var m = /(close|zamknij|dismiss|menu|hamburger|search|szukaj|next|prev|play|pause|share|like|cart|koszyk|login|user|filter|sort|expand|collapse|more|settings)/i.exec((typeof el.className === "string" ? el.className : "") + " " + (el.id || ""));
      if (m) n = m[1].toLowerCase();
    }
    return "(ikona" + (n ? ": " + n : "") + " — " + where(r) + ")";
  };
  // ZASŁONIĘCIE: co naprawdę dostanie klik w środek elementu. Warstwa (layer) = fixed/sticky/dialog nad stroną — tylko taka
  // może być nakładką do zamknięcia; zwykła treść leżąca na elemencie (np. kontener artykułu) to nie nakładka.
  var layers = [];
  var isLayerEl = function (p) {
    var pos = getComputedStyle(p).position;
    return pos === "fixed" || pos === "sticky" || p.tagName === "DIALOG" || p.getAttribute("role") === "dialog" || p.getAttribute("aria-modal") === "true";
  };
  var occluderOf = function (el, r) {
    var x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    var t = document.elementFromPoint(x, y);
    // <area> z mapy obrazka to część tego obrazka, a nie nakładka
    if (!t || t === el || el.contains(t) || t.contains(el) || t.tagName === "AREA") return null;
    // najwyższy przodek-warstwa, który NIE zawiera elementu (wspólny kontener aplikacji to nie nakładka)
    var top = null, root = t;
    for (var p = t; p && p !== document.body && !p.contains(el); p = p.parentElement) { root = p; if (isLayerEl(p)) top = p; }
    // zwykła treść na elemencie: opisujemy cały blok (div#article-box), a nie akapit, w który trafił punkt
    if (!top) return { el: root, layer: false };
    var L = null;
    for (var q = 0; q < layers.length; q++) if (layers[q].el === top) L = layers[q];
    if (!L) { L = { el: top, hit: 0, pts: 0, x0: 1, y0: 1, x1: 0, y1: 0 }; layers.push(L); }
    L.hit++;
    return { el: top, layer: true };
  };
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
      var tooltip = "";
      if (MEDIA[tag]) {
        if (tag === "img" && (r.width < 40 || r.height < 40)) continue;
        role = tag;
        // obrazek: nazwa = alt (to, co opisuje obrazek), a title osobno jako dymek — np. xkcd trzyma żart w title (tekst „alt” po najechaniu)
        if (tag === "img") name = (str(el.getAttribute("alt")) || str(el.getAttribute("aria-label"))).replace(/\s+/g, " ").trim().slice(0, 120);
        tooltip = str(el.getAttribute("title")).replace(/\s+/g, " ").trim().slice(0, 400);
        if (!name) name = tag + " " + Math.round(r.width) + "x" + Math.round(r.height) + (el.id ? " #" + el.id : "");
      }
      if (!name && role !== "textbox") {
        // sama ikona (X, hamburger, lupa): kiedyś wypadała z listy; teraz mała, widoczna ikona dostaje opisową nazwę
        if (!inView(r) || r.width < 10 || r.height < 10 || r.width > 96 || r.height > 96 || icons >= 12) continue;
        name = iconName(el, r);
        icons++;
      }
      id++;
      el.setAttribute(ATTR, String(id));
      var item = { id: id, role: role, name: name, inViewport: inView(r), top: r.top };
      if (item.inViewport) { var occ = occluderOf(el, r); if (occ) item.occluded = describeEl(occ.el); }
      if (tooltip && tooltip !== name) item.tooltip = tooltip;
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
  // najpierw to, w co da się kliknąć: widoczne i niezasłonięte
  var rank = function (e) { return e.inViewport ? (e.occluded ? 1 : 2) : 0; };
  items.sort(function (x, y) { return rank(y) - rank(x) || x.top - y.top; });
  var elements = items.slice(0, maxElements).map(function (e) { var c = Object.assign({}, e); delete c.top; return c; });

  // TEKST: to, co TERAZ w widoku (po przewinięciu — inny tekst), a nie pierwsze N znaków dokumentu.
  var TSEL = "h1, h2, h3, h4, p, li, td, th, dt, dd, blockquote, figcaption, pre, [role=alert], [role=status], [role=heading]";
  // węzeł z zagnieżdżonymi blokami (li > ul, td > p): tylko jego własny tekst, żeby nie dublować dzieci
  var ownText = function (te) {
    if (!te.querySelector(TSEL)) return String(te.innerText || te.textContent || "");
    var out = "";
    for (var c = te.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.nodeValue + " ";
      else if (c.nodeType === 1 && !c.matches(TSEL) && !c.querySelector(TSEL)) out += String(c.innerText || c.textContent || "") + " ";
    }
    return out;
  };
  var viewParts = [], viewLen = 0, below = [], above = 0, seen = {};
  var tnodes = document.querySelectorAll(TSEL);
  for (var j = 0; j < tnodes.length; j++) {
    var te = tnodes[j];
    try {
      var tr = visible(te);
      if (!tr) continue;
      var isH = /^H[1-4]$/.test(te.tagName) || te.getAttribute("role") === "heading";
      if (tr.bottom <= 0) { above++; continue; }
      if (tr.top >= vh) {
        if (isH && below.length < 12) { var ht = clean(ownText(te)).slice(0, 80); if (ht.length > 2) below.push(ht); }
        continue;
      }
      if (viewLen > textChars) continue;
      var t = clean(ownText(te));
      if (t.length <= 2 || seen[t]) continue;
      seen[t] = 1;
      var cap = isH ? 160 : 600;
      var line = (isH ? "# " : "") + (t.length > cap ? t.slice(0, cap) + "…" : t);
      viewParts.push(line);
      viewLen += line.length + 1;
    } catch (e) {}
  }
  // strona z samych div/span (częste w SPA): powyższe daje prawie nic → węzły tekstowe, które są w widoku
  if (viewLen < 150 && document.body) {
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), tn, walked = 0;
      while ((tn = walker.nextNode()) && walked < 4000 && viewLen <= textChars) {
        walked++;
        if (!tn.nodeValue || !/\S/.test(tn.nodeValue)) continue;
        var pe = tn.parentElement;
        if (!pe || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(pe.tagName)) continue;
        var pr = visible(pe);
        if (!pr || pr.bottom <= 0 || pr.top >= vh) continue;
        var tt = clean(tn.nodeValue);
        if (tt.length <= 2 || seen[tt]) continue;
        seen[tt] = 1;
        viewParts.push(tt.slice(0, 300));
        viewLen += Math.min(tt.length, 300) + 1;
      }
    } catch (e) {}
  }
  var sh = Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  var screens = Math.max(1, Math.ceil(sh / vh)), screen = Math.min(screens, Math.floor((window.scrollY || 0) / vh) + 1);
  var text = (screens > 1 ? "(widok: ekran " + screen + " z " + screens + (above ? " — wyżej jest treść, której tu nie widać" : "") + ")\n" : "") + viewParts.join("\n").slice(0, textChars) + (below.length ? "\nNIŻEJ NA STRONIE (nagłówki): " + below.join(" · ") : "");

  var hints = [];
  var bodyText = document.body ? String(document.body.innerText || "").slice(0, 4000) : "";
  if (document.querySelector('input[type="password"]')) hints.push("LOGIN_FORM_VISIBLE");
  // CAPTCHA: tylko WIDOCZNY widżet albo strona-bramka. Samo słowo „captcha” w HTML (skrypt reCAPTCHA v3, formularz newslettera) to nie captcha.
  var captcha = /nie jeste[śs] robotem|jeste[śs] człowiekiem|verify (that )?you are (a )?human|unusual traffic|checking your browser/i.test(bodyText) || /^just a moment/i.test(document.title || "");
  if (!captcha) {
    var cn = document.querySelectorAll('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], iframe[src*="captcha" i], iframe[title*="captcha" i], .g-recaptcha, .h-captcha, .cf-turnstile, [id*="captcha" i], [class*="captcha" i]');
    for (var ci = 0; ci < cn.length && !captcha; ci++) {
      try {
        var ce = cn[ci];
        // plakietka reCAPTCHA v3 / tryb invisible działa w tle — user nic nie musi klikać
        if (ce.closest(".grecaptcha-badge") || /size=invisible/.test(str(ce.getAttribute("src")))) continue;
        var cr = visible(ce);
        if (cr && cr.width >= 40 && cr.height >= 40 && inView(cr)) captcha = true;
      } catch (e) {}
    }
  }
  if (captcha) hints.push("CAPTCHA_SUSPECTED");
  if (/cookie|ciasteczk|rodo|gdpr/i.test(bodyText) && document.querySelector('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]')) hints.push("COOKIE_BANNER");
  if (sh > vh * 1.5) hints.push("PAGE_SCROLLABLE");
  if (items.length > maxElements) hints.push("ELEMENTS_TRUNCATED: lista ma " + maxElements + " z " + items.length + " elementów (najpierw widoczne) — pozostałe zobaczysz po przewinięciu");
  // OVERLAY / STICKY_BANNER: ile ekranu warstwa NAPRAWDĘ przechwytuje — próbkowanie siatką punktów (elementFromPoint),
  // a nie prostokąt kontenera: przezroczysty kontener fixed na cały ekran z paskiem reklamy na dole to pasek, nie „99% ekranu”.
  if (layers.length) {
    var GX = 12, GY = 9;
    for (var gx = 0; gx < GX; gx++) for (var gy = 0; gy < GY; gy++) {
      var pt = document.elementFromPoint((gx + 0.5) / GX * vw, (gy + 0.5) / GY * vh);
      if (!pt) continue;
      for (var li = 0; li < layers.length; li++) {
        var Ly = layers[li];
        if (Ly.el !== pt && !Ly.el.contains(pt)) continue;
        Ly.pts++;
        Ly.x0 = Math.min(Ly.x0, gx / GX); Ly.y0 = Math.min(Ly.y0, gy / GY);
        Ly.x1 = Math.max(Ly.x1, (gx + 1) / GX); Ly.y1 = Math.max(Ly.y1, (gy + 1) / GY);
        break;
      }
    }
    // okno modalne to zwykle kilka warstw naraz (tło + okienko): liczymy je razem. Razem ≥ 40% ekranu albo któraś jest dialogiem
    // → jedna nakładka do zamknięcia; inaczej każda z osobna to pasek na brzegu, którego zamykać nie trzeba.
    var rd = function (v) { return Math.round(v * 100) / 100; };
    var boxOf = function (L) { return "box=[" + [rd(L.x0), rd(L.y0), rd(L.x1 - L.x0), rd(L.y1 - L.y0)].join(",") + "]"; };
    var frameOf = function (L) { return L.el.tagName === "IFRAME" || L.el.querySelector("iframe") ? " (iframe — reklama?)" : ""; };
    var isDialog = function (L) { return L.el.tagName === "DIALOG" || L.el.getAttribute("role") === "dialog" || L.el.getAttribute("aria-modal") === "true"; };
    var live = layers.filter(function (L) { return L.pts > 0; });
    var sum = { pts: 0, hit: 0, x0: 1, y0: 1, x1: 0, y1: 0 }, big = null, dialog = false;
    for (var k = 0; k < live.length; k++) {
      var Lk = live[k];
      sum.pts += Lk.pts; sum.hit += Lk.hit;
      sum.x0 = Math.min(sum.x0, Lk.x0); sum.y0 = Math.min(sum.y0, Lk.y0); sum.x1 = Math.max(sum.x1, Lk.x1); sum.y1 = Math.max(sum.y1, Lk.y1);
      if (!big || Lk.pts > big.pts) big = Lk;
      if (isDialog(Lk)) dialog = true;
    }
    if (big && (sum.pts / (GX * GY) >= 0.4 || dialog)) {
      hints.push("OVERLAY: " + describeEl(big.el) + frameOf(big) + (live.length > 1 ? " (+" + (live.length - 1) + " warstwa tej samej nakładki)" : "") + " zasłania " + Math.round(sum.pts / (GX * GY) * 100) + "% ekranu i " + sum.hit + " elementów, " + boxOf(sum) + " — zamknij ją, zanim klikniesz coś pod spodem");
    } else {
      for (var k2 = 0; k2 < live.length; k2++) {
        var Lb = live[k2], cover = Lb.pts / (GX * GY);
        if (cover >= 0.03) hints.push("STICKY_BANNER: " + describeEl(Lb.el) + frameOf(Lb) + " to pasek na " + Math.round(cover * 100) + "% ekranu, " + boxOf(Lb) + " — reszta strony jest dostępna, NIE trzeba go zamykać (" + Lb.hit + " elementów pod nim odsłonisz przewinięciem)");
      }
    }
  }
  if (errors.length) hints.push("ELEMENT_ERRORS: " + errors.length + " (" + errors[0].slice(0, 80) + ")");
  var out = { url: location.href, title: document.title, elements: elements, text: text, hints: hints };
  if (fullChars && document.body) out.fullText = String(document.body.innerText || "").slice(0, fullChars);
  return out;
}`;

/** click_at: co leży w klikanym punkcie (przed kliknięciem) — decydent dowiaduje się, w co trafił, zamiast strzelać na ślepo. Wejście: { x, y } w px. */
export const HIT_SRC = String.raw`function (p) {
  var t = document.elementFromPoint(p.x, p.y);
  if (!t) return "nic (punkt poza stroną)";
  var d = function (e) {
    var c = typeof e.className === "string" ? e.className.trim().split(/\s+/)[0] : "";
    return e.tagName.toLowerCase() + (e.id ? "#" + e.id : c ? "." + c : "");
  };
  if (t.tagName === "IFRAME") return d(t) + " — ramka (iframe): jej wnętrza nie ma na liście elementów";
  if (t.tagName === "CANVAS" || t.tagName === "VIDEO") return d(t);
  var c = t.closest('a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]');
  var e = c || t;
  var txt = String(e.innerText || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40);
  var q = txt ? " „" + txt + "”" : "";
  if (c) return d(c) + q + (c.getAttribute(p.ATTR) ? " = [" + c.getAttribute(p.ATTR) + "] z listy" : "");
  return d(t) + q + (getComputedStyle(t).cursor === "pointer" ? " (klikalne)" : " — NIC KLIKALNEGO w tym punkcie");
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
