// pnpm --filter @qwe/core test — bez API: parser, plan executor, json, command router.
import assert from "node:assert/strict";
import { ToolStreamParser, parseNativeBlock, withClosedTag } from "./nativeapi.js";
import { executePlan, validatePlan } from "./plan.js";
import { extractJson } from "./llm.js";
import { matchVoiceCommand, containsPhrase } from "./text.js";
import { parseMentions, resolveTargets, userSlug, voiceAddress } from "./mentions.js";

let n = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  console.log(`  ✓ ${name}`);
  n++;
};

await test("stream parser: tekst przed tagiem leci na bieżąco, blok po", () => {
  const out: string[] = [];
  const p = new ToolStreamParser((d) => out.push(d));
  for (const d of ["Spoko, ", "sprawdzę. <", "nativeapi><web.query>bilet", " ZTM</web.query></nativeapi>"]) p.push(d);
  const b = p.finish();
  assert.equal(out.join(""), "Spoko, sprawdzę. ");
  assert.deepEqual(b, { kind: "direct", calls: [{ name: "web.query", args: { _: "bilet ZTM" } }] });
});

await test("stream parser: '<' w zwykłym tekście nie blokuje", () => {
  const out: string[] = [];
  const p = new ToolStreamParser((d) => out.push(d));
  p.push("a < b, ");
  p.push("czyli mniej.");
  assert.equal(p.finish(), null);
  assert.equal(out.join(""), "a < b, czyli mniej.");
});

await test("plan: tag = nazwa toola, id/after, '*' = wszystko wcześniej", () => {
  const b = parseNativeBlock(`<plan>
    <web.query id="s1">playwright docs</web.query>
    <web.query id="s2">playwright github</web.query>
    <computer.run id="c1" after="s1 s2">Otwórz dokumentację.</computer.run>
    <web.query after="*">x</web.query>
  </plan></nativeapi>`);
  assert.equal(b?.kind, "plan");
  if (b?.kind !== "plan") return;
  assert.equal(b.steps.length, 4);
  assert.deepEqual(b.steps[2].after, ["s1", "s2"]);
  assert.deepEqual(b.steps[3].after, ["s1", "s2", "c1"]);
  assert.equal(validatePlan(b.steps), null);
});

await test("plan: niedomknięty tag → bierze do końca", () => {
  const b = parseNativeBlock("<computer.run>Otwórz quak.com.pl i sprawdź podstrony");
  assert.equal(b?.kind, "direct");
  if (b?.kind === "direct") assert.match(b.calls[0].args._, /quak\.com\.pl/);
});

await test("withClosedTag domyka blok urwany stop_sequence", () => {
  assert.match(withClosedTag("x <nativeapi><web.query>q</web.query>"), /<\/nativeapi>$/);
});

await test("executor: niezależne kroki równolegle, zależny czeka, wynik dostępny", async () => {
  const b = parseNativeBlock(`<plan><a id="1">a</a><a id="2">b</a><b id="3" after="1 2">c</b></plan>`);
  if (b?.kind !== "plan") throw new Error("plan");
  const order: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const res = await executePlan({
    steps: b.steps,
    signal: new AbortController().signal,
    emit: () => {},
    async run(step, prior) {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      order.push(step.id);
      if (step.id === "3") assert.deepEqual(Object.keys(prior).sort(), ["1", "2"]);
      return { ok: true, text: `ok ${step.id}` };
    },
  });
  assert.equal(maxConcurrent, 2);
  assert.equal(order[2], "3");
  assert.ok(res.every((r) => r.status === "completed"));
});

await test("executor: fail zależności → skipped, plan.failed", async () => {
  const b = parseNativeBlock(`<plan><a id="1">a</a><b id="2" after="1">b</b></plan>`);
  if (b?.kind !== "plan") throw new Error("plan");
  const types: string[] = [];
  const res = await executePlan({
    steps: b.steps,
    signal: new AbortController().signal,
    emit: (t) => types.push(t),
    run: async () => ({ ok: false, text: "nope" }),
  });
  assert.equal(res[1].status, "skipped");
  assert.ok(types.includes("plan.failed"));
});

await test("extractJson: wyciąga obiekt z gadania modelu", () => {
  assert.deepEqual(extractJson('Jasne:\n```json\n{"action":"click","target":3,"why":"bo \\"tak\\""}\n``` dzięki'), { action: "click", target: 3, why: 'bo "tak"' });
});

await test("command router: frazy sterujące z tolerancją STT, zwykłe zdanie → null", () => {
  assert.equal(matchVoiceCommand("ej zatrzymaj komputer na chwilę"), "pause");
  assert.equal(matchVoiceCommand("ok zalogowałem się"), "resume");
  assert.equal(matchVoiceCommand("przejmuje kontrole"), "take_control");
  assert.equal(matchVoiceCommand("anuluj to zadanie"), "cancel");
  assert.equal(matchVoiceCommand("ile kosztuje bilet"), null);
  assert.equal(matchVoiceCommand("start"), null);
  assert.equal(matchVoiceCommand("no stop stop"), null);
  assert.ok(containsPhrase("pa simlokatorzy", "pa simlokatorzy"));
});

