# Specialist endpoints

The service calls one HTTPS endpoint per asset kind with `Authorization: Bearer $HF_TOKEN` and
refuses redirects. A kind is enabled only when `HF_<KIND>_ENDPOINT` and `HF_<KIND>_MODEL` (the model
identifier and revision recorded as provenance, e.g. `amaai-lab/text2midi@<commit>`) are both set.

Only the prompt and the asset's constraints are sent. Responses are capped at 2 MiB, validated, and
converted into Naucto's formats; provider error text is never stored.

## Contract

| Kind | Request `parameters` | Response |
|---|---|---|
| `sprite` | `width`, `height` (8–64), `palette` (16 `#rrggbb`) | `{"width","height","pixels":[0–15, row-major]}` — index 0 is transparent |
| `midi` | `max_beats` | `{"midiBase64": "<Standard MIDI File>"}` |
| `sample` | `seconds` (≤ 1), `sample_rate: 8000` | `{"pcm8Base64": "<signed 8-bit mono>", "sampleRate": 8000}` — ≤ 8192 bytes |

Every request body is `{"inputs": "<prompt>", "parameters": {…}}`.

## Handlers

Each folder is a [custom handler](https://huggingface.co/docs/inference-endpoints/guides/custom_handler)
repository: copy `common/naucto_formats.py` beside `handler.py` before pushing.

- `text2midi/` — [amaai-lab/text2midi](https://huggingface.co/amaai-lab/text2midi) (Apache-2.0).
  Also copy `model/transformer_model.py` from the upstream GitHub repository at a pinned commit, and
  set `TEXT2MIDI_REVISION`. The model has no hosted Inference Provider; it needs this endpoint.
- `sprite/` — any diffusers text-to-image checkpoint (`SPRITE_BASE_MODEL`, optional `SPRITE_LORA`).
  The handler box-downsamples to the requested size and quantizes onto the game palette, treating
  alpha and the corner colour as transparent. Judge candidates on this *quantized* output.
- `sample/` — any diffusers text-to-audio pipeline (`SAMPLE_MODEL`), trimmed, normalised and
  resampled to 8 kHz with a fade-out. Many audio models are non-commercial: check the licence.

`npm run test:providers` exercises the conversions without a GPU. `scripts/stub-endpoint.ts` answers
the contract with fixed assets for local development; never configure it in production.

## Choosing models

```sh
HF_TOKEN=… HF_MIDI_ENDPOINT=… HF_MIDI_MODEL=… npm run evaluate -- midi 5
```

prints, per prompt, whether the output survived conversion (notes imported vs dropped, peak voices;
sprite coverage and colours; sample length). Compare cost per *usable* asset, not per call. The
adapter is endpoint-generic, so a Replicate or fal deployment speaking the same contract works too.

## Operation

- Default limits: 2 concurrent requests per service, `AI_JOBS_PER_PROJECT_HOUR` (20) per project,
  five-minute timeout, no automatic retries.
- Cancelling a queued job prevents dispatch; cancelling a running one aborts the request and the
  Backend discards any late result, but the provider may already have done (and billed) the work.
- A job lost with the service is failed by the Backend after ten minutes, never resubmitted.
