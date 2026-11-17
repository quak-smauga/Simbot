// AVATAR — komponent awatara sima/usera (z biblioteki avatars.html). viewBox 0 0 64 64, kolor przez currentColor (--c),
// oczy przez --eye/--sclera. Stany: data-state = idle | listening | thinking | speaking | working | error | sleeping
// | offline | celebrating | surprised | confused | loving. CSS komponentu: app.css, blok „avatar”.
//   makeAvatar(cfg, size) → <span class="avatar">   cfg = { id, color, shape, eyes, mouth, acc:[…], pattern, idle, state }
//   setState(el|botId, state)   mountGroup(el, cfgs, size) → awatar grupy (1 / 2 nakładające się / 2 + „+N”)
//   PRESETS — gotowe osobowości do „dodaj sima” · OPTIONS — klucze do konstruktora
const STATES = ['idle','listening','thinking','speaking','working','error','sleeping','offline','celebrating','surprised','confused','loving'];
const STATE_PL = {idle:'czeka',listening:'słucha',thinking:'myśli',speaking:'mówi',working:'działa',error:'błąd',sleeping:'śpi',offline:'offline',celebrating:'świętuje',surprised:'zdziwiony',confused:'zmieszany',loving:'kocha'};

const C='currentColor', SH='rgba(0,0,0,.18)', HI='rgba(255,255,255,.22)';

/* ---------- KSZTAŁTY (body) ---------- */
const SHAPES = {
  head:    `<path d="M14 22 Q14 8 32 8 Q50 8 50 22 V40 Q50 56 32 56 Q14 56 14 40 Z" fill="${C}"/><path d="M14 23 Q20 16 32 16 Q44 16 50 23 V18 Q50 6 32 6 Q14 6 14 18Z" fill="${SH}"/>`,
  tall:    `<path d="M16 20 Q16 4 32 4 Q48 4 48 20 V44 Q48 60 32 60 Q16 60 16 44Z" fill="${C}"/><path d="M16 20 Q22 12 32 12 Q42 12 48 20 V16 Q48 2 32 2 Q16 2 16 16Z" fill="${SH}"/>`,
  blob:    `<path d="M32 7 C46 7 58 18 56 33 C55 47 46 57 32 57 C18 57 7 47 8 32 C9 17 18 7 32 7Z" fill="${C}"/>`,
  square:  `<rect x="11" y="11" width="42" height="42" rx="9" fill="${C}"/>`,
  circle:  `<circle cx="32" cy="32" r="23" fill="${C}"/>`,
  hex:     `<path d="M32 7 L54 19.5 V44.5 L32 57 L10 44.5 V19.5Z" fill="${C}" stroke="${C}" stroke-width="4" stroke-linejoin="round"/>`,
  drop:    `<path d="M32 4 C32 4 52 26 52 38 A20 20 0 0 1 12 38 C12 26 32 4 32 4Z" fill="${C}"/>`,
  ghost:   `<path d="M12 30 A20 20 0 0 1 52 30 V56 L45 50 L38.5 56 L32 50 L25.5 56 L19 50 L12 56Z" fill="${C}"/>`,
  cloud:   `<path d="M18 50 A10 10 0 0 1 16 30 A13 13 0 0 1 40 22 A11 11 0 0 1 50 40 A8 8 0 0 1 46 50Z" fill="${C}"/>`,
  diamond: `<path d="M32 6 L56 32 L32 58 L8 32Z" fill="${C}" stroke="${C}" stroke-width="5" stroke-linejoin="round"/>`,
  pill:    `<rect x="14" y="6" width="36" height="52" rx="18" fill="${C}"/>`,
  tri:     `<path d="M32 8 L56 54 H8Z" fill="${C}" stroke="${C}" stroke-width="7" stroke-linejoin="round"/>`,
  egg:     `<path d="M32 6 C44 6 52 22 52 36 A20 20 0 0 1 12 36 C12 22 20 6 32 6Z" fill="${C}"/>`,
  robot:   `<rect x="11" y="13" width="42" height="40" rx="6" fill="${C}"/><rect x="18" y="8" width="28" height="7" rx="2" fill="${SH}"/><circle cx="15" cy="49" r="1.6" fill="${SH}"/><circle cx="49" cy="49" r="1.6" fill="${SH}"/><circle cx="15" cy="17" r="1.6" fill="${SH}"/><circle cx="49" cy="17" r="1.6" fill="${SH}"/>`,
  tv:      `<rect x="8" y="12" width="48" height="38" rx="7" fill="${C}"/><rect x="24" y="50" width="16" height="4" rx="1" fill="${SH}"/><rect x="18" y="54" width="28" height="3" rx="1.5" fill="${SH}"/><path d="M26 12 L21 4 M38 12 L43 4" stroke="${C}" stroke-width="2.4" stroke-linecap="round"/>`,
  leaf:    `<path d="M10 54 C10 24 30 8 56 10 C58 36 40 56 10 54Z" fill="${C}"/><path d="M12 52 C22 40 36 28 52 14" stroke="${SH}" stroke-width="2" fill="none"/>`,
  star:    `<path d="M32 4 L39 23 L59 24 L43 37 L49 56 L32 45 L15 56 L21 37 L5 24 L25 23Z" fill="${C}" stroke="${C}" stroke-width="5" stroke-linejoin="round"/>`,
  dot:     `<circle cx="32" cy="32" r="16" fill="${C}"/>`,  /* mała „kropka” jak w trybie głosowym */
};

