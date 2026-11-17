---
title: skill.save
description: Sim uczy się w trakcie rozmowy — zapisuje sprawdzony sposób zrobienia czegoś jako skill w swoim folderze.
sidebar:
  order: 4
status: implemented
sources:
  - plugins/skills/src/index.ts
  - plugins/skills/capability.yaml
  - packages/core/src/manifest.ts
---

```xml
<nativeapi>
  <skill.save name="infakt-faktura" description="Wystawianie faktury w inFakt">
1. Otwórz app.infakt.pl/faktury/nowa …
2. …
Wymaga potwierdzenia usera: wysłanie faktury.
  </skill.save>
</nativeapi>
```

## Kiedy sim go używa

- user mówi „zapamiętaj, jak to robić” / „następnym razem tak samo”, **albo**
- właśnie udało się wieloetapowe zadanie (`computer.run` / plan), które pewnie wróci (faktura, raport, logowanie do panelu).

Nazwa: małe litery i myślniki. Treść: konkretne kroki z tego, co **faktycznie zadziałało**, i co wymaga potwierdzenia usera. Skill o tej samej nazwie jest nadpisywany (ulepszany).

## Jak działa

1. `call.agent` mówi, który sim wywołał — skill trafia do `agents/<sim>/skills/<name>.md` (frontmatter `name`, `description`, `uses`).
2. Event `skill.saved` → chat przeładowuje prompt sima.
3. Od następnej tury skill jest w prompcie.

Skille można też dodawać i usuwać ręcznie: strona sima w UI albo `POST/DELETE /api/bots/:name/skills`.
