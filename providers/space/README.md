---
title: Naucto generators
emoji: 🎮
colorFrom: purple
colorTo: pink
sdk: gradio
sdk_version: 5.49.1
app_file: app.py
pinned: false
license: apache-2.0
short_description: Sprites, MIDI and sound samples for the Naucto console
models:
  - amaai-lab/text2midi
  - stabilityai/stable-diffusion-xl-base-1.0
  - nerijs/pixel-art-xl
  - stabilityai/stable-audio-open-1.0
---

Generators for [Naucto](https://github.com/Naucto/Naucto-AI), built from `providers/space` by
`scripts/build-space.sh`. Select **ZeroGPU** hardware. Enable generators with Space variables:
`MIDI_MODEL`, `MIDI_REVISION`, `SPRITE_MODEL`, `SPRITE_LORA`, `SAMPLE_MODEL`
(gated: needs an `HF_TOKEN` secret that accepted its licence).

Model licences: text2midi Apache-2.0; SDXL OpenRAIL++; pixel-art-xl CreativeML OpenRAIL-M;
Stable Audio Open — Stability AI Community License (free below USD 1M annual revenue).
