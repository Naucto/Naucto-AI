# Naucto AI

A shared MCP service that lets an assistant (Claude Code, Codex, any MCP client) work on a Naucto
project: read it, draw sprites and compose sound with tools that show the result as pictures, and
edit an isolated working save. PixelLab can be asked for a second opinion on sprites.

The assistant edits its own **persistent native save**. It never writes the user's project.
`read_project` reads that draft by default; the assistant can inspect the common base and the latest
user save too. `write_code`, `write_pixels`, `write_tiles` and `write_sound` use the shared engine
classes to save immediately. `save_project` also accepts a full native state or editing commands.
There is no `propose_changes` tool anymore. Write/merge results contain only revision/hash metadata;
only an explicit `read_save` exports the full native snapshot, so large samples do not flood every response.

`compare_saves` reports three-way differences; `merge_latest_save` imports independent user changes
and asks for explicit `draft`/`latest` choices on conflicts. A large imported audio bank can be taken
whole, including samples and references. A person reviews the draft against their current document
in a separate editor flow. The Backend exposes preview and prepare/save/confirm APIs for that future
frontend; this change does not implement its UI. After a reviewed result is actually saved, accepted
and rejected work is reset in the AI copy and unreviewed work is retained.

```text
Claude / Codex → MCP → isolated AI save (Backend/PostgreSQL)
                         ↕ compare / three-way merge
                   latest saved user project
                         ↑ human review → ordinary save → confirmation
```

## Repositories

```
EIP/
  Backend/    feat/naucto-ai  — AI/base saves, three-way merge, human review, jobs ledger and provenance (NestJS + Prisma)
  Frontend/   feat/naucto-ai  — legacy proposal UI; new working-save review UI is a separate future integration (Angular)
  Naucto-AI/  this repository — MCP service, pictures, offline synth, generation queue
```

The offline synth, MIDI importer, audio transcriber and sample codec are imported from
`@naucto/engine/sound`, the same engine sources as the Frontend. The Backend reads saved
documents through `@naucto/engine/headless` (`Game` + `aiContext`). Both services pin the same
Node distribution under `vendor/`; there are no copied engine source files to synchronise.
See `vendor/README.md` and the Frontend engine's `pack:node` command to update it.

## Running it

1. **Backend**: apply migrations (`npx prisma migrate deploy`) and set `AI_SERVICE_SECRET` (any long
   random value; generation stays disabled without it) and optionally `AI_JOBS_PER_PROJECT_HOUR`.
2. **Frontend**: unchanged by this backend/MCP migration. The working-save review API is ready
   for a future editor design; the existing UI still reviews historical proposals only.
3. **This service**: `npm ci`, export the variables in `.env.example` (it does not load `.env`), then
   `npm start`. Or `docker compose up` beside the Backend (`NAUCTO_NETWORK` names its network).
   Build the docs (`npm run docs:build` in Frontend) for `search_engine_docs`.
4. In **Settings → Assistant**, create an account key. It belongs to the account, not to a game: it
   reaches every project the account owns, works whether or not anybody has the project open, and is
   revoked from the same page. There is no per-project token and nothing to connect inside a game.
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
| `read_project` | AI draft summary, revision and hash; optional base/latest source |
| `read_code`, `read_sheet_region`, `read_map_region`, `read_sound`, `read_catalog` | Paged reads; regions come with the fingerprints catalog entries use |
| `save_project` | Save native state or editing commands to the isolated AI working copy |
| `write_code`, `remove_code`, `write_pixels`, `write_tiles`, `write_sound` | Direct edits through the shared engine classes |
| `read_save`, `compare_saves`, `merge_latest_save` | Full snapshots, three-way comparison and explicit conflict resolution |
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

## Working saves, merge and review

An account key still selects a project with `list_projects` / `use_project`, independently per MCP
session. It reaches owned projects only. All working-copy writes are revision-checked; two sessions
cannot silently overwrite one another. `read_save` includes the complete base64 Yjs state, including
sample data. Use `source: "draft" | "base" | "latest"` on read tools to compare versions.

Typical loop:

1. `read_project` to inspect the draft and revision; edit with the direct write tools.
2. `compare_saves` to inspect user changes since the common base.
3. `merge_latest_save` with `revision`, the compared `latestHash`, and resolutions for conflicts.
4. Continue editing/rendering your draft. Human acceptance lives outside the MCP.

Units are code files, a graphics bank, a sound bank, network declarations and metadata. Independent
files merge automatically. Sound and graphics are atomic to preserve resource references. For a
same-file code conflict, read draft/latest and rewrite the desired draft before choosing `draft`.
`save_project` accepts either a full snapshot or native editing operations; those operations are
applied immediately to the AI save and do not create proposal records. Raw saves cannot replace
human locks or historical provenance receipts. Limits are 16 MiB decoded per native save and 1 MiB
per code editing operation.

A human review freezes the working copy until the reviewed document is normally saved and confirmed,
or the unsaved review is deliberately cancelled. `pendingReviewId` identifies recovery work. The
assistant cannot confirm, cancel or approve that review, publish or manage the user project.

See `Backend/docs/ai-working-save.md` for the future frontend contract and interruption handling.
Historical proposal rows and human review routes are retained for existing data; the old MCP
proposal-creation endpoint returns 410.

## Specialist generation

Jobs live in the Backend (`AiJob`): quota and cancellation are enforced there, editors see and cancel
them in **GAME → Generation**, and only this service (holding `AI_SERVICE_SECRET`) can store a
result, with the identifier of the model that produced it. A job interrupted by a restart fails
instead of being paid for twice. Results are drafts: they reach a game only through its AI working save and a later human review.

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

- The new working-save review UI is not implemented here; legacy proposal UI only handles historical proposals.
- Collaborators' projects are out of reach: a key covers the projects its account owns.
- Platformer validation is a bounded approximation of the reference physics, not of arbitrary Lua.
- The real PixelLab API is exercised only through its stub until a token is configured.
- `transcribe_audio` takes WAV only; the editor decodes any format the browser can.
- One service replica dispatches jobs; scale it with the Backend's ledger in mind.
