// BROWSERTEST — obserwacja i akcje na PRAWDZIWYM Chromium (Playwright, headless) i lokalnych stronach-atrapach, bez sieci i bez API.
// Selftest executora używa atrapy przeglądarki, więc nie widzi błędów w skrypcie obserwacji (observe-script.ts) ani w czekaniu po kliku.
// Scenariusze pochodzą z prawdziwych wpadek (design/computer-flow-review.md): przezroczysty kontener reklamy zgłaszany jako „OVERLAY 99%”,
// tekst strony, który nie zmieniał się po przewinięciu, CAPTCHA_SUSPECTED od samego słowa w HTML, klik w link SPA z opóźnioną zmianą adresu.
// Uruchom: pnpm --filter @qwe/plugin-computer test:browser   (wymaga Chromium: playwright install chromium)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserRuntime, describeObservation } from "./browser.js";

const links = (n: number, prefix = "Link") => Array.from({ length: n }, (_, i) => `<p><a href="/p/${i + 1}">${prefix} ${i + 1}</a></p>`).join("");
const page = (title: string, body: string, style = "") => `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:16px/1.5 sans-serif}${style}</style></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  // pełnoekranowa reklama nad stroną (jak OLX na joemonster.org przed zamknięciem)
  "/fullad": page("Reklama na cały ekran", `${links(12)}<div id="ad" style="position:fixed;inset:0;background:#cff;z-index:9"><a href="#" id="x" style="position:absolute;top:10px;right:20px" onclick="document.getElementById('ad').remove();return false">Zamknij x</a><iframe srcdoc="<h1>OLX</h1>" style="width:100%;height:100%;border:0"></iframe></div>`),
  // ta sama reklama PO zamknięciu: kontener fixed dalej na cały ekran (przezroczysty, nie łapie kliknięć), widoczny tylko pasek na dole
  "/banner": page("Pasek na dole", `${links(20)}<div id="adwrap" style="position:fixed;inset:0;pointer-events:none;z-index:9"><div id="bar" style="position:absolute;left:0;right:0;bottom:0;height:140px;background:#036;pointer-events:auto"><iframe srcdoc="<b>sodastream</b>" style="width:100%;height:100%;border:0"></iframe></div></div>`),
  // okno zgód: półprzezroczyste tło fixed + osobne okienko role=dialog (dwie warstwy jednej nakładki, jak sd-cmp na joemonster.org)
  "/modal": page("Zgody", `${links(20)}<div class="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:8"></div><div id="dialog" role="dialog" style="position:fixed;left:25%;top:22%;width:50%;height:56%;background:#fff;z-index:9"><p>Szanujemy Twoją prywatność</p><button id="ok" onclick="this.parentElement.remove();document.querySelector('.backdrop').remove()">Zaakceptuj wszystkie</button></div>`, "p{text-align:center}"),
  // zwykła treść leżąca na linku (kontener artykułu) — zasłania element, ale to nie nakładka do zamknięcia
  "/content": page("Treść na linku", `<p><a href="/p/1" id="under">Schowany link</a></p><div id="article-box" style="position:absolute;top:0;left:0;width:600px;height:9000px;background:#eee"><p>Artykuł</p></div>`),
  // długi artykuł: tekst ma iść za widokiem; 100 linków → lista ucięta
  "/long": page("Długi artykuł", `<h1>Tytuł artykułu</h1>${Array.from({ length: 60 }, (_, i) => `${i % 10 === 0 ? `<h2>Rozdział ${i / 10 + 1}</h2>` : ""}<p style="height:90px">Akapit numer ${i + 1} z treścią artykułu.</p>`).join("")}<p id="last">Ostatnie zdanie artykułu: KONIEC.</p>${links(100)}`),
  // słowo „captcha” w HTML, ale nic do kliknięcia: skrypt, ukryty widżet, plakietka v3
  "/captcha-false": page("Bez captchy", `<h1>Newsletter</h1><p>Zapisz się.</p><script>/* recaptcha hcaptcha captcha */</script><div class="g-recaptcha" style="display:none"></div><div class="grecaptcha-badge" style="position:fixed;right:0;bottom:0;width:256px;height:60px"><iframe title="reCAPTCHA" src="about:blank#recaptcha" style="width:256px;height:60px"></iframe></div>`),
  "/captcha-true": page("Z captchą", `<h1>Sprawdzamy</h1><iframe title="reCAPTCHA" srcdoc="<p>Nie jestem robotem</p>" style="width:304px;height:78px"></iframe>`),
  // SPA: klik w link zmienia adres dopiero po 900 ms (jak leafly.com → /strains)
  "/spa": page("SPA start", `<h1 id="h">Start</h1><p><a href="/spa/next" id="go">see all strains</a></p><script>document.getElementById("go").addEventListener("click", function (e) { e.preventDefault(); setTimeout(function () { history.pushState({}, "", "/spa/next"); document.title = "SPA dalej"; document.getElementById("h").textContent = "Dalej"; }, 900); });</script>`),
  // przycisk z samą ikoną + pusty obszar do click_at
  "/icon": page("Ikona", `<h1>Strona z ikoną</h1><button class="close-btn" style="position:fixed;top:8px;right:8px;width:32px;height:32px"><svg width="16" height="16"><path d="M0 0L16 16"/></svg></button><div class="wrap" style="height:600px"></div>`),
  // strona z samych div/span
  "/divs": page("Same divy", `<div><span>Pierwsza linia treści w divie.</span></div><div><span>Druga linia treści w divie.</span></div>`),
};

const server = createServer((req, res) => {
  const body = PAGES[(req.url ?? "/").split("?")[0]] ?? PAGES["/long"];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const dataDir = mkdtempSync(join(tmpdir(), "qwe-browsertest-"));
const browser = new BrowserRuntime({ dataDir, headless: true, log: () => {} });

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};
const hint = (hints: string[], name: string) => hints.find((h) => h.startsWith(name));
const pct = (h: string | undefined) => Number(/(\d+)% ekranu/.exec(h ?? "")?.[1] ?? -1);

console.log("computer browser (Chromium):");
try {
  await test("pełnoekranowa reklama → OVERLAY ~100%, linki pod spodem zasłonięte; po zamknięciu hint znika", async () => {
    await browser.navigate(`${base}/fullad`);
    let o = await browser.observe();
    assert.ok(pct(hint(o.hints, "OVERLAY")) >= 90, o.hints.join(" | "));
    assert.ok(!hint(o.hints, "STICKY_BANNER"));
    assert.ok(o.elements.filter((e) => e.occluded === "div#ad").length >= 5);
    const x = o.elements.find((e) => e.name === "Zamknij x");
    assert.ok(x && !x.occluded, "przycisk zamknięcia jest na liście i nie jest zasłonięty");
    await browser.click(x.id);
    o = await browser.observe();
    assert.ok(!hint(o.hints, "OVERLAY") && !o.elements.some((e) => e.occluded), o.hints.join(" | "));
  });

  await test("joemonster po zamknięciu reklamy: przezroczysty kontener fixed 100% + pasek na dole → STICKY_BANNER ~17%, NIE „OVERLAY 99%”", async () => {
    await browser.navigate(`${base}/banner`);
    const o = await browser.observe();
    assert.ok(!hint(o.hints, "OVERLAY"), o.hints.join(" | "));
    const b = hint(o.hints, "STICKY_BANNER");
    assert.ok(b, o.hints.join(" | "));
    const m = /pasek na (\d+)% ekranu, box=\[([\d.,-]+)\]/.exec(b);
    assert.ok(m && Number(m[1]) >= 10 && Number(m[1]) <= 25, b);
    const [, y, , h] = m[2].split(",").map(Number);
    assert.ok(y >= 0.7 && h <= 0.3, `ramka paska ma być na dole ekranu: ${m[2]}`);
    assert.match(b, /NIE trzeba go zamykać/);
    assert.ok(o.elements.some((e) => !e.occluded && e.role === "link"), "linki nad paskiem są klikalne");
  });

  await test("okno zgód z dwóch warstw (tło + okienko dialogu) → JEDEN hint OVERLAY ~100%, okienko nie jest „paskiem, którego nie trzeba zamykać”", async () => {
    await browser.navigate(`${base}/modal`);
    let o = await browser.observe();
    const ov = o.hints.filter((h) => h.startsWith("OVERLAY"));
    assert.equal(ov.length, 1, o.hints.join(" | "));
    assert.ok(pct(ov[0]) >= 90 && /\(\+1 warstwa tej samej nakładki\)/.test(ov[0]), ov[0]);
    assert.ok(!hint(o.hints, "STICKY_BANNER"), o.hints.join(" | "));
    const ok = o.elements.find((e) => e.name === "Zaakceptuj wszystkie");
    assert.ok(ok && !ok.occluded);
    await browser.click(ok.id);
    o = await browser.observe();
    assert.ok(!hint(o.hints, "OVERLAY") && !o.elements.some((e) => e.occluded), o.hints.join(" | "));
  });

  await test("zwykła treść leżąca na elemencie (kontener artykułu) → element „zasłonięty”, ale bez hintu OVERLAY", async () => {
    await browser.navigate(`${base}/content`);
    const o = await browser.observe();
    assert.equal(o.elements.find((e) => e.name === "Schowany link")?.occluded, "div#article-box");
    assert.ok(!hint(o.hints, "OVERLAY") && !hint(o.hints, "STICKY_BANNER"), o.hints.join(" | "));
  });

  await test("tekst idzie za widokiem: po przewinięciu inne akapity, nagłówki spod widoku jako spis; pełny tekst osobno; lista elementów z ELEMENTS_TRUNCATED", async () => {
    await browser.navigate(`${base}/long`);
    const top = await browser.observe();
    assert.match(top.text, /^\(widok: ekran 1 z \d+\)\n# Tytuł artykułu\n# Rozdział 1\nAkapit numer 1 z treścią/);
    assert.match(top.text, /NIŻEJ NA STRONIE \(nagłówki\): Rozdział 2 · Rozdział 3/);
    assert.ok(!top.text.includes("Akapit numer 30 "), "akapity spoza widoku nie są w tekście dla modelu");
    assert.ok(top.fullText?.includes("Ostatnie zdanie artykułu: KONIEC."), "pełny tekst strony jest dla executora");
    assert.ok(!describeObservation(top).includes("KONIEC"), "pełny tekst nie idzie do modelu");
    await browser.scroll("down", 2700);
    const mid = await browser.observe();
    assert.match(mid.text, /^\(widok: ekran [3-5] z \d+ — wyżej jest treść, której tu nie widać\)/);
    assert.ok(/Akapit numer (2[6-9]|3\d) /.test(mid.text) && !mid.text.includes("Akapit numer 1 "), mid.text.slice(0, 300));
    assert.notEqual(mid.text.slice(0, 400), top.text.slice(0, 400), "executor widzi zmianę po przewinięciu (sygnatura strony)");
    assert.match(hint(mid.hints, "ELEMENTS_TRUNCATED") ?? "", /lista ma 70 z 100 elementów/);
  });

  await test("CAPTCHA_SUSPECTED: samo słowo w HTML, ukryty widżet i plakietka v3 → brak; widoczny widżet → jest", async () => {
    await browser.navigate(`${base}/captcha-false`);
    assert.ok(!(await browser.observe()).hints.includes("CAPTCHA_SUSPECTED"));
    await browser.navigate(`${base}/captcha-true`);
    assert.ok((await browser.observe()).hints.includes("CAPTCHA_SUSPECTED"));
  });

  await test("SPA: klik w link, który zmienia adres po 900 ms → click czeka, obserwacja pokazuje już nową stronę", async () => {
    await browser.navigate(`${base}/spa`);
    const o = await browser.observe();
    const go = o.elements.find((e) => e.name === "see all strains");
    assert.ok(go);
    await browser.click(go.id);
    const after = await browser.observe();
    assert.equal(after.url, `${base}/spa/next`);
    assert.match(after.text, /# Dalej/);
  });

  await test("przycisk z samą ikoną trafia na listę z opisową nazwą; click_at mówi, w co trafił", async () => {
    await browser.navigate(`${base}/icon`);
    const o = await browser.observe();
    const icon = o.elements.find((e) => e.role === "button");
    assert.equal(icon?.name, "(ikona: close — góra, prawo)");
    assert.match((await browser.clickAt(0.5, 0.6)).hit ?? "", /^div\.wrap — NIC KLIKALNEGO w tym punkcie$/);
    assert.equal((await browser.clickAt(0.985, 0.03)).hit, `button.close-btn = [${icon.id}] z listy`);
  });

  await test("strona z samych div/span → tekst z węzłów tekstowych w widoku (kiedyś pusty)", async () => {
    await browser.navigate(`${base}/divs`);
    const o = await browser.observe();
    assert.match(o.text, /Pierwsza linia treści w divie\.\nDruga linia treści w divie\./);
  });

  console.log(`computer browser: ${passed} testów OK`);
} finally {
  await browser.close();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
