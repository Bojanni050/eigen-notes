# eigen-notes (werknaam)

Een zelfstandige persoonlijke notes-app. Notities zijn **objecten met een soort**
(notitie, persoon, taak, idee, boek, project, afspraak, dag), en de AI-laag is
**afgeleid** — het schrijft nooit in een notitie.

Geïnspireerd op Mindstack (`Bojanni050/CapacitiesDev`), maar met eigen fundering:
Postgres + pgvector in plaats van Mongo zonder indexen, een provider-laag met rollen
in plaats van één hardcoded model, en auth vanaf het begin.

## De twee regels waar alles op rust

1. **Ruw is van jou, afgeleid is van het model.** `notes` wordt nooit door AI
   geschreven. Elke AI-uitvoer gaat naar `derived_items` met het model, de
   aanbieder, de tijdstempel en een accepteer/leg-weg-status. Verversen of
   weggooien raakt de notitie niet.
2. **Een capaciteit bestaat alleen als hij geconfigureerd is.** Zonder
   `SUMMARY_*` is er geen samenvatting — de API zegt dat (`GET /api/meta`), en
   `POST /api/notes/:id/derive` antwoordt met een reden in plaats van met
   verzonnen tekst.

## Draaien

Alles staat in de eigen stack: Postgres 16 + pgvector, twee llama.cpp-servers en
de app. Eén commando, en bij de eerste start worden de twee modellen (~2,5 GB)
gedownload — daarna is het idempotent.

```bash
cp .env.example .env          # zet NOTES_TOKEN erin
docker compose up -d          # db + llm-chat + llm-embed + models + api
open http://127.0.0.1:8899    # of curl; alles behalve /health vraagt de token
```

Zonder Docker, met dezelfde servers maar dan vanuit de repo:

```bash
docker compose up -d db llm-chat llm-embed models
npm ci && npm run migrate
LLM_BASE_URL=http://127.0.0.1:11500/v1 \
EMBED_BASE_URL=http://127.0.0.1:11501/v1 npm start
```

### De modelservers

Twee llama.cpp-processen, want één server bedient één model en een
embedding-model hoort in embedding-modus met CLS-pooling:

| Rol | Model | Waarom |
| --- | --- | --- |
| embeddings | `bge-m3` (Q8_0 GGUF) | meertalig — je notities zijn Nederlands — 1024 dimensies, CLS-pooling |
| chat | `qwen2.5-3b-instruct` (Q4_K_M GGUF) | tags + samenvatting, en de rerank die per treffer een reden geeft |

Geen Ollama, geen daemon met een eigen model-registry: één binary en een
GGUF-bestand, wat ook de weg is naar een Windows-build waarin je alleen die twee
bestanden meelevert. Een model wisselen = de URL in de `models`-service én het
`-m /models/...`-pad van die server aanpassen; de app meldt daarna eerlijk welke
rollen er zijn via `GET /api/meta`.

Deze stack raakt niets anders op de host: eigen containers, eigen volume, eigen
poorten (11500/11501 alleen op loopback, voor een lokale run).

### De vector-index (eenmalig, zodra een embeddingmodel vastligt)

De kolom is bewust dimensieloos, zodat een modelwissel geen migratie is. De prijs
is dat pgvector op zo'n kolom geen index kan bouwen — het zegt letterlijk
`ERROR: column does not have dimensions`. Zodra je model vastligt (bij bge-m3: 1024):

```sql
ALTER TABLE note_embeddings ALTER COLUMN embedding TYPE vector(1024);
CREATE INDEX note_embeddings_hnsw_idx
    ON note_embeddings USING hnsw (embedding vector_cosine_ops);
```

Beide statements zijn op een proeftabel geverifieerd. Zonder index werkt `related`
nog steeds; het is een seq-scan over je eigen corpus in plaats van een ANN-zoek.

Alles in één keer, inclusief de app in een container:

```bash
docker compose up -d --build
```

Node 22 is vereist (deze host heeft 18). Zonder Node 22:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm test
```

## API

Alles behalve `/health` vereist `Authorization: Bearer $NOTES_TOKEN`. Zonder
geconfigureerd token weigert de API elk verzoek (fail closed).

| Methode | Pad | Doet |
| --- | --- | --- |
| GET | `/health` | liveness; geen auth |
| GET | `/api/meta` | kinds, counts, en **welke AI-rollen er echt zijn** |
| GET | `/api/notes` | lijst met `kind`, `tag`, `q`, `limit` (max 100), `cursor` |
| POST | `/api/notes` | nieuwe notitie |
| GET | `/api/notes/:id` | de notitie + zijn afgeleide items |
| PATCH | `/api/notes/:id` | titel/body/tags/kind |
| DELETE | `/api/notes/:id` | weg |
| POST | `/api/notes/:id/derive` | vraagt de summary-rol om tags + samenvatting; schrijft naar `derived_items` |
| POST | `/api/derived/:id/accept` · `/dismiss` | jouw oordeel over afgeleide uitvoer |

Zoeken filtert, recentheid ordent: `q` matcht full-text én substring, maar de
volgorde blijft `updated_at desc` — één pagineringsmodel, ook tijdens het zoeken,
met een keyset-cursor (`next_cursor` in het antwoord).

## Tests

```bash
npm run test:unit          # geen database nodig
npm run test:integration   # vereist DATABASE_URL naar een lege database
```

Unit-tests dekken de cursor, de rolresolutie en de derivatie-service (met een
nep-provider). De integratietests praten met een echte Postgres via
`app.inject()` — inclusief de invariant die er het meest toe doet: na een
derivatie is de notitie zelf byte-identiek.
