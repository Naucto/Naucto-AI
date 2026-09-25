"""Naucto generators: one ZeroGPU Space serving sprites, MIDI and short sound samples.

Built by `scripts/build-space.sh`, which copies `naucto_formats.py` and the pinned upstream
text2midi model code beside this file. Each generator is enabled by its environment variable
(Space settings → Variables); the ones left unset are neither loaded nor exposed.

API (Gradio): `/gradio_api/call/<kind>` with `data = [prompt, parameters_json]`, answering one JSON
object in Naucto's provider contract (see providers/README.md) plus the `model` that produced it.
GPU time is charged to the ZeroGPU quota of the account whose token calls the Space.
"""
from __future__ import annotations

import os
import pickle
import tempfile

import gradio as gr
import spaces
import torch
from huggingface_hub import hf_hub_download

from naucto_formats import midi_bytes_to_base64, parse_request, quantize_sprite, to_sample, SAMPLE_RATE

DEVICE = "cuda"
MIDI_REPO = os.environ.get("MIDI_MODEL", "")  # e.g. amaai-lab/text2midi
MIDI_REVISION = os.environ.get("MIDI_REVISION") or None
SPRITE_BASE = os.environ.get("SPRITE_MODEL", "")  # e.g. stabilityai/stable-diffusion-xl-base-1.0
SPRITE_LORA = os.environ.get("SPRITE_LORA", "")  # e.g. nerijs/pixel-art-xl
SAMPLE_MODEL = os.environ.get("SAMPLE_MODEL", "")  # e.g. stabilityai/stable-audio-open-1.0 (gated)
STYLE = os.environ.get("SPRITE_STYLE", "pixel art, single game sprite, flat colours, plain white background")


def model_id(repo: str, revision: str | None, extra: str = "") -> str:
    return f"{repo}@{revision or 'main'}{'+' + extra if extra else ''}"


# ---- models are placed on cuda at import time, as ZeroGPU requires ------------------------

midi = None
if MIDI_REPO:
    from transformers import T5Tokenizer

    from model.transformer_model import Transformer  # upstream code, pinned by build-space.sh

    with open(hf_hub_download(MIDI_REPO, "vocab_remi.pkl", revision=MIDI_REVISION), "rb") as handle:
        remi = pickle.load(handle)  # published with the model, pinned by MIDI_REVISION
    net = Transformer(len(remi), 768, 8, 2048, 18, 1024, False, 8, device=DEVICE)
    net.load_state_dict(torch.load(hf_hub_download(MIDI_REPO, "pytorch_model.bin", revision=MIDI_REVISION), map_location=DEVICE))
    net.eval()
    midi = {"net": net, "remi": remi, "text": T5Tokenizer.from_pretrained("google/flan-t5-base")}

sprite = None
if SPRITE_BASE:
    from diffusers import AutoPipelineForText2Image

    sprite = AutoPipelineForText2Image.from_pretrained(SPRITE_BASE, torch_dtype=torch.float16)
    if SPRITE_LORA:
        sprite.load_lora_weights(SPRITE_LORA)
    sprite.to(DEVICE)

sample = None
if SAMPLE_MODEL:
    from diffusers import StableAudioPipeline

    sample = StableAudioPipeline.from_pretrained(SAMPLE_MODEL, torch_dtype=torch.float16).to(DEVICE)


def generator(seed: int | None) -> torch.Generator | None:
    return torch.Generator(DEVICE).manual_seed(seed) if seed is not None else None


# ---- generators ---------------------------------------------------------------------------

@spaces.GPU(duration=120)
def run_midi(prompt: str, params_json: str) -> dict:
    if midi is None:
        raise gr.Error("MIDI generation is not enabled on this Space")
    request = parse_request("midi", prompt, params_json)
    if "seed" in request:
        torch.manual_seed(request["seed"])
    tokens = midi["text"](request["prompt"], return_tensors="pt", padding=True, truncation=True)
    # Roughly eight REMI tokens a beat; the service's importer caps the song length again.
    length = min(2000, request["max_beats"] * 8)
    with torch.no_grad():
        out = midi["net"].generate(tokens.input_ids.to(DEVICE), tokens.attention_mask.to(DEVICE), max_len=length, temperature=1.0)
    score = midi["remi"].decode(out[0].tolist())
    with tempfile.NamedTemporaryFile(suffix=".mid") as file:
        score.dump_midi(file.name)
        file.seek(0)
        return {"midiBase64": midi_bytes_to_base64(file.read()), "model": model_id(MIDI_REPO, MIDI_REVISION)}


@spaces.GPU(duration=60)
def run_sprite(prompt: str, params_json: str) -> dict:
    if sprite is None:
        raise gr.Error("Sprite generation is not enabled on this Space")
    request = parse_request("sprite", prompt, params_json)
    image = sprite(
        prompt=f"{request['prompt']}, {STYLE}",
        negative_prompt="blurry, gradient, photo, text, watermark, multiple objects, border",
        num_inference_steps=25,
        generator=generator(request.get("seed")),
    ).images[0]
    pixels = quantize_sprite(image, request["width"], request["height"], request["palette"])
    return {"width": request["width"], "height": request["height"], "pixels": pixels, "model": model_id(SPRITE_BASE, None, SPRITE_LORA)}


@spaces.GPU(duration=60)
def run_sample(prompt: str, params_json: str) -> dict:
    if sample is None:
        raise gr.Error("Sample generation is not enabled on this Space")
    request = parse_request("sample", prompt, params_json)
    audio = sample(
        request["prompt"],
        negative_prompt="music, speech, low quality",
        num_inference_steps=100,
        audio_end_in_s=max(1.0, request["seconds"]),
        generator=generator(request.get("seed")),
    ).audios[0]
    rate = int(sample.vae.sampling_rate)
    data = to_sample(audio.float().cpu().numpy(), rate, request["seconds"])
    return {"pcm8Base64": data, "sampleRate": SAMPLE_RATE, "model": model_id(SAMPLE_MODEL, None)}


# ---- interface: one tab and one named API route per enabled generator ---------------------

with gr.Blocks(title="Naucto generators") as demo:
    gr.Markdown("Generators for [Naucto](https://github.com/Naucto). Called by the Naucto AI service; "
                "each call uses the caller's ZeroGPU quota.")
    for kind, fn, enabled in (("midi", run_midi, midi), ("sprite", run_sprite, sprite), ("sample", run_sample, sample)):
        if enabled is None:
            continue
        with gr.Tab(kind):
            prompt = gr.Textbox(label="Prompt")
            params = gr.Textbox(label="Parameters (JSON)", value="{}")
            output = gr.JSON(label="Result")
            gr.Button("Generate").click(fn, [prompt, params], output, api_name=kind)

demo.queue(default_concurrency_limit=1, max_size=20).launch(show_error=False)