/* ---------- WZORY (pattern) — nakładka na body ---------- */
const PATTERNS = {
  none:  ()=>'',
  shade: ()=>`<path d="M14 40 Q32 50 50 40 V44 Q50 56 32 56 Q14 56 14 44Z" fill="${SH}"/>`,
  shine: ()=>`<ellipse cx="24" cy="18" rx="7" ry="4" fill="${HI}" transform="rotate(-25 24 18)"/>`,
  stripes:(id)=>`<defs><pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="${SH}"/></pattern></defs><rect x="0" y="0" width="64" height="64" fill="url(#${id})" mask="url(#${id}m)"/>`,
  dots:  (id)=>`<defs><pattern id="${id}" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.4" fill="${SH}"/></pattern></defs><rect width="64" height="64" fill="url(#${id})" mask="url(#${id}m)"/>`,
  grid:  (id)=>`<defs><pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M8 0H0V8" fill="none" stroke="${SH}" stroke-width="1"/></pattern></defs><rect width="64" height="64" fill="url(#${id})" mask="url(#${id}m)"/>`,
  pixel: (id)=>`<defs><pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${HI}"/><rect x="4" y="4" width="4" height="4" fill="${HI}"/></pattern></defs><rect width="64" height="64" fill="url(#${id})" mask="url(#${id}m)"/>`,
  waves: (id)=>`<defs><pattern id="${id}" width="12" height="8" patternUnits="userSpaceOnUse"><path d="M0 4 Q3 0 6 4 T12 4" fill="none" stroke="${SH}" stroke-width="1.2"/></pattern></defs><rect width="64" height="64" fill="url(#${id})" mask="url(#${id}m)"/>`,
  glow:  (id)=>`<defs><radialGradient id="${id}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></radialGradient></defs><rect width="64" height="64" fill="url(#${id})" mask="url(#${id}m)"/>`,
  scan:  (id)=>`<defs><pattern id="${id}" width="2" height="3" patternUnits="userSpaceOnUse"><rect width="2" height="1" fill="rgba(0,0,0,.14)"/></pattern></defs><rect width="64" height="64" fill="url(#${id})" mask="url(#${id}m)"/>`,
};

/* ---------- OCZY ---------- 
   Każde oko: .eye (skalowanie) > sclera, .pupil (ruch), błysk, .lid (mruganie, kolor body).
   Funkcja dostaje pozycję x i zwraca <g>. 'cyclops' i 'three' ignorują x. */
