#!/bin/sh
# Fetches a llama.cpp release for this machine into runtime/llama-<tag>/.
#
# One binary plus a GGUF file is all a model server needs, which is why this app
# uses llama.cpp instead of a daemon with its own model registry. The tag is
# pinned on purpose: the app was tested against one release, not against
# "latest", and a moving target is how a working install breaks overnight.
#
#   ./scripts/fetch-llama-server.sh
#   LLAMA_TAG=b12340 LLAMA_VARIANT=vulkan ./scripts/fetch-llama-server.sh
#
# VARIANT picks a faster build where one exists (vulkan, cuda-13.5, rocm, sycl);
# the default is the plain CPU build, which is the one that always works.
set -eu

TAG="${LLAMA_TAG:-b12340}"
VARIANT="${LLAMA_VARIANT:-cpu}"

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST="$HERE/runtime/llama-$TAG"

case "$(uname -s)-$(uname -m)" in
Linux-x86_64) ARCH=x64 ;;
Linux-aarch64) ARCH=arm64 ;;
Darwin-arm64) ARCH=arm64 ;;
Darwin-x86_64) ARCH=x64 ;;
*)
    echo "no llama.cpp build is mapped for $(uname -s)-$(uname -m)." >&2
    echo "Set LLAMA_ASSET to the release asset name you want and re-run." >&2
    exit 1
    ;;
esac

case "$(uname -s)" in
Linux) OS=ubuntu ;;
Darwin) OS=macos ;;
esac

if [ -n "${LLAMA_ASSET:-}" ]; then
    ASSET="$LLAMA_ASSET"
elif [ "$VARIANT" = cpu ]; then
    # The CPU build has no variant segment in its name.
    ASSET="llama-$TAG-bin-$OS-$ARCH.tar.gz"
else
    ASSET="llama-$TAG-bin-$OS-$VARIANT-$ARCH.tar.gz"
fi

if [ -x "$DEST/llama-server" ]; then
    echo "== already have $DEST/llama-server"
else
    echo "== downloading $ASSET"
    mkdir -p "$DEST"
    TMP="$DEST/.download.tar.gz"
    URL="https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$ASSET"
    curl --fail --location --retry 3 --retry-delay 5 -o "$TMP" "$URL"
    # The archive has one top-level directory named after the tag; strip it so the
    # binaries land directly in $DEST.
    tar -xzf "$TMP" --strip-components=1 -C "$DEST"
    rm -f "$TMP"
    echo "== extracted into $DEST"
fi

# Say out loud that the binary actually runs here, so a wrong architecture or a
# missing shared library fails now instead of at first use.
echo "== version:"
LD_LIBRARY_PATH="$DEST${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$DEST/llama-server" --version 2>&1 | head -3
echo "== done. Start the servers with: ./scripts/serve-models.sh"
