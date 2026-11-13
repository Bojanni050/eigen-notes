#!/bin/sh
# Downloads this stack's two GGUF models into /models, once.
#
# Idempotent: an existing file is left alone, so `docker compose up -d` is cheap
# after the first run and nothing has to be installed by hand.
#
# A script file rather than an inline compose `command: |` block, because the
# first version of that broke in a way worth remembering: compose delivered the
# multi-line scalar as separate argv elements, so the shell ran only `set` (and
# dumped its variables, exit 0, no download at all). YAML + shell quoting in one
# string is a trap; a file is diffable and testable on its own.
set -eu

CHAT_FILE=qwen2.5-3b-instruct-q4_k_m.gguf
CHAT_URL=https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf
EMBED_FILE=bge-m3-Q8_0.gguf
EMBED_URL=https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf

mkdir -p /models
cd /models

fetch() {
    file="$1"
    url="$2"
    if [ -s "$file" ]; then
        echo "== have $file"
        return 0
    fi
    echo "== downloading $file"
    curl --fail --location --retry 3 --retry-delay 5 -o "$file.part" "$url"
    mv "$file.part" "$file"
    echo "== done $file"
}

fetch "$CHAT_FILE" "$CHAT_URL"
fetch "$EMBED_FILE" "$EMBED_URL"

ls -la /models
echo "== models ready"
