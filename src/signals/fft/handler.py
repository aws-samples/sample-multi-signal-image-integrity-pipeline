# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Signal 3: frequency-domain analysis. Diffusion-generated images carry characteristic radial power-spectrum signatures (excess mid/high-frequency regularity, grid artefacts) that natural camera images lack. Writes a log-spectrum PNG artefact."""
import io
import os

import boto3
import numpy as np
from PIL import Image

IMAGE_BUCKET = os.environ["IMAGE_BUCKET"]
_s3 = boto3.client("s3")

ANALYSIS_SIZE = 512


def _radial_profile(power: np.ndarray) -> np.ndarray:
    h, w = power.shape
    cy, cx = h // 2, w // 2
    y, x = np.indices((h, w))
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2).astype(np.int32)
    tbin = np.bincount(r.ravel(), power.ravel())
    nr = np.bincount(r.ravel())
    return tbin / np.maximum(nr, 1)


def lambda_handler(event, _context):
    key = event["imageKey"]
    obj = _s3.get_object(Bucket=IMAGE_BUCKET, Key=key)
    img = Image.open(io.BytesIO(obj["Body"].read())).convert("L").resize((ANALYSIS_SIZE, ANALYSIS_SIZE))
    arr = np.asarray(img, dtype=np.float32) / 255.0

    fft = np.fft.fftshift(np.fft.fft2(arr))
    power = np.abs(fft) ** 2
    log_power = np.log1p(power)

    profile = _radial_profile(power)
    n = len(profile)
    low = profile[2:n // 8].mean()
    mid = profile[n // 8:n // 3].mean()
    high = profile[n // 3:n // 2].mean() or 1e-12

    # Natural images decay smoothly (~1/f^2). Synthetic/diffusion outputs commonly
    # show excess periodic structure relative to the decay curve. Thresholds are
    # calibrated against the demo gallery (clean images measure flatness in the
    # hundreds, the synthetic case ~100x that); arbitrary uploads are best-effort.
    decay_ratio = float(mid / max(high, 1e-12))
    expected_decay = float(low / max(mid, 1e-12))
    flatness = expected_decay / max(decay_ratio, 1e-12)

    # Periodic spike detection in the high band (grid artefacts)
    high_band = profile[n // 3:n // 2]
    band_mean = high_band.mean() or 1e-12
    spikes = int((high_band > 4 * band_mean).sum())

    FLATNESS_THRESHOLD = 1500.0
    is_flag = flatness > FLATNESS_THRESHOLD or spikes >= 3
    score = min(max(flatness / (4 * FLATNESS_THRESHOLD), spikes / 6.0), 1.0) if is_flag else round(min(flatness / (4 * FLATNESS_THRESHOLD), 0.3), 3)

    # Spectrum artefact for the UI
    spec_norm = (log_power / log_power.max() * 255).astype(np.uint8)
    out = io.BytesIO()
    Image.fromarray(spec_norm).save(out, "PNG")
    out.seek(0)
    spec_key = f"artifacts/{key.rsplit('/', 1)[-1].rsplit('.', 1)[0]}-fft.png"
    _s3.put_object(Bucket=IMAGE_BUCKET, Key=spec_key, Body=out.getvalue(), ContentType="image/png")

    rationale = (
        f"Frequency spectrum departs from natural-image decay (flatness {flatness:.1f}, "
        f"{spikes} periodic spikes in the high band). Consistent with a synthetically generated image."
        if is_flag
        else f"Frequency spectrum follows natural-image decay (flatness {flatness:.1f}, {spikes} spikes)."
    )

    return {
        "signal": "fft",
        "verdict": "flag" if is_flag else "pass",
        "score": round(float(score), 3),
        "rationale": rationale,
        "artifactKey": spec_key,
    }