const EYE = {
  round:  x=>`<g class="eye" transform="translate(${x} 29)"><ellipse rx="5" ry="5.6" fill="var(--sclera)"/><circle class="pupil" r="2.4" cy=".3" fill="var(--eye)"/><circle r=".8" cx="-1" cy="-1.3" fill="#fff" opacity=".9"/><ellipse class="lid" rx="5.3" ry="5.9" cy="-5.6" fill="${C}"/></g>`,
  dot:    x=>`<g class="eye" transform="translate(${x} 29)"><circle class="pupil" r="2.6" fill="var(--eye)"/><circle r=".7" cx="-.8" cy="-.9" fill="#fff" opacity=".85"/><rect class="lid" x="-4" y="-4" width="8" height="8" fill="${C}"/></g>`,
  wide:   x=>`<g class="eye" transform="translate(${x} 29)"><ellipse rx="6.5" ry="4.5" fill="var(--sclera)"/><circle class="pupil" r="2.6" fill="var(--eye)"/><circle r=".9" cx="-1.2" cy="-1.2" fill="#fff" opacity=".9"/><ellipse class="lid" rx="6.8" ry="4.8" cy="-4.6" fill="${C}"/></g>`,
  oval:   x=>`<g class="eye" transform="translate(${x} 28)"><ellipse rx="4" ry="7" fill="var(--sclera)"/><ellipse class="pupil" rx="2.2" ry="3.2" cy=".5" fill="var(--eye)"/><circle r=".8" cx="-.8" cy="-2" fill="#fff" opacity=".9"/><ellipse class="lid" rx="4.3" ry="7.3" cy="-7" fill="${C}"/></g>`,
  pixel:  x=>`<g class="eye" transform="translate(${x} 29)"><rect x="-5" y="-5" width="10" height="10" fill="var(--sclera)"/><rect class="pupil" x="-2.5" y="-2" width="5" height="5" fill="var(--eye)"/><rect class="lid" x="-5" y="-10" width="10" height="10" fill="${C}"/></g>`,
  cat:    x=>`<g class="eye" transform="translate(${x} 29)"><ellipse rx="5" ry="5.6" fill="var(--sclera)"/><ellipse class="pupil" rx="1.3" ry="4" fill="var(--eye)"/><circle r=".7" cx="-.8" cy="-2" fill="#fff" opacity=".9"/><ellipse class="lid" rx="5.3" ry="5.9" cy="-5.6" fill="${C}"/></g>`,
  lash:   x=>`<g class="eye" transform="translate(${x} 29)"><ellipse rx="5" ry="5.6" fill="var(--sclera)"/><circle class="pupil" r="2.6" cy=".3" fill="var(--eye)"/><circle r=".8" cx="-1" cy="-1.3" fill="#fff" opacity=".9"/><path d="M-5.5 -3 l-2 -2 M-2 -6 l-1 -2.5 M2 -6 l1 -2.5 M5.5 -3 l2 -2" stroke="var(--eye)" stroke-width="1.3" stroke-linecap="round"/><ellipse class="lid" rx="5.3" ry="5.9" cy="-5.6" fill="${C}"/></g>`,
  sleepy: x=>`<g class="eye" transform="translate(${x} 29)"><ellipse rx="5" ry="5.6" fill="var(--sclera)"/><circle class="pupil" r="2.4" cy="1" fill="var(--eye)"/><ellipse class="lid" rx="5.3" ry="5.9" cy="-5.6" fill="${C}" style="transform:scaleY(.5)"/><ellipse rx="5.3" ry="5.9" cy="-8.6" fill="${C}"/></g>`,
  ring:   x=>`<g class="eye" transform="translate(${x} 29)"><circle r="5" fill="none" stroke="var(--eye)" stroke-width="1.8"/><circle class="pupil" r="1.8" fill="var(--eye)"/><rect class="lid" x="-6" y="-6" width="12" height="12" fill="${C}"/></g>`,
  cyclops:()=>`<g class="eye" transform="translate(32 28)"><ellipse rx="9" ry="9.5" fill="var(--sclera)"/><circle class="pupil" r="4" cy=".5" fill="var(--eye)"/><circle r="1.3" cx="-1.6" cy="-2" fill="#fff" opacity=".9"/><ellipse class="lid" rx="9.3" ry="9.8" cy="-9.5" fill="${C}"/></g>`,
  visor:  ()=>`<g class="eye" transform="translate(32 29)"><rect x="-14" y="-4" width="28" height="8" rx="4" fill="var(--eye)"/><rect class="pupil" x="-9" y="-2" width="5" height="4" rx="2" fill="var(--sclera)"/><rect class="pupil" x="4" y="-2" width="5" height="4" rx="2" fill="var(--sclera)"/><rect class="lid" x="-14" y="-4" width="28" height="4" rx="2" fill="${C}"/></g>`,
  three:  ()=>[22,32,42].map((x,i)=>`<g class="eye" transform="translate(${x} ${i===1?22:30})"><circle r="4" fill="var(--sclera)"/><circle class="pupil" r="1.9" fill="var(--eye)"/><circle r=".6" cx="-.7" cy="-1" fill="#fff" opacity=".9"/><circle class="lid" r="4.3" cy="-4.2" fill="${C}"/></g>`).join(''),
};
const EYE_POS = {round:[23,41],dot:[24,40],wide:[22,42],oval:[23,41],pixel:[23,41],cat:[23,41],lash:[23,41],sleepy:[23,41],ring:[23,41],cyclops:[0],visor:[0],three:[0]};

