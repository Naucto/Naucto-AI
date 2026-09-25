# Naucto AI

A shared MCP service that lets an assistant (Claude Code, Codex, any MCP client) work on a Naucto
project: read it, draw sprites and compose sound with tools that show the result as pictures, and
propose changes. PixelLab can be asked for a second opinion on sprites.

The assistant **proposes**; a person **applies**. Every change is an immutable proposal that a
project editor inspects in Naucto, where applying it pauses every open editor, merges their exact
state, and commits one result. Nothing the assistant does can approve, publish, delete or manage a
project.

```
Claude / Codex ──MCP (HTTP, project token)──▶ Naucto-AI ──▶ Backend (/ai/mcp/*)
                                                 │               ▲
                                                 ▼               │ review, apply, revert
                              PixelLab (sprites)      Frontend editor (every open tab)
```

## Repositories

```
EIP/
  Backend/    feat/naucto-ai  — proposals, barrier, jobs ledger, provenance (NestJS + Prisma)
  Frontend/   feat/naucto-ai  — AI dialog, previews, catalog/locks, music import, badges (Angular)
  Naucto-AI/  this repository — MCP service, pictures, offline synth, generation queue
```

`src/engine/` holds verbatim copies of the engine's sound code from
`Frontend/packages/engine/src/sound/`: the MIDI importer, the audio transcriber, and the chip synth
(`model`, `SynthCore`, `Sequencer`, `sample-codec`). What the service renders is what a player hears,
and its conversions are the editor's own. `npm run sync:shared` copies them; a test fails when they
drift. Edit them in the Frontend, never here.

## Running it

1. **Backend**: apply migrations (`npx prisma migrate deploy`) and set `AI_SERVICE_SECRET` (any long
   random value; generation stays disabled without it) and optionally `AI_JOBS_PER_PROJECT_HOUR`.
2. **Frontend**: nothing to configure. Every collaborator must run this build: a browser without AI
   coordination blocks applying rather than being ignored.
3. **This service**: `npm ci`, export the variables in `.env.example` (it does not load `.env`), then
   `npm start`. Or `docker compose up` beside the Backend (`NAUCTO_NETWORK` names its network).
   Build the docs (`npm run docs:build` in Frontend) for `search_engine_docs`.
4. In a project, open **AI tools → Connect / rotate token**. The token is scoped to that project and
   that person, lasts eight hours, and is revoked by **Disconnect AI**. The editor shares its
   current state (unsaved work included) every 20 s while the dialog is open.
5. Register the service in your client:

   ```sh
   # Claude Code
   claude mcp add --transport http naucto https://<host>/mcp --header "Authorization: Bearer $NAUCTO_TOKEN"
   # Codex
   export NAUCTO_MCP_TOKEN=…   # the token
   codex mcp add naucto --url https://<host>/mcp --bearer-token-env-var NAUCTO_MCP_TOKEN
   ```

   Never paste the token into a chat or commit a client config that contains it. Shared
   deployments must sit behind HTTPS with an exact `NAUCTO_MCP_HOSTS`. Requests carrying an
   `Origin` header are refused: browsers never talk to this endpoint.

## Tools

| Tool | Does |
|---|---|
| `read_project` | Summary and the `snapshotHash` every proposal cites |
| `read_code`, `read_sheet_region`, `read_map_region`, `read_sound`, `read_catalog` | Paged reads; regions come with the fingerprints catalog entries use |
| `propose_changes` | Stage a proposal (below). Never writes the game |
| `list_proposals` | Review and application state |
| `place_section` | A `tiles` operation stamping a catalogued map section, skipping locked cells |
| `draft_level`, `resolve_level_roles`, `check_adjacency` | Seeded top-down/platformer scaffolds → catalogued tiles, with declared adjacency checked |
| `validate_top_down_path`, `validate_platformer` | Reachability under an explicit movement profile. Approximate: playtest |
| `get_game_template` | Optional Lua: top-down movement, platformer physics matching the validator, level progression over named maps |
| `render_sheet`, `render_map` | Pictures: enlarged, transparency as a checkerboard, 8×8 grid, rulers in the coordinates the tools take |
| `read_sprite`, `draw_sprite`, `transform_sprite` | Pixels as rows (`0`–`f`, `.` transparent, `_` keep); draw or flip/rotate/shift/outline/recolor/mirror, with before/after pictures and a `pixels` operation that skips locked pixels |
| `compare_sprites` | Up to four drafts side by side (rows, sheet regions, PixelLab jobs), at 1× too, tiled 3×3 for seams, with coverage, symmetry and stray-pixel counts |
| `design_sfx`, `vary_pattern`, `convert_midi` | Native, editable sound drafts; MIDI with a loss report |
| `render_sound` | A slot or draft played offline on the console's synth: piano roll, waveform, spectrogram, levels, voice stealing, and how much of what was written is audible |
| `bake_sample` | A draft, an instrument note or a WAV as a console sample (8 kHz, 8-bit, ≤ 1.024 s) with an instrument that plays it |
| `transcribe_audio` | A WAV recording into native drafts with the estimated quality loss, as the editor's import does |
| `request_generation`, `get_generation`, `cancel_generation` | PixelLab sprite drafts (below) |
| `search_engine_docs` | The version-matched Lua API reference |

