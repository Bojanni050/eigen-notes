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

Drie routes, alle drie met dezelfde app-code en dezelfde modellen. Kies er één.

**1. Alles in Docker** (een commando, niets anders nodig dan Docker):

```bash
cp .env.example .env          # zet NOTES_TOKEN erin
docker compose up -d          # db + llm-chat + llm-embed + models + api
open http://127.0.0.1:8899    # of curl; alles behalve /health vraagt de token
```

Bij de eerste start worden de twee modellen (~2,5 GB) in het eigen volume
gedownload; daarna is het idempotent.

**2. Native op Linux/macOS** (geen Docker; llama.cpp en Node lokaal):

```bash
npm ci
./scripts/fetch-llama-server.sh   # llama.cpp voor deze machine, vastgepinde tag
./scripts/serve-models.sh         # start beide modelservers op 11500/11501
cp .env.example .env              # DB_BACKEND=pglite hoeft geen server te hebben
npm run start:local               # leest .env via node --env-file-if-exists
```

Modellen? Of ze uit het Docker-volume halen (zie `scripts/serve-models.sh`), of
`MODELS_DIR` naar een map met de twee GGUF-bestanden wijzen.

**3. Windows** — zie [Windows](#windows) hieronder: één script,
`.\start-windows.ps1`, regelt Node-controle, modellen, llama.cpp en de app.

### De modelservers

Twee llama.cpp-processen, want één server bedient één model en een
embedding-model hoort in embedding-modus met CLS-pooling:

| Rol | Model | Waarom |
| --- | --- | --- |
| embeddings | `bge-m3` (Q8_0 GGUF) | meertalig — je notities zijn Nederlands — 1024 dimensies, CLS-pooling |
| chat | `qwen2.5-3b-instruct` (Q4_K_M GGUF) | tags + samenvatting, en de rerank die per treffer een reden geeft |

Geen Ollama, geen daemon met een eigen model-registry: één binary en een
GGUF-bestand. Dat is precies waarom de Windows-versie alleen die twee bestanden
hoeft te downloaden (`scripts/fetch-llama-server.ps1`, vastgepinde tag) in plaats
van een model-runtime te installeren. Een model wisselen = de download in
`scripts/fetch-models.sh`/`.ps1` én het `-m`-pad in de serveerscripts aanpassen;
de app meldt daarna eerlijk welke rollen er zijn via `GET /api/meta`.

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

## Database: Postgres of PGlite

De app heeft één database-interface (`query`, `transaction`, `end`), en daar zijn
twee implementaties op: `postgres` (de compose-stack, of elke echte server) en
`pglite` — dezelfde Postgres, naar wasm gecompileerd, in één map op schijf, zonder
iets te installeren.

```
DB_BACKEND=postgres    # DATABASE_URL doet de rest
DB_BACKEND=pglite      # DB_DIR=./data/pglite, klaar
```

PGlite is Postgres 18 met **pgvector** en **pg_trgm** erbij geladen, dus alle vier
de migraties, de full-text search, de `updated_at`-trigger en het vectorzoeken met
`<=>` werken er onveranderd op. Wat er niet werkt is de HNSW-index op een
dimensieloze kolom — precies zoals op een echte server (`column does not have
dimensions`), dus dezelfde eenmalige `ALTER` hierboven geldt voor beide.

Eén ding om te weten: een relatieve `DB_DIR` hangt aan de map waarin je start.
Draai je de app vanuit een map waar je geen schrijfrechten hebt (bijvoorbeeld een
`data/` die eerder door Docker als root is aangemaakt), zet `DB_DIR` dan ergens
anders.

## Windows

Downloaden, uitpakken, één script:

```powershell
.\start-windows.ps1
```

Dat script doet de hele rij en slaat over wat er al staat, dus een tweede keer
starten is snel:

1. controleert Node (22 of nieuwer) en zegt waar je het haalt als het ontbreekt;
2. `npm ci`;
3. schrijft `.env` als die er nog niet is — met een **gegenereerd** token in plaats
   van een bekend voorbeeldtoken, en `DB_BACKEND=pglite` zodat er geen Postgres
   nodig is;
4. haalt de twee modellen op (~2,5 GB) en een llama.cpp-build voor Windows;
5. start beide modelservers en wacht tot ze antwoorden;
6. start de app op `http://127.0.0.1:8899`.

Ctrl-C stopt de app en beide modelservers. Losse onderdelen:
`.\scripts\fetch-models.ps1`, `.\scripts\fetch-llama-server.ps1 -Variant vulkan`
(ook `cuda-13.5`, `cuda-12.4`, `sycl`), `.\scripts\serve-models.ps1`.

Wat hieraan **geverifieerd** is en wat niet, want dat verschil hoort er te staan:
het PGlite-pad, de bash-scripts en de hele keten eroverheen zijn op Linux
end-to-end gedraaid (migraties, derive, embed, related, herstart en persistentie);
de PowerShell-scripts zijn gecontroleerd op syntaxis onder pwsh 7.4.2 en de
`.env`-generatie is los getest, maar Windows zelf is nog niet gedraaid. De
zip-structuur van de llama.cpp-release (`llama-server.exe` op het hoogste niveau)
is wel echt nagekeken.

Node 22 is vereist voor alles (deze host heeft 18). Zonder Node 22 op de host:

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
| POST | `/api/notes/:id/embed` | laat de embed-rol een vector maken en bewaart die naast de notitie |
| GET | `/api/notes/:id/related` | buren op afstand, en met de `related`-rol ook per treffer een reden |
| POST | `/api/derived/:id/accept` · `/dismiss` | jouw oordeel over afgeleide uitvoer |

Zoeken filtert, recentheid ordent: `q` matcht full-text én substring, maar de
volgorde blijft `updated_at desc` — één pagineringsmodel, ook tijdens het zoeken,
met een keyset-cursor (`next_cursor` in het antwoord).

## Tests

```bash
npm run test:unit          # geen database nodig
npm run test:integration   # DATABASE_URL = echte Postgres, zonder = PGlite
npm run test:pglite        # forceert PGlite
```

Unit-tests dekken de cursor, de rolresolutie, de providers en de embed-service
(met nep-providers). De integratietests draaien de **echte** server via
`app.inject()` tegen een echte database: alle migraties, de `updated_at`-trigger,
de keyset-cursor, de auth-hook en de invariant die er het meest toe doet — na een
derivatie is de notitie zelf byte-identiek, ook met een reranker ernaast.

Staat `DATABASE_URL` niet gezet, dan pakt de suite PGlite in een tijdelijke map:
dezelfde 13 tests, dezelfde SQL, geen server om te installeren. Dat is wat
`npm test` op een verse checkout laat werken, Windows inbegrepen.
