#!/usr/bin/env bash
# Assembles the ZeroGPU Space into build/space, ready to push to a Hugging Face Space repository:
#
#   scripts/build-space.sh
#   git clone https://huggingface.co/spaces/<org>/<name> /tmp/space
#   cp -r build/space/. /tmp/space/ && cd /tmp/space && git add -A && git commit -m build && git push
#
# The upstream text2midi model code is fetched at a pinned commit and checked against its hash, so
# the Space runs exactly the code that was reviewed.
set -euo pipefail
cd "$(dirname "$0")/.."

TEXT2MIDI_COMMIT=f3245ee402b29ba00b86c6eb9813032f3f05954f
TEXT2MIDI_SHA256=f64c6d8e8c3bf2fa7c8af80e2749d2c05133ea76494d394c16f079a139aa399d

rm -rf build/space
mkdir -p build/space/model
cp providers/space/app.py providers/space/requirements.txt providers/space/README.md build/space/
cp providers/common/naucto_formats.py build/space/
curl -fsSL "https://raw.githubusercontent.com/AMAAI-Lab/Text2midi/${TEXT2MIDI_COMMIT}/model/transformer_model.py" \
  -o build/space/model/transformer_model.py
echo "${TEXT2MIDI_SHA256}  build/space/model/transformer_model.py" | sha256sum -c --quiet
touch build/space/model/__init__.py
echo "build/space is ready ($(ls build/space | tr '\n' ' '))"
