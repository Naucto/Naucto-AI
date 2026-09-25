import base64
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "common"))
from naucto_formats import MAX_SAMPLE_BYTES, midi_bytes_to_base64, quantize_sprite, to_sample  # noqa: E402

PALETTE = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff"] + ["#808080"] * 11


class SpriteTests(unittest.TestCase):
    def test_background_is_transparent_and_art_is_opaque(self):
        image = Image.new("RGB", (64, 64), (0, 0, 0))
        image.paste((250, 10, 10), (16, 16, 48, 48))
        pixels = quantize_sprite(image, 8, 8, PALETTE)
        self.assertEqual(len(pixels), 64)
        self.assertEqual(pixels[0], 0)
        self.assertEqual(pixels[3 * 8 + 3], 2)

    def test_alpha_is_respected_and_indices_stay_in_range(self):
        image = Image.new("RGBA", (16, 16), (0, 0, 255, 255))
        image.putpixel((0, 0), (0, 255, 0, 0))
        pixels = quantize_sprite(image, 16, 16, PALETTE)
        self.assertEqual(pixels[0], 0)
        self.assertTrue(all(0 <= p <= 15 for p in pixels))

    def test_palette_must_have_sixteen_colours(self):
        with self.assertRaises(ValueError):
            quantize_sprite(Image.new("RGB", (8, 8)), 8, 8, PALETTE[:4])


class SampleTests(unittest.TestCase):
    def test_resamples_trims_and_fits_the_budget(self):
        rate = 44100
        tone = np.sin(np.arange(rate * 3) * 2 * np.pi * 440 / rate)
        data = base64.b64decode(to_sample(np.stack([tone, tone]), rate, 2.0))
        self.assertLessEqual(len(data), MAX_SAMPLE_BYTES)
        self.assertGreater(len(data), 7000)
        pcm = np.frombuffer(data, dtype=np.int8)
        self.assertEqual(int(pcm[-1]), 0)
        self.assertGreaterEqual(int(pcm.max()), 120)


class MidiTests(unittest.TestCase):
    def test_rejects_non_midi(self):
        with self.assertRaises(ValueError):
            midi_bytes_to_base64(b"RIFF....")
        self.assertTrue(midi_bytes_to_base64(b"MThd" + b"\0" * 10))


if __name__ == "__main__":
    unittest.main()
