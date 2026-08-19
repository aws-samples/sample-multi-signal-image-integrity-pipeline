# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Seed a sample gallery and run the pipeline over it.

The script generates procedural images, derives three manipulated variants from them (a
splice edit, a periodic-texture image, and an image carrying editor metadata), uploads
everything to the image bucket, and starts a pipeline execution for each. Each variant
exercises a different signal, so a first run shows what every signal does and does not
catch.

Usage:
    python3 scripts/seed-data.py --bucket <ImageBucketName> \\
        --state-machine <StateMachineArn> [--region <region>]

To use your own images instead of the procedural ones, place JPEG files named
clean-*.jpg in scripts/gallery/ before running. The script derives the manipulated
variants from those files. Use images you have the rights to publish, and do not use
images of real people without their consent.
"""
import argparse
import glob
import json
import os
import random
import time

import boto3

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    raise SystemExit("This script needs Pillow: pip3 install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
GALLERY = os.path.join(HERE, "gallery")

# Seeded so the generated images are reproducible between runs. This module uses
# `random` only to dither pixel values; nothing here is security relevant, which
# is why the Bandit B311 finding below is suppressed rather than switched to
# `secrets`.
random.seed(42)


def procedural_photo(width=768, height=1024, tone=(224, 188, 160)) -> Image.Image:
    """Build a photo-like base image: a toned gradient with a vignette, sensor noise, and a
    couple of soft shapes so the forensic signals have structure to measure."""
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    max_dist = (width / 2) ** 2 + (height / 2) ** 2
    for y in range(height):
        for x in range(width):
            fade = 1 - 0.35 * ((x - width / 2) ** 2 + (y - height / 2) ** 2) / max_dist
            # Pixel dither for the generated sample images; no output feeds a security
            # decision, so the standard library generator is the right tool here.
            noise = random.randint(-6, 6)  # nosec B311
            pixels[x, y] = tuple(max(0, min(255, int(c * fade) + noise)) for c in tone)
    draw = ImageDraw.Draw(img)
    draw.ellipse(
        [width * 0.28, height * 0.08, width * 0.72, height * 0.42],
        fill=tuple(int(c * 0.92) for c in tone),
    )
    draw.rounded_rectangle(
        [width * 0.18, height * 0.42, width * 0.82, height * 0.98],
        radius=60,
        fill=tuple(int(c * 0.85) for c in tone),
    )
    return img.filter(ImageFilter.GaussianBlur(1.2))


def splice_edit(base: Image.Image) -> Image.Image:
    """Paste in a region that has never been JPEG-compressed, which is what an editor does
    when content is added to a photo. Its compression history differs from the host image,
    so Error Level Analysis sees a contiguous high-error region."""
    import numpy as np

    rng = np.random.default_rng(7)
    img = base.copy()
    width, height = img.size
    patch_w, patch_h = int(width * 0.36), int(height * 0.16)
    noise = rng.integers(0, 60, (patch_h, patch_w, 3), dtype=np.uint8)
    patch_array = np.clip(
        np.array([70, 90, 140], dtype=np.int16) + noise.astype(np.int16) - 30, 0, 255
    ).astype(np.uint8)
    patch = Image.fromarray(patch_array)
    draw = ImageDraw.Draw(patch)
    for x in range(0, patch_w, 14):
        draw.line([(x, 0), (x, patch_h)], fill=(58, 76, 120), width=5)
    img.paste(patch, (int(width * 0.32), int(height * 0.44)))
    return img


def periodic_texture(width=768, height=1024) -> Image.Image:
    """Add a regular grid pattern. Its frequency spectrum has periodic spikes, similar in
    shape to the signature the frequency signal looks for in generated images."""
    img = procedural_photo(width, height, tone=(210, 195, 180))
    pixels = img.load()
    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y]
            offset = int(12 * ((x % 8 < 4) ^ (y % 8 < 4)))
            pixels[x, y] = (min(255, r + offset), min(255, g + offset), min(255, b + offset))
    return img


def save_jpeg(img: Image.Image, path: str, quality=92, exif=None):
    options = {"quality": quality}
    if exif is not None:
        options["exif"] = exif
    img.save(path, "JPEG", **options)


def editor_exif() -> bytes:
    """EXIF that names image-editing software in the Software tag."""
    exif = Image.new("RGB", (1, 1)).getexif()
    exif[0x0131] = "Example Image Editor 1.0"
    return exif.tobytes()


def camera_exif() -> bytes:
    """EXIF consistent with a photo straight out of a camera."""
    exif = Image.new("RGB", (1, 1)).getexif()
    exif[0x010F] = "ExampleCorp"
    exif[0x0110] = "ExampleCam X1"
    exif[0x0131] = "1.0"
    return exif.tobytes()


def build_gallery(tmp: str) -> list:
    os.makedirs(tmp, exist_ok=True)
    files = []

    supplied = sorted(glob.glob(os.path.join(GALLERY, "clean-*.jpg"))) if os.path.isdir(GALLERY) else []
    if supplied:
        bases = [Image.open(p).convert("RGB") for p in supplied[:3]]
        print(f"Using {len(bases)} images from scripts/gallery/")
    else:
        print("No images found in scripts/gallery/. Generating procedural images.")
        bases = [
            procedural_photo(tone=tone)
            for tone in [(224, 188, 160), (198, 160, 135), (235, 205, 185)]
        ]

    # Unmodified images carrying camera metadata. Every signal should pass these.
    for index, base in enumerate(bases, 1):
        path = os.path.join(tmp, f"clean-{index:02d}.jpg")
        save_jpeg(base, path, exif=camera_exif())
        files.append(path)

    # A pair that looks identical at a glance: the first image above and a copy with a
    # region spliced in. Error Level Analysis localizes the difference.
    path = os.path.join(tmp, "clean-01-spliced.jpg")
    save_jpeg(splice_edit(bases[0]), path, exif=camera_exif())
    files.append(path)

    # Periodic texture, which the frequency signal catches and Error Level Analysis misses.
    path = os.path.join(tmp, "periodic-texture-01.jpg")
    save_jpeg(periodic_texture(), path)
    files.append(path)

    # Editor metadata only: the pixels are untouched, so metadata is the only signal
    # with anything to report. This case shows why metadata alone is weak evidence.
    path = os.path.join(tmp, "editor-metadata-01.jpg")
    save_jpeg(bases[1].copy(), path, exif=editor_exif())
    files.append(path)

    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True, help="ImageBucketName stack output")
    parser.add_argument("--state-machine", required=True, help="StateMachineArn stack output")
    parser.add_argument("--region", default=None, help="Defaults to the region in your AWS profile")
    args = parser.parse_args()

    session = boto3.Session(region_name=args.region) if args.region else boto3.Session()
    s3 = session.client("s3")
    sfn = session.client("stepfunctions")

    files = build_gallery(os.path.join(HERE, ".seed-tmp"))

    for path in files:
        key = f"images/gallery/{os.path.basename(path)}"
        s3.upload_file(path, args.bucket, key, ExtraArgs={"ContentType": "image/jpeg"})
        sfn.start_execution(
            stateMachineArn=args.state_machine, input=json.dumps({"imageKey": key})
        )
        print(f"uploaded and started analysis: {key}")
        time.sleep(1)

    print(f"\nSeeded {len(files)} images. Open the review URL and choose Refresh.")


if __name__ == "__main__":
    main()
