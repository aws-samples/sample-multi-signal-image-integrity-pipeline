# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Signal 4: metadata forensics. Checks EXIF for editing-software tags, missing camera provenance, and timestamp anomalies. Weak alone, honest in aggregate."""
import io
import os

import boto3
from PIL import Image
from PIL.ExifTags import TAGS

IMAGE_BUCKET = os.environ["IMAGE_BUCKET"]
_s3 = boto3.client("s3")

# Substrings that indicate the file passed through image-editing or image-generation
# software. The generic terms come first: any application that describes itself as an
# editor or a generator is worth reporting, whether or not it appears in this list.
# Extend the list with the software your own submissions tend to carry.
EDITOR_MARKERS = (
    "editor", "edited", "retouch", "generator", "generated", "diffusion",
    "photoshop", "gimp", "lightroom", "affinity", "pixelmator", "canva",
    "facetune", "faceapp", "snapseed", "picsart", "imagemagick",
)


def lambda_handler(event, _context):
    key = event["imageKey"]
    obj = _s3.get_object(Bucket=IMAGE_BUCKET, Key=key)
    img = Image.open(io.BytesIO(obj["Body"].read()))

    exif = img.getexif()
    tags = {TAGS.get(tag_id, str(tag_id)): str(value) for tag_id, value in exif.items()}

    findings = []
    software = tags.get("Software", "").lower()
    if any(marker in software for marker in EDITOR_MARKERS):
        findings.append(f"Editing/generation software tag present: '{tags['Software']}'.")

    has_camera = bool(tags.get("Make") or tags.get("Model"))
    if not has_camera and tags:
        findings.append("EXIF present but no camera make/model, unusual for a direct camera upload.")

    if not tags:
        findings.append("No EXIF metadata at all. Common for stripped or re-exported images (weak signal, many apps strip EXIF).")

    dt_original = tags.get("DateTimeOriginal")
    dt_modified = tags.get("DateTime")
    if dt_original and dt_modified and dt_original != dt_modified:
        findings.append(f"Modification time ({dt_modified}) differs from capture time ({dt_original}).")

    # Editor tag is a strong finding; the rest are weak corroboration
    strong = any("software tag" in f.lower() for f in findings)
    is_flag = strong
    score = 0.85 if strong else min(0.15 * len(findings), 0.4)

    rationale = " ".join(findings) if findings else "EXIF metadata is consistent with an unedited camera capture."

    return {
        "signal": "metadata",
        "verdict": "flag" if is_flag else "pass",
        "score": round(score, 3),
        "rationale": rationale,
    }