/* ---------- USTA — zawsze w <g class="mouth"> żeby animacja talk działała ---------- */
const MOUTH = {
  smile: `<path d="M26 42 q6 4 12 0" fill="none" stroke="var(--eye)" stroke-width="2.2" stroke-linecap="round"/>`,
  flat:  `<path d="M26 42 h12" fill="none" stroke="var(--eye)" stroke-width="2.2" stroke-linecap="round"/>`,
  cat:   `<path d="M25 41 q3.5 4 7 0 q3.5 4 7 0" fill="none" stroke="var(--eye)" stroke-width="2" stroke-linecap="round"/>`,
  open:  `<ellipse cx="32" cy="43" rx="4" ry="3" fill="var(--eye)"/>`,
  grin:  `<path d="M24 40 q8 8 16 0z" fill="var(--eye)"/><path d="M27 41 h10 v2 h-10z" fill="var(--sclera)"/>`,
  zig:   `<path d="M25 42 l3 -2 l3 2 l3 -2 l3 2 l3 -2" fill="none" stroke="var(--eye)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`,
  beak:  `<path d="M26 40 h12 l-6 6z" fill="var(--q-orange)" stroke="var(--eye)" stroke-width="1.2" stroke-linejoin="round"/>`,
  tongue:`<path d="M26 41 q6 5 12 0" fill="none" stroke="var(--eye)" stroke-width="2.2" stroke-linecap="round"/><path d="M30 43 q2 4 5 0z" fill="var(--q-pink)"/>`,
  tiny:  `<circle cx="32" cy="42" r="1.6" fill="var(--eye)"/>`,
  mono:  `<path d="M22 43 q10 6 20 0" fill="none" stroke="var(--eye)" stroke-width="2.6" stroke-linecap="round"/>`,
  none:  ``,
};

