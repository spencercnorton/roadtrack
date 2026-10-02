# Releasing

A release is a tag. Pushing `vX.Y.Z` on `main` runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which:

1. runs CI and the privacy scan again, on the tagged commit;
2. proves the tag is a stable version on `main`, equal to [`VERSION`](../VERSION),
   with a `## X.Y.Z` entry in [`CHANGELOG.md`](../CHANGELOG.md);
3. builds the image natively on amd64 and on arm64, and pushes each half as
   `vX.Y.Z-amd64` and `vX.Y.Z-arm64`;
4. joins the two into `ghcr.io/spencercnorton/roadtrack:vX.Y.Z` and points
   `latest` at it;
5. creates the GitHub Release: the CHANGELOG entry as its notes, the source
   tarball, `IMAGE_DIGEST.txt` and `SHA256SUMS.txt`.

Release images are immutable. The publish steps refuse a tag that already exists
in the registry, and the repository's rules refuse a moved or deleted `v*` tag. A
broken release is fixed by the next version, never by re-tagging.

## Cutting one

1. In a pull request, bump `VERSION` and move the `## Unreleased` notes under a
   new `## X.Y.Z — YYYY-MM-DD` heading. Merge it once the checks are green.
2. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Road Track X.Y.Z"
   git push origin vX.Y.Z
   ```

3. When the Release run is green, check what it published:

   ```bash
   docker buildx imagetools inspect ghcr.io/spencercnorton/roadtrack:vX.Y.Z   # two platforms
   ```

Anyone running `latest` picks the release up on their next pull. Anyone who
pinned a version upgrades when they change the tag.

## Which number

- **Patch** — a fix, with nothing for a deployment to do.
- **Minor** — a new feature or a new optional setting, or a newer LubeLogger
  underneath. Name the LubeLogger version in the CHANGELOG entry: going back to
  an older LubeLogger with the same data is not supported (see
  [Operations](operations.md)).
- **Major** — something a deployment must act on: a setting removed or renamed,
  a new required volume, a change to what the image needs to start.
