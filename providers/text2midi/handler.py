"""Hugging Face Inference Endpoint handler: text prompt -> Standard MIDI File (base64).

Wraps amaai-lab/text2midi (Apache-2.0). Deploy as a custom handler repository containing:
  handler.py, requirements.txt, naucto_formats.py (from providers/common),
  model/transformer_model.py (from github.com/AMAAI-Lab/Text2midi, pinned commit).
Contract: see providers/README.md. Naucto converts and validates the MIDI itself.
"""
import os
import pickle
import tempfile
from typing import Any

import torch
from huggingface_hub import hf_hub_download
from transformers import T5Tokenizer

from model.transformer_model import Transformer  # noqa: E402  (upstream Text2midi code)
from naucto_formats import midi_bytes_to_base64

REPO = os.environ.get("TEXT2MIDI_REPO", "amaai-lab/text2midi")
REVISION = os.environ.get("TEXT2MIDI_REVISION")  # pin a commit for reproducible provenance
MAX_LEN = int(os.environ.get("TEXT2MIDI_MAX_LEN", "1024"))


class EndpointHandler:
    def __init__(self, path: str = "") -> None:
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        weights = hf_hub_download(REPO, "pytorch_model.bin", revision=REVISION)
        vocab = hf_hub_download(REPO, "vocab_remi.pkl", revision=REVISION)
        with open(vocab, "rb") as handle:
            self.remi = pickle.load(handle)  # published with the model; pinned by REVISION
        self.model = Transformer(len(self.remi), 768, 8, 2048, 18, 1024, False, 8, device=self.device)
        self.model.load_state_dict(torch.load(weights, map_location=self.device))
        self.model.eval()
        self.text = T5Tokenizer.from_pretrained("google/flan-t5-base")

    def __call__(self, data: dict[str, Any]) -> dict[str, str]:
        prompt = data.get("inputs")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 2000:
            raise ValueError("inputs must be a prompt of at most 2000 characters")
        tokens = self.text(prompt, return_tensors="pt", padding=True, truncation=True)
        with torch.no_grad():
            output = self.model.generate(
                tokens.input_ids.to(self.device),
                tokens.attention_mask.to(self.device),
                max_len=MAX_LEN,
                temperature=float(data.get("parameters", {}).get("temperature", 1.0)),
            )
        score = self.remi.decode(output[0].tolist())
        with tempfile.NamedTemporaryFile(suffix=".mid") as file:
            score.dump_midi(file.name)
            file.seek(0)
            return {"midiBase64": midi_bytes_to_base64(file.read())}
