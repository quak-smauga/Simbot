# Przykładowy sim: kucharz

Kompletny folder sima: manifest, persona, pamięć, skill i lokalny plugin (`pantry.list`).

```bash
cp -r examples/kucharz agents/kucharz
qwe inspect agents/kucharz
```

Potem restart agenta i w rozmowie: `@kucharz co zrobić na obiad z tego, co mam?`

`agents/` jest poza gitem — tam żyją Twoje simy, ich pamięć i skille zapisywane w trakcie rozmów.