/* ---------- AKCESORIA — {layer:'back'|'front', svg} ---------- */
const ACC = {
  glasses:   {layer:'front', svg:`<g fill="none" stroke="var(--eye)" stroke-width="1.6"><rect x="16.5" y="24.5" width="12" height="9" rx="2.5"/><rect x="35.5" y="24.5" width="12" height="9" rx="2.5"/><path d="M28.5 29h7M16.5 28l-3-1M47.5 28l3-1"/></g>`},
  rglasses:  {layer:'front', svg:`<g fill="none" stroke="var(--eye)" stroke-width="1.6"><circle cx="23" cy="29" r="6.5"/><circle cx="41" cy="29" r="6.5"/><path d="M29.5 29h5M16.5 28l-3-1M47.5 28l3-1"/></g>`},
  shades:    {layer:'front', svg:`<g><rect x="15" y="24" width="14" height="10" rx="3" fill="var(--eye)"/><rect x="35" y="24" width="14" height="10" rx="3" fill="var(--eye)"/><path d="M29 28h6M15 27l-3-1M49 27l3-1" stroke="var(--eye)" stroke-width="1.6"/><path d="M18 27h4M38 27h4" stroke="#fff" stroke-width="1.2" opacity=".5"/></g>`},
  monocle:   {layer:'front', svg:`<g fill="none" stroke="var(--eye)" stroke-width="1.6"><circle cx="41" cy="29" r="6.5"/><path d="M47 33 q2 8 -2 12"/></g>`},
  bun:       {layer:'back',  svg:`<circle cx="32" cy="7" r="6" fill="${C}"/><circle cx="32" cy="7" r="6" fill="${SH}"/>`},
  antenna:   {layer:'back',  svg:`<g class="acc antenna"><path d="M32 8V2" stroke="${C}" stroke-width="2.5" stroke-linecap="round"/><circle cx="32" cy="2" r="2.6" fill="${C}"/></g>`},
  antenna2:  {layer:'back',  svg:`<g class="acc antenna"><path d="M22 10 l-4 -8 M42 10 l4 -8" stroke="${C}" stroke-width="2.4" stroke-linecap="round"/><circle cx="18" cy="2" r="2.4" fill="var(--q-red)"/><circle cx="46" cy="2" r="2.4" fill="var(--q-green)"/></g>`},
  hat:       {layer:'front', svg:`<path d="M12 15h40l-4-4H16z" fill="var(--eye)"/><path d="M20 11 V5 q12-4 24 0 V11z" fill="var(--eye)"/>`},
  beret:     {layer:'front', svg:`<path d="M12 14 q20 -14 40 0 q-20 4 -40 0z" fill="var(--eye)"/><circle cx="33" cy="4" r="1.6" fill="var(--eye)"/>`},
  crown:     {layer:'front', svg:`<path d="M18 14 L18 4 L25 10 L32 2 L39 10 L46 4 L46 14z" fill="var(--q-yellow)" stroke="rgba(0,0,0,.25)" stroke-width="1.2" stroke-linejoin="round"/>`},
  halo:      {layer:'back',  svg:`<ellipse cx="32" cy="3" rx="13" ry="3.5" fill="none" stroke="var(--q-yellow)" stroke-width="2.4"/>`},
  horns:     {layer:'back',  svg:`<path d="M16 16 q-6 -8 -2 -14 q4 6 8 10z M48 16 q6 -8 2 -14 q-4 6 -8 10z" fill="${C}" stroke="${SH}" stroke-width="1"/>`},
  ears:      {layer:'back',  svg:`<g class="acc ears"><circle cx="12" cy="12" r="7" fill="${C}"/><circle cx="52" cy="12" r="7" fill="${C}"/><circle cx="12" cy="12" r="3.5" fill="${SH}"/><circle cx="52" cy="12" r="3.5" fill="${SH}"/></g>`},
  catears:   {layer:'back',  svg:`<g class="acc ears"><path d="M14 20 L12 2 L26 12z M50 20 L52 2 L38 12z" fill="${C}"/><path d="M16 17 L15 7 L23 12z M48 17 L49 7 L41 12z" fill="var(--q-pink)" opacity=".7"/></g>`},
  bunny:     {layer:'back',  svg:`<g class="acc ears"><path d="M20 14 q-6 -16 2 -14 q4 4 4 14z M44 14 q6 -16 -2 -14 q-4 4 -4 14z" fill="${C}"/><path d="M22 12 q-3 -10 1 -10 q1 3 1 10z M42 12 q3 -10 -1 -10 q-1 3 -1 10z" fill="var(--q-pink)" opacity=".7"/></g>`},
  headphones:{layer:'front', svg:`<path d="M12 30 V22 a20 20 0 0 1 40 0 V30" fill="none" stroke="var(--eye)" stroke-width="3"/><rect x="8" y="26" width="7" height="12" rx="3" fill="var(--eye)"/><rect x="49" y="26" width="7" height="12" rx="3" fill="var(--eye)"/>`},
  bow:       {layer:'front', svg:`<path d="M44 8 l8 -4 v8z M44 8 l-8 -4 v8z" fill="var(--q-red)"/><circle cx="44" cy="8" r="1.8" fill="rgba(0,0,0,.3)"/>`},
  bowtie:    {layer:'front', svg:`<path d="M32 52 l-8 -4 v8z M32 52 l8 -4 v8z" fill="var(--q-red)"/><circle cx="32" cy="52" r="1.6" fill="rgba(0,0,0,.3)"/>`},
  mustache:  {layer:'front', svg:`<path d="M32 38 q-4 -4 -9 0 q4 3 9 0 q5 3 9 0 q-5 -4 -9 0z" fill="var(--eye)"/>`},
  beard:     {layer:'front', svg:`<path d="M18 38 q14 20 28 0 q-4 16 -14 16 q-10 0 -14 -16z" fill="${SH}"/>`},
  sprout:    {layer:'back',  svg:`<g class="acc"><path d="M32 8 V1" stroke="var(--q-green)" stroke-width="2" stroke-linecap="round"/><path d="M32 4 q-7 -6 -7 1 q5 2 7 -1z M32 4 q7 -6 7 1 q-5 2 -7 -1z" fill="var(--q-green)"/></g>`},
  bolt:      {layer:'back',  svg:`<rect x="4" y="26" width="6" height="8" rx="1.5" fill="${SH}"/><rect x="54" y="26" width="6" height="8" rx="1.5" fill="${SH}"/>`},
  blush:     {layer:'front', svg:`<circle cx="17" cy="37" r="3" fill="var(--q-pink)" opacity=".45"/><circle cx="47" cy="37" r="3" fill="var(--q-pink)" opacity=".45"/>`},
  freckles:  {layer:'front', svg:`<g fill="rgba(0,0,0,.28)"><circle cx="18" cy="37" r=".9"/><circle cx="21" cy="39" r=".9"/><circle cx="24" cy="37" r=".9"/><circle cx="40" cy="37" r=".9"/><circle cx="43" cy="39" r=".9"/><circle cx="46" cy="37" r=".9"/></g>`},
  scar:      {layer:'front', svg:`<path d="M44 18 l3 8 M43 21 l3 -1 M44.5 24 l3 -1" stroke="var(--eye)" stroke-width="1.3" stroke-linecap="round"/>`},
  badge:     {layer:'front', svg:`<circle cx="50" cy="50" r="6" fill="var(--q-yellow)" stroke="var(--panel)" stroke-width="2"/><path d="M47 50 l2 2 l4 -4" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`},
  afro:      {layer:'back',  svg:`<circle cx="32" cy="22" r="26" fill="${C}"/><circle cx="32" cy="22" r="26" fill="${SH}"/>`},
  mohawk:    {layer:'back',  svg:`<path d="M26 10 L28 0 L32 6 L36 0 L38 10z" fill="var(--eye)"/>`},
  earrings:  {layer:'front', svg:`<circle cx="13" cy="38" r="2" fill="none" stroke="var(--q-yellow)" stroke-width="1.5"/><circle cx="51" cy="38" r="2" fill="none" stroke="var(--q-yellow)" stroke-width="1.5"/>`},
};

