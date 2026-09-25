"""Hugging Face Inference Endpoint handler: prompt -> Naucto sprite (palette indices).

Generates with a diffusers text-to-image pipeline, then box-downsamples and quantizes onto the
game's 16-colour palette, index 0 transparent. The base model and optional pixel-art LoRA are
configuration: evaluate candidates on the *quantized* output (see scripts/evaluate.ts), and check
each model's licence before using it for a public game.
"""
import os
from typing import Any

import torch
from diffusers import AutoPipelineForText2Image

from naucto_formats import quantize_sprite

BASE = os.environ["SPRITE_BASE_MODEL"]  # e.g. an SDXL-class checkpoint
LORA = os.environ.get("SPRITE_LORA")  # optional pixel-art LoRA repository
REVISION = os.environ.get("SPRITE_REVISION")
STEPS = int(os.environ.get("SPRITE_STEPS", "30"))
STYLE = os.environ.get("SPRITE_STYLE", "pixel art, single game sprite, flat colours, plain background")


class EndpointHandler:
    def __init__(self, path: str = "") -> None:
        dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        self.pipe = AutoPipelineForText2Image.from_pretrained(BASE, revision=REVISION, torch_dtype=dtype)
        if LORA:
            self.pipe.load_lora_weights(LORA)
        self.pipe.to("cuda" if torch.cuda.is_available() else "cpu")

    def __call__(self, data: dict[str, Any]) -> dict[str, Any]:
        prompt = data.get("inputs")
        params = data.get("parameters", {})
        width, height, palette = int(params["width"]), int(params["height"]), params["palette"]
        if not isinstance(prompt, str) or not (8 <= width <= 64 and 8 <= height <= 64) or len(palette) != 16:
            raise ValueError("expected a prompt, an 8-64 pixel size and a 16-colour palette")
        seed = params.get("seed")
        generator = torch.Generator().manual_seed(int(seed)) if seed is not None else None
        image = self.pipe(
            prompt=f"{prompt}, {STYLE}",
            negative_prompt="blurry, gradient, photo, text, watermark, multiple objects",
            num_inference_steps=STEPS,
            generator=generator,
        ).images[0]
        return {"width": width, "height": height, "pixels": quantize_sprite(image, width, height, palette)}
