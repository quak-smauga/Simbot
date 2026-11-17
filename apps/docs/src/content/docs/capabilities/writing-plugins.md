---
title: Napisz własną capability
description: Krok po kroku — lokalny plugin w folderze sima, deskryptor, implementacja, eventy, human-in-the-loop, test.
sidebar:
  order: 6
status: implemented
sources:
  - packages/core/src/capability.ts
  - packages/core/src/loader.ts
  - packages/core/src/manifest.ts
---

Przykład: sim `kucharz` dostaje narzędzie `pantry.list`, które czyta listę produktów z pliku. Gotowy folder z tym pluginem, skillem i spiżarnią leży w `examples/kucharz` — `cp -r examples/kucharz agents/` i masz działającego sima.

## 1. Folder pluginu

```
agents/kucharz/plugins/pantry/
├── capability.yaml
└── index.js
```

Manifest sima musi wskazywać folder pluginów (domyślnie tak jest):

```yaml
capabilities:
  builtin: [web, computer, skills]
  plugins: ./plugins
```

## 2. Deskryptor

```yaml
apiVersion: qwe/v1
kind: Capability
name: pantry
version: 0.1.0
description: Spiżarnia — co jest w domu.
dependencies:
  npm: []
  system: []
tools:
  - name: pantry.list
    usage: "<pantry.list>kategoria albo puste</pantry.list> — lista produktów w spiżarni"
    notes: "Nie zgaduj, co jest w domu — sprawdź."
```

`usage` i `notes` lądują w prompcie sima — pisz je dla modelu.

## 3. Implementacja

```js
// agents/kucharz/plugins/pantry/index.js — ESM
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function create(ctx) {
  return {
    "pantry.list": async (args, call) => {
      call.emit("pantry.started", { category: args._ });
      const file = join(ctx.agentsDir, call.agent ?? "kucharz", "pantry.txt");
      const lines = (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
      const hit = args._ ? lines.filter((l) => l.includes(args._)) : lines;
      return { ok: true, text: hit.join("\n") || "Spiżarnia pusta.", data: { count: hit.length } };
    },
  };
}
```

Dłuższa praca: wołaj `await call.checkpoint()` między krokami (pauza / anulowanie) i sprawdzaj `call.signal`. Potrzebujesz usera: `await call.waitForUser("CONFIRM_ACTION", "Usunąć 3 produkty?", { details: [...] })`.

## 4. Zależności npm

Zadeklaruj je w `dependencies.npm`. W dev zainstaluj lokalnie; `qwe build` zbiera unię zależności wszystkich pluginów do warstwy obrazu (konflikty zakresów → głośny błąd). Plugin **nie instaluje niczego sam** w runtime.

## 5. Sprawdź

```bash
qwe inspect agents/kucharz     # czy manifest widzi capability i tool
```

Restart agenta (unia capability ładuje się na starcie), potem w rozmowie: `@kucharz co mamy w spiżarni?`. Eventy zobaczysz na `http://127.0.0.1:7777/dashboard/`.

## Checklista

- [ ] Nazwa toola z prefiksem capability (`pantry.*`).
- [ ] `text` dla modelu — zwięzły; `data` — lekki, dla UI.
- [ ] Eventy tylko przy zmianie sytuacji, obrazy przez `call.screenshots.put()`.
- [ ] Operacje wrażliwe przez `waitForUser("CONFIRM_ACTION", …)`.
- [ ] Treści z zewnątrz traktowane jako dane, nie instrukcje.
- [ ] Strona w docsach: `capabilities/<tool>.md` + wpis w [mapie repo → docs](/maintenance/mapping/).
