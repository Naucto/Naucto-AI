# Naucto AI

A shared MCP service that lets an assistant (Claude Code, Codex, any MCP client) work on a Naucto
project, plus the specialist-model plumbing for sprites, music and sound effects.

The assistant **proposes**; a person **applies**. Every change is an immutable proposal that a
project editor inspects in Naucto, where applying it pauses every open editor, merges their exact
state, and commits one result. Nothing the assistant does can approve, publish, delete or manage a
project.

```
Claude / Codex ──MCP (HTTP, project token)──▶ Naucto-AI ──▶ Backend (/ai/mcp/*)
                                                 │               ▲
                                                 ▼               │ review, apply, revert
                          ZeroGPU Space / PixelLab    Frontend editor (every open tab)
```

## Repositories

```
EIP/
  Backend/    feat/naucto-ai  — proposals, barrier, jobs ledger, provenance (NestJS + Prisma)
  Frontend/   feat/naucto-ai  — AI dialog, previews, catalog/locks, MIDI import, badges (Angular)
  Naucto-AI/  this repository — MCP service, generation queue, ZeroGPU Space
```

`src/midi.ts` is a verbatim copy of `Frontend/packages/engine/src/sound/midi.ts`, so the editor's
MIDI import and the service's conversion of generated MIDI are the same code. `npm run sync:shared`
copies it; a test fails when the two drift.

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
| `design_sfx`, `vary_pattern`, `convert_midi` | Native, editable sound drafts; MIDI with a loss report |
| `request_generation`, `get_generation`, `cancel_generation` | Specialist model jobs (below) |
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

Each kind picks a provider (`NAUCTO_<KIND>_PROVIDER`), see [`providers/README.md`](providers/README.md):

- **`space`** (default): Naucto's own ZeroGPU Space in `providers/space` — text2midi, SDXL with a
  pixel-art LoRA, Stable Audio Open. Free to host; GPU time comes from the daily ZeroGPU quota of
  `HF_TOKEN`'s account (5 min free, 40 min with PRO at $9/month).
- **`pixellab`**: PixelLab's pixel-art API for sprites (subscription).
- **`endpoint`**: any HTTPS service speaking the same contract, e.g. a paid Inference Endpoint.

`scripts/build-space.sh` assembles the Space; `npm run evaluate -- <sprite|midi|sample> <count>`
checks what survives conversion. Check each model's licence before publishing games made with it.

## Checks

```sh
npm run typecheck && npm test          # service, contracts, queue, MCP over HTTP, stub endpoints
npm run test:providers                 # Space conversions and request validation (numpy + Pillow)
```

End to end against running services (a disposable database; the stub endpoints for generation):

```sh
NAUCTO_BACKEND_URL=http://127.0.0.1:3057 NAUCTO_MCP_URL=http://127.0.0.1:3100/mcp npx tsx scripts/live-e2e.ts
```

Backend: `AI_INTEGRATION=1 DATABASE_URL=<disposable> npm test -- --runInBand --coverage=false src/routes/ai`.
Frontend: `npx playwright test e2e/ai.spec.ts`.

## Known limits

- Coordination assumes every collaborator runs a build with AI support; older builds block applying.
- Platformer validation is a bounded approximation of the reference physics, not of arbitrary Lua.
- Generated-model quality is unmeasured until the Space is deployed and `npm run evaluate` is run.
- One service replica dispatches jobs; scale it with the Backend's ledger in mind.
