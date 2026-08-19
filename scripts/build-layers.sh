#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# build-layers.sh — build the Lambda layer (Pillow + numpy, arm64) used by the ELA, FFT, and metadata signal functions.
# Run before `cdk synth`. Produces infra/layers/imaging/python with pinned manylinux wheels.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAYER_DIR="${ROOT}/infra/layers/imaging/python"

rm -rf "${LAYER_DIR}"
mkdir -p "${LAYER_DIR}"

# manylinux_2_28 is the current baseline for numpy's aarch64 wheels. The Python
# 3.14 Lambda runtime is Amazon Linux 2023 (glibc 2.34), which satisfies it.
pip3 install \
  --platform manylinux_2_28_aarch64 \
  --implementation cp \
  --python-version 3.14 \
  --only-binary=:all: \
  --target "${LAYER_DIR}" \
  "pillow==12.3.0" "numpy==2.5.2"

# Trim what Lambda never needs
find "${LAYER_DIR}" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "${LAYER_DIR}" -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true

echo "Layer built at ${LAYER_DIR}"
