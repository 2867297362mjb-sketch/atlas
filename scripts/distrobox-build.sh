#!/usr/bin/env bash
# Build the Linux release packages inside a distrobox on `ubuntu:24.04`, so the
# binary links the container's glibc (2.39) and libstdc++ (13) instead of the
# host's. A binary needs the glibc of the machine that built it: one built on
# Ubuntu 26.04 needs 2.43, which Debian 13 (2.41) refuses on `libc6`. One built
# here installs on Debian 13, Ubuntu 24.04+ and Fedora 40+. It still does NOT
# cover Debian 12 (2.36) or Ubuntu 22.04 (2.35): for those, build on
# `ubuntu:22.04` instead (docs/research/glibc-backward-compat.md). The release
# workflow remains the authority on what ships; this is for local packaging.
#
# Usage, on the host:
#   scripts/distrobox-build.sh                  # create the box if needed, build inside it
#   DISTROBOX_IMAGE=docker.io/library/ubuntu:22.04 DISTROBOX_NAME=atlas-ubuntu2204 \
#     scripts/distrobox-build.sh                # a 2.35-floor build instead
#
# Needs on the host: `sudo apt install -y podman distrobox` (once).
# Output: target/release-linux/ (deb, rpm, tarball, AUR recipe, AppImage),
#         with the build itself in target/<box>/ so no host-built object is reused.
#
# Not under scripts/linux/: a pull request touching that directory dry-runs the
# whole two-arch release (release-linux.yml), and this script does not decide
# what ships.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOX="${DISTROBOX_NAME:-atlas-ubuntu2404}"
IMAGE="${DISTROBOX_IMAGE:-docker.io/library/ubuntu:24.04}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) TRIPLE="x86_64-unknown-linux-gnu" ;;
  aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------- inside ----
if [ "${1:-}" = "--inside" ]; then
  cd "$ROOT"
  # release-linux.yml's "Install system build dependencies", minus xvfb (no GUI
  # check runs here), plus what a bare image lacks and a GitHub runner has: a
  # compiler, git, curl, CA certificates, dpkg-dev (dpkg-shlibdeps for
  # package-linux.sh), binutils (objdump for the glibc-floor check), file. The
  # workflow's aarch64 compiler step is mirrored further down.
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git file dpkg-dev binutils \
    pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf libglib2.0-dev \
    bubblewrap rpm squashfs-tools meson ninja-build libcap-dev

  # Rust, Bun and Node at the pinned versions. ~/.rustup, ~/.cargo and
  # ~/.local/share/mise are the host's (distrobox shares $HOME), so the
  # toolchain and the crate registry are not downloaded twice; rustup's
  # binaries target glibc 2.17 and run on the older image.
  export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
  if ! command -v rustup >/dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
  fi
  rustup toolchain install   # reads rust-toolchain.toml; a no-op if present
  if ! command -v mise >/dev/null; then
    curl -fsSL https://mise.run | sh
  fi
  mise install
  eval "$(mise activate bash --shims)"
  bun install --frozen-lockfile

  # The bubblewrap the AppImage carries. Built here, not on the host, for the
  # same reason as the binary: it is a C program and inherits the glibc floor.
  ./scripts/linux/build-bwrap.sh src-tauri/binaries "$TRIPLE"

  # numkong, a C dependency, cannot be built for aarch64 by GCC 12 or older.
  # release-linux.yml's "Use Clang 18 for native dependencies on aarch64" step
  # says why, and why not the distro's own Clang; same remedy here, for a base
  # whose GCC is older than 13 (ubuntu:22.04, debian:bookworm). GCC 13 builds it.
  if [ "$ARCH" = aarch64 ] && [ "$(gcc -dumpversion | cut -d. -f1)" -lt 13 ]; then
    . /etc/os-release
    curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key \
      | sudo tee /etc/apt/trusted.gpg.d/apt.llvm.org.asc >/dev/null
    echo "deb http://apt.llvm.org/$VERSION_CODENAME/ llvm-toolchain-$VERSION_CODENAME-18 main" \
      | sudo tee /etc/apt/sources.list.d/llvm-18.list >/dev/null
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends clang-18
    export CC=clang-18 CXX=clang++-18
  fi

  # A target dir per box: cargo does not fingerprint the system glibc, so a
  # build in the host's target dir would relink C objects compiled against the
  # host's newer glibc headers (such as the `__isoc23_*` references that glibc
  # 2.38+ redirects `strtol` and `sscanf` to) into a binary that still fails on
  # older distros. Under target/, which git and Vite's watcher already ignore.
  export CARGO_TARGET_DIR="$ROOT/target/$BOX"
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"   # override with CARGO_BUILD_JOBS=N
  # appimagetool needs FUSE to run itself; containers have none.
  export APPIMAGE_EXTRACT_AND_RUN=1
  bun run build:app:linux -- --bundles appimage --config src-tauri/binaries/tauri.bwrap.conf.json

  # package-linux.sh prints the binary's glibc and libstdc++ floors.
  ATLAS_BIN="$CARGO_TARGET_DIR/release/atlas" ./scripts/package-linux.sh "$ARCH"
  cp "$CARGO_TARGET_DIR"/release/bundle/appimage/*.AppImage target/release-linux/
  echo "packages in target/release-linux/:"
  find target/release-linux -maxdepth 1 -type f \
    \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.tar.gz' \) \
    -printf '  %f\n'
  exit 0
fi

# ------------------------------------------------------------------ host ----
if ! command -v distrobox >/dev/null; then
  echo "distrobox is not installed. Once: sudo apt install -y podman distrobox" >&2
  exit 1
fi
if ! distrobox list 2>/dev/null | awk -F'|' 'NR>1 {gsub(/ /,"",$2); print $2}' | grep -qx "$BOX"; then
  distrobox create --name "$BOX" --image "$IMAGE" --yes
fi
exec distrobox enter "$BOX" -- "$ROOT/scripts/distrobox-build.sh" --inside
