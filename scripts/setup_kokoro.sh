#!/bin/sh
set -eu

MODEL_DIR="${SECONDSEAT_KOKORO_MODEL_DIR:-/tmp/secondseat-kokoro-model}"
"${SECONDSEAT_PYTHON_BOOTSTRAP:-python3}" -m venv .venv
.venv/bin/python -m pip install -r requirements-kokoro.txt
mkdir -p "$MODEL_DIR"

if [ ! -f "$MODEL_DIR/kokoro-v1.0.int8.onnx" ]; then
  curl --fail --location --output "$MODEL_DIR/kokoro-v1.0.int8.onnx" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx
fi
if [ ! -f "$MODEL_DIR/voices-v1.0.bin" ]; then
  curl --fail --location --output "$MODEL_DIR/voices-v1.0.bin" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin
fi

echo "Kokoro is ready."
