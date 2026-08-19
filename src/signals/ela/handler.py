# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Signal 2: Error Level Analysis.

Recompresses the image and measures how much each region's compression error diverges
from the image as a whole. A region pasted in from another source carries a different
compression history, so it diverges. Writes a heatmap to the bucket for the reviewer.

This works on JPEG input. A PNG, or a JPEG that has been uniformly re-saved, gives every
region the same compression history, so the signal has nothing to separate.
"""
import io
import os

import boto3
import numpy as np
from PIL import Image, ImageChops

IMAGE_BUCKET = os.environ["IMAGE_BUCKET"]
_s3 = boto3.client("s3")

RESAVE_QUALITY = 90
GRID = 24  # analysis grid, GRID x GRID cells

# Thresholds below were set against smartphone-resolution photographs, where isolated
# cells on texture edges peak around four to five times the image-wide mean error and a
# pasted region shows as a contiguous group of cells well above that. Re-measure them on
# your own images: run the pipeline over a set you know to be unedited, look at the
# reported peak ratios, and set HOT_RATIO above that ceiling.
HOT_RATIO = float(os.environ.get("ELA_HOT_RATIO", "6.0"))
MIN_BLOB = int(os.environ.get("ELA_MIN_BLOB", "4"))  # contiguous hot cells to call a splice


def _largest_blob(mask):
    """Largest 4-connected component in a boolean grid."""
    seen = np.zeros_like(mask, dtype=bool)
    best = 0
    rows, cols = mask.shape
    for si in range(rows):
        for sj in range(cols):
            if mask[si, sj] and not seen[si, sj]:
                stack = [(si, sj)]
                seen[si, sj] = True
                size = 0
                while stack:
                    i, j = stack.pop()
                    size += 1
                    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ni, nj = i + di, j + dj
                        if 0 <= ni < rows and 0 <= nj < cols and mask[ni, nj] and not seen[ni, nj]:
                            seen[ni, nj] = True
                            stack.append((ni, nj))
                best = max(best, size)
    return best


def lambda_handler(event, _context):
    key = event["imageKey"]
    obj = _s3.get_object(Bucket=IMAGE_BUCKET, Key=key)
    original = Image.open(io.BytesIO(obj["Body"].read())).convert("RGB")

    # Recompress and diff
    buf = io.BytesIO()
    original.save(buf, "JPEG", quality=RESAVE_QUALITY)
    buf.seek(0)
    resaved = Image.open(buf)
    diff = ImageChops.difference(original, resaved)
    err = np.asarray(diff, dtype=np.float32).mean(axis=2)  # per-pixel mean error

    global_mean = float(err.mean()) or 1e-6

    # Per-cell error ratio grid
    h, w = err.shape
    ch, cw = max(h // GRID, 1), max(w // GRID, 1)
    cells = np.zeros((GRID, GRID), dtype=np.float32)
    for i in range(GRID):
        for j in range(GRID):
            cells[i, j] = float(err[i * ch:(i + 1) * ch, j * cw:(j + 1) * cw].mean()) / global_mean

    max_ratio = float(cells.max())
    hot_mask = cells > HOT_RATIO
    hot_cells = int(hot_mask.sum())
    blob = _largest_blob(hot_mask)

    is_flag = blob >= MIN_BLOB
    score = min(blob / 20.0 + max_ratio / 12.0, 1.0) if is_flag else round(min(max_ratio / 12.0, 0.3), 3)
    total_cells = GRID * GRID

    # Heatmap artefact for the UI
    norm = np.clip(err / (err.max() or 1.0), 0, 1)
    heat = np.zeros((h, w, 3), dtype=np.uint8)
    heat[..., 0] = (norm * 255).astype(np.uint8)          # red = high error
    heat[..., 2] = ((1 - norm) * 120).astype(np.uint8)    # blue = low error
    heat_img = Image.blend(original, Image.fromarray(heat), 0.6)
    out = io.BytesIO()
    heat_img.save(out, "PNG")
    out.seek(0)
    heat_key = f"artifacts/{key.rsplit('/', 1)[-1].rsplit('.', 1)[0]}-ela.png"
    _s3.put_object(Bucket=IMAGE_BUCKET, Key=heat_key, Body=out.getvalue(), ContentType="image/png")

    rationale = (
        f"A contiguous region of {blob} cells ({hot_cells} of {total_cells} total) shows compression "
        f"error far above the rest of the image (peak {max_ratio:.1f}x vs the ~4x natural ceiling). "
        "Consistent with content pasted in with a different compression history."
        if is_flag
        else f"Compression error is consistent across the image (peak region ratio {max_ratio:.1f}x, "
             f"no contiguous divergent region)."
    )

    return {
        "signal": "ela",
        "verdict": "flag" if is_flag else "pass",
        "score": round(score, 3),
        "rationale": rationale,
        "artifactKey": heat_key,
    }
