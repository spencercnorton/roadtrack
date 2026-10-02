#!/bin/sh
# Publish a release image: one architecture's half, or the join of both.
#
#     tools/release_image.sh arch     # on each architecture, with ARCH=amd64 or arm64
#     tools/release_image.sh join     # once both halves exist: vX.Y.Z and latest
#
# Run by the release workflow, which sets RELEASE_TAG and REGISTRY_TOKEN (GitHub
# sets GITHUB_REPOSITORY, GITHUB_ACTOR and GITHUB_SHA). Each half is built
# natively on its own architecture rather than under emulation and pushed as
# vX.Y.Z-<arch>; the join makes vX.Y.Z a multi-architecture image over the two
# and points latest at it.
#
# Release images are immutable. If the tag being written already exists in the
# registry this refuses, rather than replace what people may already be running.
set -eu
image="ghcr.io/$GITHUB_REPOSITORY"
version="${RELEASE_TAG#v}"

printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

refuse_existing() {
    if docker buildx imagetools inspect "$1" >/dev/null 2>&1; then
        echo "refusing: $1 already exists, and release images are never replaced" >&2
        exit 1
    fi
}

case "${1:-}" in
arch)
    half="$image:$RELEASE_TAG-$ARCH"
    refuse_existing "$half"
    docker build --build-arg VERSION="$version" --build-arg REVISION="$GITHUB_SHA" -t "$half" .
    docker push "$half"
    ;;
join)
    refuse_existing "$image:$RELEASE_TAG"
    docker buildx imagetools create -t "$image:$RELEASE_TAG" -t "$image:latest" \
        "$image:$RELEASE_TAG-amd64" "$image:$RELEASE_TAG-arm64"
    digest=$(docker buildx imagetools inspect "$image:$RELEASE_TAG" --format '{{.Manifest.Digest}}')
    printf '%s@%s\n' "$image" "$digest" > IMAGE_DIGEST.txt
    cat IMAGE_DIGEST.txt
    ;;
*)
    echo "usage: $0 arch|join" >&2
    exit 2
    ;;
esac