/* ---------- FX dla stanów (zawsze dołączane, widoczne tylko w danym stanie) ---------- */
const FX = `
  <g class="fx think" fill="${C}"><circle cx="52" cy="14" r="1.6"/><circle cx="57" cy="9" r="2.2"/><circle cx="63" cy="3" r="2.8"/></g>
  <g class="fx work"><circle cx="32" cy="32" r="30" fill="none" stroke="${C}" stroke-width="2.5" stroke-dasharray="14 10" opacity=".9"/></g>
  <g class="fx zzz" fill="${C}" font-size="11" font-weight="700" font-family="system-ui"><text x="48" y="14">z</text><text x="54" y="8">z</text></g>
  <g class="fx stars" fill="var(--q-yellow)"><path d="M8 10 l1.5 3 3 .5 -2.2 2 .6 3 -2.9 -1.5 -2.9 1.5 .6 -3 -2.2 -2 3 -.5z"/><path d="M54 6 l1.5 3 3 .5 -2.2 2 .6 3 -2.9 -1.5 -2.9 1.5 .6 -3 -2.2 -2 3 -.5z"/><path d="M58 44 l1.5 3 3 .5 -2.2 2 .6 3 -2.9 -1.5 -2.9 1.5 .6 -3 -2.2 -2 3 -.5z"/></g>
  <g class="fx bang" fill="${C}" font-size="18" font-weight="800" font-family="system-ui"><text x="52" y="16">!</text></g>
  <g class="fx quest" fill="${C}" font-size="16" font-weight="800" font-family="system-ui"><text x="50" y="16">?</text></g>
  <g class="fx hearts" fill="var(--q-pink)"><path d="M52 12 c-2 -4 -8 -1 -5 3 l5 5 5 -5 c3 -4 -3 -7 -5 -3z"/><path d="M10 16 c-2 -4 -8 -1 -5 3 l5 5 5 -5 c3 -4 -3 -7 -5 -3z"/></g>
  <g class="fx spark" stroke="var(--q-yellow)" stroke-width="1.8" stroke-linecap="round"><path d="M6 10 l4 4 M10 10 l-4 4 M56 6 l4 4 M60 6 l-4 4"/></g>`;

let _uid=0;