await test("mentions: @sim, @sim.task, @user, nieznany, spoza rozmowy, bez @ → prowadzący", () => {
  const ms = parseMentions("@ksiegowy.task wystaw fakturę, @audytor patrz, mail@x.pl to nie mention, @Kacper?");
  assert.deepEqual(ms.map((m) => [m.name, m.action]), [["ksiegowy", "task"], ["audytor", "ask"], ["kacper", "ask"]]);
  const o = { members: ["ksiegowy"], known: ["ksiegowy", "audytor", "simson"], user: "kacper" };
  const t = resolveTargets("@ksiegowy.task wystaw, @audytor sprawdź, @nikt hej, @kacper", o);
  // @audytor jest znany, ale nie ma go w rozmowie → nie odpowiada (tylko `absent`)
  assert.deepEqual(t.bots, [{ name: "ksiegowy", action: "task", joined: false }]);
  assert.deepEqual(t.absent, ["audytor"]);
  assert.equal(t.userMentioned, true);
  assert.deepEqual(t.unknown, ["nikt"]);
  // user woła tylko kogoś spoza rozmowy → odpowiada prowadzący, a wołany jest w `absent`
  const only = resolveTargets("@audytor zerknij", o);
  assert.deepEqual(only.bots, [{ name: "ksiegowy", action: "ask", joined: false }]);
  assert.deepEqual(only.absent, ["audytor"]);
  assert.deepEqual(resolveTargets("cześć", o).bots, [{ name: "ksiegowy", action: "ask", joined: false }]);
  // adopt (wiadomość usera w chat serverze): wołany spoza rozmowy dołącza i odpowiada sam, bez prowadzącego
  const adopted = resolveTargets("@audytor.task zerknij", { ...o, adopt: true });
  assert.deepEqual(adopted.bots, [{ name: "audytor", action: "task", joined: true }]);
  assert.deepEqual(adopted.absent, []);
  // …ale sim nie wciąga nikogo spoza rozmowy, nawet z adopt
  assert.deepEqual(resolveTargets("@audytor zerknij", { ...o, adopt: true, from: "ksiegowy" }).absent, ["audytor"]);
  // sim pisze: bez @ nikt nie odpowiada, sam siebie nie woła
  assert.deepEqual(resolveTargets("robię @ksiegowy @simson", { ...o, from: "ksiegowy" }).bots, []);
  assert.deepEqual(resolveTargets("Robię. @simson sprawdź", { ...o, members: ["ksiegowy", "simson"], from: "ksiegowy" }).bots, [{ name: "simson", action: "ask", joined: false }]);
  assert.deepEqual(parseMentions("@audytor: sprawdziłem. @kacper potwierdzasz?").map((m) => m.name), ["kacper"]);
  // omawianie funkcji nie woła: `@sim` w kodzie, blok ```, cytat >
  const talk = "Chip `Odpowiada: @ksiegowy` nad polem.\n```\n@audytor sprawdź\n```\n> @simson pisał wcześniej\nA wołam @ksiegowy.task wprost";
  assert.deepEqual(parseMentions(talk).map((m) => [m.name, m.action]), [["ksiegowy", "task"]]);
  assert.equal(talk.slice(parseMentions(talk)[0].index, parseMentions(talk)[0].index + 9), "@ksiegowy");
  assert.deepEqual(resolveTargets("dyskusja o `@audytor` i tyle", { ...o, from: "ksiegowy" }).bots, []);
  assert.equal(resolveTargets("cześć", o).defaulted, true);
  assert.equal(resolveTargets("@ksiegowy cześć", o).defaulted, false);
  // cudzysłów to też omawianie: „@sima → @ksiegowy” (tak księgowy niechcący zawołał Simę)
  assert.deepEqual(parseMentions("linia „@sima → @ksiegowy” w wątku, \"@audytor\" też nie, a @simson tak").map((m) => m.name), ["simson"]);
  // spacja po wzmiance (Enter w autocomplete) nie zmienia wyniku
  assert.deepEqual(resolveTargets("@ksiegowy ", o).bots, resolveTargets("@ksiegowy", o).bots);
  // dwa @ w jednej wiadomości: odpowiadają po kolei, prowadzić będzie pierwszy (session.setLead(bots[0]))
  const two = { ...o, members: ["ksiegowy", "simson"] };
  assert.deepEqual(resolveTargets("@simson test 1 @ksiegowy test 2", two).bots.map((b) => b.name), ["simson", "ksiegowy"]);
  // sim: @ w środku zdania to wzmianka, woła tylko @ na początku zdania/linii/punktu
  const room = { ...o, members: ["ksiegowy", "sima"], known: [...o.known, "sima"], from: "ksiegowy" };
  assert.deepEqual(resolveTargets("Ostatnią wiadomość napisał @sima i nikogo nie zawołał.", room).bots, []);
  assert.deepEqual(resolveTargets("Gotowe. @sima, sprawdź sumy.", room).bots.map((b) => b.name), ["sima"]);
  assert.deepEqual(resolveTargets("Plan:\n- @sima poszukaj kursu", room).bots.map((b) => b.name), ["sima"]);
  assert.deepEqual(resolveTargets("Jasne, przekazuję pałeczkę. **@sima** zamknij", room).bots.map((b) => b.name), ["sima"]);
  // user woła z dowolnego miejsca zdania
  assert.deepEqual(resolveTargets("a teraz niech @ksiegowy policzy", o).bots.map((b) => b.name), ["ksiegowy"]);
  // głos: nazwa sima na początku transkrypcji (też wołacz i „hej”)
  assert.equal(voiceAddress("Księgowy, policz VAT", ["sima", "ksiegowy"]), "ksiegowy");
  assert.equal(voiceAddress("hej Simo co tam", ["sima", "ksiegowy"]), "sima");
  assert.equal(voiceAddress("policz to księgowy", ["sima", "ksiegowy"]), null);
  assert.equal(userSlug("Kacper Walczak"), "kacper");
  assert.equal(userSlug("Łukasz"), "lukasz");
  assert.equal(userSlug(""), "ty");
});

console.log(`core: ${n} testów OK`);
