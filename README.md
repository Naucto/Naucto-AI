# Naucto AI

A shared MCP service that lets an assistant (Claude Code, Codex, any MCP client) work on a Naucto
project: read it, draw sprites and compose sound with tools that show the result as pictures, and
propose changes. PixelLab can be asked for a second opinion on sprites.

The assistant **proposes**; a person **applies**. Every change is an immutable proposal that a
project editor inspects in Naucto, in the assistant's own section of the GAME tab. Accepting sends
the document as the accepting person has it, so the change merges into what they are looking at
rather than replacing it, and nobody's editor is paused, unmounted or interrupted. Nothing the
assistant does can approve, publish, delete or manage a project.

```
Claude / Codex ──MCP (HTTP, project token)──▶ Naucto-AI ──▶ Backend (/ai/mcp/*)
                                                 │               ▲
                                                 ▼               │ review, apply, revert
                              PixelLab (sprites)      Frontend editor (every open tab)
```

## Repositories

```
EIP/
  Backend/    feat/naucto-ai  — proposals, apply, jobs ledger, provenance (NestJS + Prisma)
  Frontend/   feat/naucto-ai  — assistant panel, previews, catalog/locks, music import, badges (Angular)
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
4. In a project, open **GAME → Connect / rotate token**. The token is scoped to that project and
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

   A long-lived assistant key works the same way: `Authorization: Bearer naucto_k_…`, plus
   `X-Naucto-Project` when it covers more than one project. `NAUCTO_KEY` exists for a single-user
   local client that cannot hold a credential; it is used only for a request with no
   `Authorization` header, and the service will not start with it set unless `HOST` is loopback.
   A credential it does not recognise is refused rather than answered with the server's own.

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
operation against the document the accepting person actually had, not against a copy taken when the
proposal was written; a change to anything that moved underneath it is refused rather than merged
over. That means a proposal written against a stale read has to be redone, which `read_project` will
tell you is the case by its `stateAgeMs`.

| Operation | Notes |
|---|---|
| `code` | Whole file `before` (exact current text) → `after` |
| `pixels` | `{x, y, before, after}` palette indices on a sheet |
| `tiles` | `{x, y, before, assetId}` (a catalogued 8×8 tile, re-resolved at apply) or `{…, sprite}` |
| `catalog` | `before`/`after` entry; `null` adds or removes. Kinds: tile, sprite (≤64×64), animation (frames + fps), section (map region), music, sfx. Fingerprints must match the artwork |
| `sound` | A new MUSIC or SFX bundle in unused slots: `instruments`, `patterns`, optional `samples` (base64 signed 8-bit mono, 8 kHz, ≤ 8192 bytes) and `song` |
| `create_map` | A new level of catalogued tiles (`assets`, row-major, `null` = empty) with its brief in `ai.levels` |
| `resize_map` | Grow or shrink; shrinking may only remove empty cells |
| `net_permissions` | A `net.state` path, with `clientRead`/`clientWrite` and the value a session starts it at. `propose_changes` fills in `expect` from the state it read; a declaration somebody changed in the meantime is refused rather than overwritten |

### Several projects at once

A key can be linked to more than one game. The Backend will not guess which one a request means, so
a session that has not chosen works on none of them: `list_projects` shows every project the key
reaches, which one the session is on, how old that project's state is and how many changes are
waiting there, and everything else refuses with a message naming `use_project`. `use_project` then
picks the game, and the choice holds for the rest of the session — including across the separate
HTTP requests an MCP session is made of — so one conversation can move between the projects a key
reaches. A project id the key may not open is refused at the choice, before anything is sent on.

The choice is per conversation, not per key. An id is issued in the `mcp-session-id` header of the
`initialize` response, which is the only way a client comes to send one, so two conversations on
one key do not steer each other. A client that sends no `mcp-session-id` at all — a hand-rolled one,
or a proxy that strips it — is treated as a single conversation on that key, so a second one would
inherit the first's choice until the process restarts.

A client's own `X-Naucto-Project` header still takes precedence, and an 8-hour project token is
pinned to its single project: the Backend refuses a hint that contradicts one, so `use_project`
reports that refusal rather than appearing to switch.

These eight are what this tool accepts. The Backend understands two more — `delete_map` and
`delete_sound` — which it refuses to revert, because a deleted level or sound cannot be described
well enough to put back. Nothing here can submit them, so a change that removes artwork is out of
reach of the assistant by design.

**Locked regions** (set by people in *Catalog & locks*) are never written. **Catalog annotations**
are human metadata: they never mark artwork as AI-made, and gameplay semantics other than
`unconfirmed` are only set by people.

## Applying, conflicts and recovery

Approving a proposal *is* applying it. The accepting editor sends its document, the operations are
validated and merged into it, and the merged state comes back to be applied locally — the same
update y-webrtc already carries, so every other tab in the session receives it over the ordinary
sync. Because a whole state is returned rather than a difference cut against the accepting tab, a
collaborator that has not yet received the acceptor's own keystrokes still gets the change whole.

A refusal means the document moved underneath the proposal: the text a `code` operation expected is
not the text there, a declaration is not the one that was read, or a locked region is in the way.
Redo it from a fresh `read_project`. If two people accept the same proposal, one of them is told it
was already reviewed; the other gets the change.

## Reverts and recovery

**Reverts** are proposals too. The inverse of every operation is captured from the merged state at
commit, so a revert restores exactly what was replaced — and refuses if anyone changed it since.
Created levels and sound bundles are removed only while untouched. A proposal that deleted a level or
emptied a sound slot cannot be reverted at all, because there is no description of what to put back;
the Backend says so and points at version history.

## Provenance

Applied proposals add CODE, SPRITES, MAPS, MUSIC or SFX to the project, derived by the Backend from
the stored operations (never from the client). People can also declare AI assistance used
elsewhere. Categories only grow: reverting keeps the history. Publishing copies them to the
release; the game page and cards show them. MIDI a person imports is not AI provenance.

## Specialist generation

Jobs live in the Backend (`AiJob`): quota and cancellation are enforced there, editors see and cancel
them in **GAME → Generation**, and only this service (holding `AI_SERVICE_SECRET`) can store a
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
