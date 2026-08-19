# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Risk aggregator.

Combines the signal results into a score, decides PASS or FLAG, and writes the record
with its per-signal breakdown to Amazon DynamoDB.

Signals are scored in two groups, judged independently. The two model signals read the
submitted image, so one crafted image can drive both of them at once; the three
deterministic signals do not read instructions. Scoring them as one weighted sum let a
suppressed model group dilute a deterministic finding below the threshold, so each group
is now normalized within its own weight and compared to the threshold on its own. See T4
in docs/threat-model.md for the attack this closes and the residual risk it does not.

The weights and threshold below are starting points, not tuned values. Calibrate them
against your own labelled images before relying on the verdict; see the aggregation
section of the README.
"""
import datetime
import os

import boto3

TABLE_NAME = os.environ["TABLE_NAME"]
_table = boto3.resource("dynamodb").Table(TABLE_NAME)

# Weights sum to 1.0. Error Level Analysis carries the most weight because it localizes
# an edit rather than inferring one, and metadata carries the least because it is
# trivially stripped or forged.
WEIGHTS = {
    "ela": 0.30,
    "bedrock_semantic": 0.25,
    "fft": 0.20,
    "cross_evidence": 0.15,
    "metadata": 0.10,
}
DEFAULT_WEIGHT = 0.10

# The signals that ask a model to judge the image. Both read the submitted photo, so both
# are reachable by text embedded in that photo. Any signal added here is treated as
# injectable; anything else is treated as deterministic.
LLM_SIGNALS = frozenset({"bedrock_semantic", "cross_evidence"})

FLAG_THRESHOLD = float(os.environ.get("FLAG_THRESHOLD", "0.35"))
HIGH_CONFIDENCE = float(os.environ.get("HIGH_CONFIDENCE", "0.70"))


def _clamp(value):
    """Bound a signal score to [0, 1].

    The model signals clamp their own confidence, so this is a second line of defence for
    a signal added later that forgets to. An unbounded score would otherwise scale
    straight through the weighted sum and decide the verdict on its own.
    """
    return min(max(float(value), 0.0), 1.0)


def lambda_handler(event, _context):
    image_key = event["imageKey"]
    signals = event["signals"]

    weighted = 0.0
    by_signal = {}
    # Per group: [sum of weight x score, sum of weight present]. Normalizing by the weight
    # actually present means a signal that failed or was never run does not silently
    # deflate its group's score.
    totals = {"deterministic": [0.0, 0.0], "llm": [0.0, 0.0]}
    confident = {"deterministic": False, "llm": False}

    for signal in signals:
        name = signal["signal"]
        score = _clamp(signal["score"])
        weight = WEIGHTS.get(name, DEFAULT_WEIGHT)
        group = "llm" if name in LLM_SIGNALS else "deterministic"

        weighted += weight * score
        totals[group][0] += weight * score
        totals[group][1] += weight
        if signal["verdict"] == "flag" and score >= HIGH_CONFIDENCE:
            confident[group] = True

        by_signal[name] = {
            "verdict": signal["verdict"],
            # The clamped value, because that is what decided the verdict.
            "score": str(round(score, 3)),
            "rationale": signal["rationale"],
            **({"artifactKey": signal["artifactKey"]} if "artifactKey" in signal else {}),
            **({"failedCheck": signal["failedCheck"]} if "failedCheck" in signal else {}),
        }

    def group_score(group):
        total, present = totals[group]
        return total / present if present else 0.0

    deterministic_score = group_score("deterministic")
    llm_score = group_score("llm")

    # Each group is compared to the threshold on its own, so suppressing one group cannot
    # drag the other below it. A single signal flagging at or above HIGH_CONFIDENCE still
    # carries its group, which keeps one confident finding from being averaged away.
    #
    # Worth knowing when you re-calibrate: with the deterministic signals in their quiet
    # state their scores are capped in the handlers themselves (Error Level Analysis and
    # frequency at 0.3, metadata at 0.4), so the deterministic group cannot exceed
    # (0.30x0.3 + 0.20x0.3 + 0.10x0.4) / 0.60 = 0.317. That leaves a thin margin under a
    # 0.35 threshold. A genuine finding clears it comfortably: an Error Level Analysis
    # flag at the minimum blob size scores about 0.7, and a metadata editor tag scores
    # 0.85 and trips the high-confidence condition by itself.
    deterministic_flag = deterministic_score >= FLAG_THRESHOLD or confident["deterministic"]
    llm_flag = llm_score >= FLAG_THRESHOLD or confident["llm"]

    verdict = "FLAG" if (deterministic_flag or llm_flag) else "PASS"

    # What drove the outcome. A flag resting only on the model group could have been caused
    # by text embedded in the image, so a reviewer needs to see that distinction.
    if deterministic_flag:
        corroboration = "deterministic"
    elif llm_flag:
        corroboration = "llm_only"
    else:
        corroboration = "none"

    _table.put_item(
        Item={
            "pk": "image",
            "sk": image_key,
            "verdict": verdict,
            "weightedScore": str(round(weighted, 3)),
            "deterministicScore": str(round(deterministic_score, 3)),
            "llmScore": str(round(llm_score, 3)),
            "corroboration": corroboration,
            "signals": by_signal,
            "analyzedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
    )

    return {
        "imageKey": image_key,
        "verdict": verdict,
        "weightedScore": round(weighted, 3),
        "deterministicScore": round(deterministic_score, 3),
        "llmScore": round(llm_score, 3),
        "corroboration": corroboration,
    }