function avatarSVG(cfg){
  const shape=SHAPES[cfg.shape]||SHAPES.circle, eyeFn=EYE[cfg.eyes||'round'], pos=EYE_POS[cfg.eyes||'round'];
  const accs=(cfg.acc||[]).map(a=>ACC[a]).filter(Boolean);
  const back=accs.filter(a=>a.layer==='back').map(a=>a.svg).join('');
  const front=accs.filter(a=>a.layer==='front').map(a=>a.svg).join('');
  const pid='p'+(++_uid);
  const pat=(PATTERNS[cfg.pattern||'none']||PATTERNS.none)(pid);
  const eyes = pos.length===1 ? eyeFn() : pos.map(eyeFn).join('');
  const showBrows = !['visor','three'].includes(cfg.eyes);
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    ${pat?`<mask id="${pid}m"><g fill="#fff">${shape.replace(/fill="[^"]*"/g,'fill="#fff"').replace(/stroke="[^"]*"/g,'stroke="#fff"')}</g></mask>`:''}
    <circle class="ring" cx="32" cy="32" r="30" fill="none" stroke="${C}" stroke-width="2"/>
    <g class="body">${back}${shape}${pat}</g>
    <g class="face">
      ${showBrows?`<g stroke="var(--eye)" stroke-width="2" stroke-linecap="round" fill="none"><path class="brow l" d="M18.5 21.5 l8 -.5"/><path class="brow r" d="M37.5 21 l8 .5"/></g>`:''}
      ${eyes}
      ${front}
      <g class="mouth">${MOUTH[cfg.mouth||'smile']}</g>
      ${FX}
    </g></svg>`;
}
function makeAvatar(cfg,size=48){
  const el=document.createElement('span'); el.className='avatar';
  el.style.setProperty('--c',cfg.color||'var(--q-blue)'); el.style.setProperty('--s',size+'px');
  el.dataset.bot=cfg.id||''; el.dataset.state=cfg.state||'idle'; if(cfg.idle) el.dataset.idle=cfg.idle;
  el.innerHTML=avatarSVG(cfg); return el;
}
function setState(target,state){
  const els = typeof target==='string' ? document.querySelectorAll(`.avatar[data-bot="${target}"]`) : [target];
  els.forEach(a=>{ if(['error','surprised'].includes(state)){a.dataset.state='';void a.offsetWidth;} a.dataset.state=state; });
}
function _unusedStartBlinking(){
  (function loop(){
    const groups={};
    document.querySelectorAll('.avatar').forEach(a=>{ const k=a.dataset.bot||('_'+Math.random()); (groups[k]=groups[k]||[]).push(a); });
    Object.values(groups).forEach(g=>{
      if(['sleeping','offline','celebrating','loving'].includes(g[0].dataset.state)) return;
      if(Math.random()<.22) g.forEach(a=>{a.classList.add('blink');setTimeout(()=>a.classList.remove('blink'),130);});
    });
    setTimeout(loop,900+Math.random()*1400);
  })();
}

export const OPTIONS = { shape: Object.keys(SHAPES), eyes: Object.keys(EYE), mouth: Object.keys(MOUTH), acc: Object.keys(ACC), pattern: Object.keys(PATTERNS), idle: ['bob','sway','jelly','float','tick','still'] };
export const COLORS = { red:'var(--q-red)', green:'var(--q-green)', blue:'var(--q-blue)', yellow:'var(--q-yellow)', violet:'var(--q-violet)', pink:'var(--q-pink)', teal:'var(--q-teal)', orange:'var(--q-orange)' };
export const COLOR_HEX = { red:'#E8453C', green:'#3BB273', blue:'#3A7BD5', yellow:'#F2C94C', violet:'#8B5CF6', pink:'#EC6FA8', teal:'#2BB5A6', orange:'#F08A3C' };
export const PRESETS = [
  { name:'Księgowy', color:'#3A7BD5', shape:'square', eyes:'round', mouth:'flat', acc:['glasses'], pattern:'none', idle:'tick' },
  { name:'Sima', color:'#E8453C', shape:'head', eyes:'lash', mouth:'smile', acc:['bun'], pattern:'shade', idle:'sway' },
  { name:'Badacz', color:'#3BB273', shape:'blob', eyes:'wide', mouth:'smile', acc:['antenna'], pattern:'dots', idle:'jelly' },
  { name:'Pisarz', color:'#F2C94C', shape:'circle', eyes:'sleepy', mouth:'tiny', acc:['beret'], pattern:'shine', idle:'float' },
  { name:'Robocik', color:'#3A7BD5', shape:'robot', eyes:'visor', mouth:'zig', acc:['antenna2','bolt'], pattern:'scan', idle:'tick' },
  { name:'Duszek', color:'#8B5CF6', shape:'ghost', eyes:'dot', mouth:'open', acc:[], pattern:'glow', idle:'float' },
  { name:'Kotek', color:'#F08A3C', shape:'circle', eyes:'cat', mouth:'cat', acc:['catears','blush'], pattern:'stripes', idle:'sway' },
  { name:'Król', color:'#E8453C', shape:'tall', eyes:'round', mouth:'mono', acc:['crown','beard'], pattern:'shade', idle:'still' },
  { name:'Kropelka', color:'#2BB5A6', shape:'drop', eyes:'oval', mouth:'smile', acc:['blush'], pattern:'shine', idle:'jelly' },
  { name:'Oko', color:'#3BB273', shape:'hex', eyes:'cyclops', mouth:'none', acc:[], pattern:'grid', idle:'bob' },
  { name:'Chmurka', color:'#EC6FA8', shape:'cloud', eyes:'sleepy', mouth:'tiny', acc:[], pattern:'none', idle:'float' },
  { name:'DJ', color:'#8B5CF6', shape:'egg', eyes:'round', mouth:'grin', acc:['shades','headphones'], pattern:'pixel', idle:'bob' },
  { name:'Roślinka', color:'#3BB273', shape:'leaf', eyes:'dot', mouth:'smile', acc:['sprout'], pattern:'none', idle:'sway' },
  { name:'SimTV', color:'#3A7BD5', shape:'tv', eyes:'pixel', mouth:'zig', acc:[], pattern:'scan', idle:'tick' },
  { name:'Gwiazdka', color:'#F2C94C', shape:'star', eyes:'ring', mouth:'grin', acc:[], pattern:'shine', idle:'bob' },
  { name:'Trójoki', color:'#2BB5A6', shape:'diamond', eyes:'three', mouth:'flat', acc:[], pattern:'waves', idle:'float' },
  { name:'Profesor', color:'#F08A3C', shape:'pill', eyes:'round', mouth:'flat', acc:['monocle','mustache','bowtie'], pattern:'none', idle:'still' },
  { name:'Kropka', color:'#E8453C', shape:'dot', eyes:'dot', mouth:'none', acc:[], pattern:'glow', idle:'jelly' },
  { name:'Simorakla', color:'#F2C94C', shape:'head', eyes:'round', mouth:'smile', acc:['afro','earrings'], pattern:'shade', idle:'sway' },
  { name:'Punk', color:'#EC6FA8', shape:'square', eyes:'pixel', mouth:'zig', acc:['mohawk','scar'], pattern:'stripes', idle:'tick' },
];
export const randomConfig = () => { const r = o => o[Math.floor(Math.random()*o.length)]; const ak = OPTIONS.acc; return { shape:r(OPTIONS.shape), eyes:r(OPTIONS.eyes), mouth:r(OPTIONS.mouth), pattern:r(OPTIONS.pattern), idle:r(OPTIONS.idle), color:r(Object.values(COLOR_HEX)), acc:[r(ak)].concat(Math.random()<.5?[r(ak)]:[]) }; };

/** Awatar grupy (rozmowa z kilkoma simami): 1 = zwykły, 2 = dwa nakładające się, 3+ = dwa + „+N”. */
export function mountGroup(el, cfgs, size = 44) {
  el.innerHTML = ''; el.classList.add('av-group'); el.style.setProperty('--s', size + 'px');
  const list = cfgs.filter(Boolean);
  if (list.length <= 1) { const a = makeAvatar(list[0] || { id: '', color: 'var(--ink-3)', shape: 'circle', eyes: 'dot', mouth: 'none' }, size); el.append(a); return { setState: s => setState(a, s) }; }
  const small = Math.round(size * 0.68);
  const a = makeAvatar(list[0], small), b = makeAvatar(list[1], small);
  a.classList.add('av-group__a'); b.classList.add('av-group__b');
  el.append(a, b);
  if (list.length > 2) { const n = document.createElement('i'); n.className = 'av-group__more'; n.textContent = '+' + (list.length - 2); el.append(n); }
  return { setState: s => [a, b].forEach(x => setState(x, s)) };
}

/** Jeden globalny timer mrugania — simy o tym samym data-bot mrugają razem. Woła się raz. */
export function startBlinking() {
  if (startBlinking.on) return; startBlinking.on = true;
  (function loop() {
    const groups = {};
    document.querySelectorAll('.avatar').forEach(a => { const k = a.dataset.bot || ('_' + Math.random()); (groups[k] = groups[k] || []).push(a); });
    Object.values(groups).forEach(g => {
      if (['sleeping', 'offline', 'celebrating', 'loving'].includes(g[0].dataset.state)) return;
      if (Math.random() < .22) g.forEach(a => { a.classList.add('blink'); setTimeout(() => a.classList.remove('blink'), 130); });
    });
    setTimeout(loop, 900 + Math.random() * 1400);
  })();
}
export { STATES, STATE_PL, SHAPES, EYE, MOUTH, ACC, PATTERNS, avatarSVG, makeAvatar, setState };
