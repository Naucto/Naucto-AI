"""Hugging Face Inference Endpoint handler: prompt -> one-second 8 kHz signed 8-bit sample.

Uses a diffusers text-to-audio pipeline chosen by configuration. Many audio models carry
non-commercial licences: confirm the model's licence covers your use before deploying.
"""
import os
from typing import Any

import numpy as np
import torch
from diffusers import DiffusionPipeline

from naucto_formats import SAMPLE_RATE, to_sample

MODEL = os.environ["SAMPLE_MODEL"]
REVISION = os.environ.get("SAMPLE_REVISION")
STEPS = int(os.environ.get("SAMPLE_STEPS", "100"))


class EndpointHandler:
    def __init__(self, path: str = "") -> None:
        dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        self.pipe = DiffusionPipeline.from_pretrained(MODEL, revision=REVISION, torch_dtype=dtype)
        self.pipe.to("cuda" if torch.cuda.is_available() else "cpu")
        # AudioLDM-style pipelines expose their output rate on the vocoder; 16 kHz is their default.
        vocoder = getattr(self.pipe, "vocoder", None)
        self.rate = int(getattr(getattr(vocoder, "config", None), "sampling_rate", 16000))

    def __call__(self, data: dict[str, Any]) -> dict[str, Any]:
        prompt = data.get("inputs")
        seconds = float(data.get("parameters", {}).get("seconds", 1.0))
        if not isinstance(prompt, str) or not 0.05 <= seconds <= 1.0:
            raise ValueError("expected a prompt and 0.05-1 seconds")
        audio = self.pipe(prompt, num_inference_steps=STEPS, audio_length_in_s=max(seconds, 1.0)).audios[0]
        return {"pcm8Base64": to_sample(np.asarray(audio), self.rate, seconds), "sampleRate": SAMPLE_RATE}
