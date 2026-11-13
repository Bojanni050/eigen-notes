#!/bin/sh
# Starts this stack's two model servers from a locally fetched llama.cpp build.
#
# Two processes, not one: llama.cpp serves one model per process, and the
# embedding model has to run in embedding mode with CLS pooling — a chat server
# is not an embedding server. The ports are the same ones docker-compose.yml
# publishes, so .env needs no change when you switch between the two ways of
# running.
#
#   ./scripts/fetch-llama-server.sh
#   ./scripts/serve-models.sh          # keeps running until Ctrl-C
#
# Models: MODELS_DIR (default ./models) must hold the two GGUF files. The compose
# `models` service downloads the same two files into a volume; for a local run,
# copy them out of it once, or let it download them and copy from there:
#
#   docker run --rm -v eigen-notes_models:/m:ro -v "$PWD/models":/o alpine cp /m/*.gguf /o/
set -eu

TAG="${LLAMA_TAG:-b12340}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN="$HERE/runtime/llama-$TAG/llama-server"
MODELS="${MODELS_DIR:-$HERE/models}"

CHAT_FILE="${CHAT_GGUF:-$MODELS/qwen2.5-3b-instruct-q4_k_m.gguf}"
EMBED_FILE="${EMBED_GGUF:-$MODELS/bge-m3-Q8_0.gguf}"
CHAT_PORT="${CHAT_PORT:-11500}"
EMBED_PORT="${EMBED_PORT:-11501}"

[ -x "$BIN" ] || { echo "missing $BIN — run ./scripts/fetch-llama-server.sh first" >&2; exit 1; }
[ -s "$CHAT_FILE" ] || { echo "missing $CHAT_FILE — see MODELS_DIR in this script" >&2; exit 1; }
[ -s "$EMBED_FILE" ] || { echo "missing $EMBED_FILE — see MODELS_DIR in this script" >&2; exit 1; }

# The shared libraries sit next to the binary in a release archive.
export LD_LIBRARY_PATH="$HERE/runtime/llama-$TAG${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

pids=""
cleanup() {
    trap - INT TERM
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup INT TERM

echo "== chat model on $CHAT_PORT (tags, summary, rerank)"
"$BIN" -m "$CHAT_FILE" --host 127.0.0.1 --port "$CHAT_PORT" --ctx-size 8192 --jinja >"$HERE/runtime/llama-chat.log" 2>&1 &
pids="$pids $!"

echo "== embedding model on $EMBED_PORT (bge-m3, CLS pooling)"
"$BIN" -m "$EMBED_FILE" --host 127.0.0.1 --port "$EMBED_PORT" --ctx-size 8192 --embeddings --pooling cls >"$HERE/runtime/llama-embed.log" 2>&1 &
pids="$pids $!"

# Wait until both answer, so the caller knows the app can start. A model load
# takes seconds; a silent start would send the app into provider errors instead.
wait_for() {
    port="$1"
    name="$2"
    i=0
    while [ "$i" -lt 120 ]; do
        if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
            echo "== $name is up"
            return 0
        fi
        i=$((i + 1))
        sleep 1
    done
    echo "== $name did not come up on port $port — see runtime/llama-*.log" >&2
    cleanup
    exit 1
}

wait_for "$CHAT_PORT" chat
wait_for "$EMBED_PORT" embed

echo "== both servers are running; start the app with: npm run start:local"
echo "== Ctrl-C stops them"
wait
