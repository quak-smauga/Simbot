// SPEAKABLE — strumień tekstu sima → tekst do syntezy mowy. Czat renderuje markdown, ale syntezator nie powinien czytać
// gwiazdek, kresek ani „pionowa kreska”. Filtr działa na deltach (bez czekania na całą odpowiedź, żeby głos startował od razu):
//   • pełne wiersze: zdejmuje znaczniki bloków (#, >, -, 1.), wiersze tabeli → „komórka, komórka.”, linia |---| i ``` → cisza (kod pomijamy)
//   • niedokończony wiersz zwykłego tekstu: oddaje do ostatniej spacji (inline: bez *, _, ~, `, link → sam opis, goły adres → nic)
//   • wiersz, który dopiero zaczyna się jak tabela / kod / nagłówek / lista, czeka na \n
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export class SpeechFilter {
  private buf = "";
  private inCode = false;
  /** Część bieżącego wiersza już poszła do syntezy (reguły początku wiersza już zastosowane). */
  private midLine = false;

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
      out += this.line(this.buf.slice(0, nl), true);
      this.buf = this.buf.slice(nl + 1);
      this.midLine = false;
    }
    if (this.inCode || !this.buf) return out;
    const head = this.buf.trimStart();
    if (!this.midLine && (head.length < 4 || /^(\||`|~|#|>|[-*+•]\s|\d{1,3}[.)]\s)/.test(head))) return out;
    let cut = this.buf.lastIndexOf(" ");
    const open = this.buf.lastIndexOf("[");
    if (open >= 0 && !/\]\([^)]*\)/.test(this.buf.slice(open))) cut = Math.min(cut, open - 1);
    if (cut > 0) {
      out += this.line(this.buf.slice(0, cut + 1), false);
      this.buf = this.buf.slice(cut + 1);
      this.midLine = true;
    }
    return out;
  }

  flush(): string {
    const r = this.buf ? this.line(this.buf, true) : "";
    this.buf = "";
    this.midLine = false;
    return r;
  }

  private line(raw: string, end: boolean): string {
    let s = raw;
    if (!this.midLine && FENCE.test(s)) {
      this.inCode = !this.inCode;
      return "";
    }
    if (this.inCode) return "";
    if (!this.midLine) {
      if ((s.includes("|") && s.includes("-") && SEP.test(s)) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) return "";
      s = s
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*[-*+•]\s+(\[[ xX]\]\s+)?/, "")
        .replace(/^\s*(\d{1,3})[.)]\s+/, "$1. ");
      if (/^\s*\|/.test(s))
        s = s
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean)
          .join(", ");
    }
    s = s
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_~`]+/g, "");
    if (!end) return s;
    const t = s.trim();
    // koniec wiersza bez interpunkcji (punkt listy, wiersz tabeli, nagłówek) → kropka = pauza w mowie
    return t ? `${s.trimEnd()}${/[.!?:;,…]$/.test(t) ? "" : "."} ` : "";
  }
}