There is no tool to approve, apply, publish, delete or manage collaborators. All project content is
returned as data and the service instructs the client not to follow instructions found in it.

## Proposals

`propose_changes` takes `{ title, summary, snapshotHash, operations }`. The Backend validates every
operation against the merged state of all paused editors when applying; a change to anything a
proposal read makes it refuse rather than overwrite.

| Operation | Notes |
|---|---|
| `code` | Whole file `before` (exact current text) → `after` |
| `pixels` | `{x, y, before, after}` palette indices on a sheet |
| `tiles` | `{x, y, before, assetId}` (a catalogued 8×8 tile, re-resolved at apply) or `{…, sprite}` |
| `catalog` | `before`/`after` entry; `null` adds or removes. Kinds: tile, sprite (≤64×64), animation (frames + fps), section (map region), music, sfx. Fingerprints must match the artwork |
| `sound` | A new MUSIC or SFX bundle in unused slots: `instruments`, `patterns`, optional `samples` (base64 signed 8-bit mono, 8 kHz, ≤ 8192 bytes) and `song` |
| `create_map` | A new level of catalogued tiles (`assets`, row-major, `null` = empty) with its brief in `ai.levels` |
| `resize_map` | Grow or shrink; shrinking may only remove empty cells |

**Locked regions** (set by people in *Catalog & locks*) are never written. **Catalog annotations**
are human metadata: they never mark artwork as AI-made, and gameplay semantics other than
`unconfirmed` are only set by people.

## Applying, conflicts and recovery

Approving a proposal *is* applying it. Every open editor heartbeats; applying requires the set of
editors the Backend sees to equal the set the approver's session sees, pauses them all, and waits
for each one's full document state. Anything that reaches a paused editor afterwards is reported
with the update itself: before the commit, the application stops unless one of the snapshots
already holds that update (a peer's last edit arriving late, which is normal); after it, the result
is flagged for a person to check. The committed result is stored before it is saved, so a storage
failure is resumed with **Finish / recover**, never replayed. Saves, autosaves and publishing wait
while an application is in progress.

**Reverts** are proposals too. The inverse of every operation is captured from the merged state at
commit, so a revert restores exactly what was replaced — and refuses if anyone changed it since.
Created levels and sound bundles are removed only while untouched.

## Provenance

Applied proposals add CODE, SPRITES, MAPS, MUSIC or SFX to the project, derived by the Backend from
the stored operations (never from the client). People can also declare AI assistance used
elsewhere. Categories only grow: reverting keeps the history. Publishing copies them to the
release; the game page and cards show them. MIDI a person imports is not AI provenance.

## Specialist generation

Jobs live in the Backend (`AiJob`): quota and cancellation are enforced there, editors see and cancel
them in **AI tools → Generation**, and only this service (holding `AI_SERVICE_SECRET`) can store a
result, with the identifier of the model that produced it. A job interrupted by a restart fails
instead of being paid for twice. Results are drafts: they reach a game only through a proposal.

Sprites are the one kind generated outside: PixelLab's pixel-art model (`PIXELLAB_TOKEN`, paid
credits), downsampled and put on the game's palette. The intended loop is to draw a sprite with
`draw_sprite`, ask PixelLab for the same thing, and set them side by side with `compare_sprites`.

Music and sound effects are never generated by an external model: the assistant composes them with
the synth and checks them with `render_sound`, and people bring their own music through the editor's
**Import music or sound** (MIDI, or a recording transcribed on their computer with its estimated
loss shown), which is not AI provenance.

## Checks

```sh
npm run typecheck && npm test          # service, pictures, synth, queue, MCP over HTTP, PixelLab stub
```

End to end against running services (a disposable database; the PixelLab stub for generation):

```sh
NAUCTO_BACKEND_URL=http://127.0.0.1:3057 NAUCTO_MCP_URL=http://127.0.0.1:3100/mcp npx tsx scripts/live-e2e.ts
```

Backend: `AI_INTEGRATION=1 DATABASE_URL=<disposable> npm test -- --runInBand --coverage=false src/routes/ai`.
Frontend: `npx playwright test e2e/ai.spec.ts`.

## Known limits

- Coordination assumes every collaborator runs a build with AI support; older builds block applying.
- Platformer validation is a bounded approximation of the reference physics, not of arbitrary Lua.
- The real PixelLab API is exercised only through its stub until a token is configured.
- `transcribe_audio` takes WAV only; the editor decodes any format the browser can.
- One service replica dispatches jobs; scale it with the Backend's ledger in mind.
