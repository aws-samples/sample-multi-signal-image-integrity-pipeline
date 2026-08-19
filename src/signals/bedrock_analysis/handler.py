# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Signal 1: semantic authenticity analysis with a multimodal model on Amazon Bedrock.

This signal reasons about whether the scene in front of the camera is plausible. It
catches what pixel statistics miss, such as shadows falling in two directions, and it
returns a written rationale a reviewer can act on. It does not catch a pixel-accurate
edit that leaves a plausible scene.
"""
import json
import os

import boto3

MODEL_ID = os.environ["BEDROCK_MODEL_ID"]
IMAGE_BUCKET = os.environ["IMAGE_BUCKET"]

_s3 = boto3.client("s3")
_bedrock = boto3.client("bedrock-runtime")

# Optional second check. Set SUBJECT_CHECK to a description of what the image must
# show for a reviewer to act on it, for example "the full width of the damaged panel
# is visible and in focus". Leave it unset to score authenticity alone.
SUBJECT_CHECK = os.environ.get("SUBJECT_CHECK", "").strip()

AUTHENTICITY_CRITERIA = """Look for:
- Geometry that does not hold together: straight background lines that bend near a subject, smeared or warped edges, perspective that changes across the frame.
- Lighting that does not agree with itself: shadows pointing in different directions, highlights with no light source, reflections that do not match the scene.
- Texture that repeats or is unnaturally smooth, particularly on skin, fabric, foliage, and text.
- Boundaries where two images meet: halos, mismatched grain or noise, a subject sharper or softer than its surroundings.
- Text and fine detail that is malformed or illegible at a size where it should be readable.

Judge only what is visible in the image. Do not speculate about metadata, capture time, or
file history; other signals in this pipeline cover those."""

SCHEMA_INSTRUCTION = """Respond with JSON only, matching this schema:
{"verdict": "pass" | "flag", "confidence": 0.0-1.0, "failedCheck": %s, "rationale": "<2-3 plain sentences describing what you observed and where in the frame>"}"""


def _build_prompt():
    """Assemble the prompt, adding a usability check when SUBJECT_CHECK is configured."""
    if SUBJECT_CHECK:
        return "\n\n".join(
            [
                "You are reviewing a user-submitted photo on two dimensions. "
                "Flag the image if either fails.",
                f"1. USABILITY. A reviewer needs this to be true of the photo: {SUBJECT_CHECK}\n"
                "   Flag if the photo does not meet that description well enough to act on.",
                f"2. AUTHENTICITY. Assess whether the photo shows signs of editing or "
                f"synthetic generation.\n\n{AUTHENTICITY_CRITERIA}",
                SCHEMA_INSTRUCTION % '"usability" | "authenticity" | null',
            ]
        )
    return "\n\n".join(
        [
            "You are reviewing a user-submitted photo for signs of editing or synthetic generation.",
            AUTHENTICITY_CRITERIA,
            SCHEMA_INSTRUCTION % '"authenticity" | null',
        ]
    )


PROMPT = _build_prompt()


def lambda_handler(event, _context):
    key = event["imageKey"]
    obj = _s3.get_object(Bucket=IMAGE_BUCKET, Key=key)
    image_bytes = obj["Body"].read()
    image_format = "png" if key.lower().endswith(".png") else "jpeg"

    response = _bedrock.converse(
        modelId=MODEL_ID,
        messages=[
            {
                "role": "user",
                "content": [
                    {"image": {"format": image_format, "source": {"bytes": image_bytes}}},
                    {"text": PROMPT},
                ],
            }
        ],
        inferenceConfig={"maxTokens": 500},
    )

    text = response["output"]["message"]["content"][0]["text"]
    failed_check = None
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        result = json.loads(text[start:end])
        verdict = result.get("verdict", "flag")
        # Clamp to the range the schema asks for. The model is asked for 0.0-1.0, but the
        # image is attacker-controlled and an injected instruction can make it return
        # anything. Without the clamp, "confidence": 99 on a pass becomes a score of -98,
        # which would swamp every other signal in the aggregator's weighted sum.
        confidence = min(max(float(result.get("confidence", 0.5)), 0.0), 1.0)
        rationale = str(result.get("rationale", ""))[:1000]
        failed_check = result.get("failedCheck")
    except (ValueError, KeyError):
        # An unparseable response is treated as a flag so the image reaches a
        # reviewer rather than passing unexamined.
        verdict = "flag"
        confidence = 0.3
        rationale = "The model response could not be parsed. Flagged for manual review."

    out = {
        "signal": "bedrock_semantic",
        "verdict": verdict,
        "score": confidence if verdict == "flag" else 1 - confidence,
        "rationale": rationale,
    }
    if failed_check:
        out["failedCheck"] = failed_check
    return out
