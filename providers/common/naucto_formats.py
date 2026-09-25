"""Conversions into Naucto's native asset formats, shared by the endpoint handlers.

Pure numpy/Pillow so they can be tested on a laptop without the models.
"""
from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image

MAX_SAMPLE_BYTES = 8192
SAMPLE_RATE = 8000


def hex_to_rgb(colour: str) -> tuple[int, int, int]:
    value = colour.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"not a #rrggbb colour: {colour}")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def quantize_sprite(image: Image.Image, width: int, height: int, palette: list[str]) -> list[int]:
    """Resize to the sprite's native size and map every pixel onto the game's 16 colours.

    Index 0 is Naucto's transparent colour: fully transparent pixels, and pixels matching the
    image's background (the colour of its four corners, when they agree), map to it. Opaque pixels
    only ever take indices 1-15, so artwork never punches holes in itself.
    """
    if len(palette) != 16:
        raise ValueError("Naucto palettes have 16 colours")
    rgba = image.convert("RGBA")
    # Box filtering averages each source block; nearest would pick one arbitrary pixel of it.
    small = np.asarray(rgba.resize((width, height), Image.Resampling.BOX), dtype=np.float32)
    rgb, alpha = small[..., :3], small[..., 3]
    corners = np.array([rgb[0, 0], rgb[0, -1], rgb[-1, 0], rgb[-1, -1]])
    background = corners[0] if np.all(np.abs(corners - corners[0]).max(axis=1) < 24) else None
    colours = np.array([hex_to_rgb(c) for c in palette[1:]], dtype=np.float32)
    # Perceptual-ish weighting: the eye separates green best and blue worst.
    weights = np.array([0.30, 0.59, 0.11], dtype=np.float32)
    distance = (((rgb[:, :, None, :] - colours[None, None, :, :]) ** 2) * weights).sum(axis=-1)
    indices = distance.argmin(axis=-1) + 1
    transparent = alpha < 128
    if background is not None:
        transparent |= np.abs(rgb - background).max(axis=-1) < 24
    indices[transparent] = 0
    return [int(v) for v in indices.reshape(-1)]


def to_sample(audio: np.ndarray, source_rate: int, seconds: float) -> str:
    """Mono-mix, trim, resample to 8 kHz and encode as base64 signed 8-bit, within 8192 bytes."""
    if audio.ndim == 2:
        audio = audio.mean(axis=0 if audio.shape[0] < audio.shape[1] else 1)
    audio = audio.astype(np.float64)
    wanted = min(int(seconds * SAMPLE_RATE), MAX_SAMPLE_BYTES)
    # Linear resampling at a low target rate; the console's aliasing is part of its sound.
    positions = np.arange(wanted) * (source_rate / SAMPLE_RATE)
    positions = positions[positions < len(audio) - 1]
    resampled = np.interp(positions, np.arange(len(audio)), audio)
    peak = np.abs(resampled).max() if len(resampled) else 0.0
    if peak > 0:
        resampled = resampled / peak
    # A short fade keeps a trimmed tail from ending on a click.
    fade = min(64, len(resampled))
    if fade:
        resampled[-fade:] *= np.linspace(1.0, 0.0, fade)
    pcm = np.clip(np.round(resampled * 127), -127, 127).astype(np.int8)
    if not len(pcm):
        raise ValueError("no audio")
    return base64.b64encode(pcm.tobytes()).decode("ascii")


def parse_request(kind: str, prompt: object, params_json: object) -> dict:
    """Validate what the Naucto service sends, before any GPU time is spent on it."""
    import json

    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 2000:
        raise ValueError("prompt must be 1-2000 characters")
    try:
        params = json.loads(params_json) if isinstance(params_json, str) and params_json else {}
    except json.JSONDecodeError as error:
        raise ValueError("parameters must be JSON") from error
    if not isinstance(params, dict):
        raise ValueError("parameters must be an object")
    out: dict = {"prompt": prompt.strip()}
    seed = params.get("seed")
    if seed is not None:
        if not isinstance(seed, int) or not 0 <= seed < 2**31:
            raise ValueError("seed must be a non-negative integer")
        out["seed"] = seed
    if kind == "sprite":
        width, height, palette = params.get("width"), params.get("height"), params.get("palette")
        if not all(isinstance(v, int) and 8 <= v <= 64 for v in (width, height)):
            raise ValueError("width and height must be 8-64")
        if not isinstance(palette, list) or len(palette) != 16:
            raise ValueError("palette must have 16 colours")
        for colour in palette:
            hex_to_rgb(colour)
        out.update(width=width, height=height, palette=palette)
    elif kind == "midi":
        beats = params.get("max_beats", 256)
        if not isinstance(beats, int) or not 1 <= beats <= 256:
            raise ValueError("max_beats must be 1-256")
        out["max_beats"] = beats
    elif kind == "sample":
        seconds = params.get("seconds", 1.0)
        if not isinstance(seconds, (int, float)) or not 0.05 <= seconds <= 1.0:
            raise ValueError("seconds must be 0.05-1")
        out["seconds"] = float(seconds)
    else:
        raise ValueError(f"unknown kind {kind}")
    return out


def midi_bytes_to_base64(data: bytes) -> str:
    if data[:4] != b"MThd":
        raise ValueError("not a Standard MIDI File")
    if len(data) > 262144:
        raise ValueError("MIDI exceeds 256 KiB")
    return base64.b64encode(data).decode("ascii")


def png_to_image(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data))
