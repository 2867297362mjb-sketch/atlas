# Running the Linux binary on an older glibc than the host that built it

_Research note, 2026-11-06, branch `0.4.1` at `c58acf8f`. Measured on this Ubuntu 26.04.1
host (libc6 2.43-2ubuntu2.4, gcc 15.2.0-16ubuntu1, libstdc++6 16-20260322-1ubuntu1,
rustc 1.99.1) against `target/release/atlas`, built here on 2026-11-05 and byte-identical
to the installed `/usr/bin/atl` (sha256 `8312c461…`). No docker, podman or zig on this
machine, so nothing below was run on an older glibc, and nothing was built: a Linux build
is ~1 h and ~20 GB. Every run of `release-linux.yml` on this branch and on
`maklu/linux-release` failed before its `Verify` step (§3), so no Ubuntu-22.04-built binary
was measured either; where the note reasons about one it says so._

_Corrected 2026-11-18 at `1175af2d`, where a review found claims that were wrong at
`c58acf8f`; each fix is marked **Correction**. One measurement was added: the binary from
the `ubuntu:24.04` distrobox build of 2026-11-08 (GCC 13, glibc 2.39)._

## Question

The deb built on an Ubuntu 26.04 laptop does not install on Debian 13 (`libc6 (>= 2.43)`
against 2.41), and GitHub is retiring the `ubuntu-22.04` runners the release is built on.
What sets the glibc floor of the Linux binary, which approaches can build for a floor older
than the build host, and what should the release build on when `ubuntu-22.04` goes?

## Method

The floors were read from the binary and the deb on this host (`objdump -T`, `readelf -V`,
`dpkg-deb`), the release's own pins from the workflow and scripts at `c58acf8f`, and each
approach from its primary source: the project's README, docs or source, the GCC and glibc
release notes, and GitHub's runner-image announcements. Nothing was built or run on an
older glibc (header above). Sources are listed at the end.

## Answer

The floor a binary needs is set at link time by the newest glibc symbol version it
references, and nothing in a package can lower it afterwards. The Ubuntu 22.04 release
build already satisfies Debian 13 (2.35 ≤ 2.41); the deb built on this Ubuntu 26.04 laptop
does not (`libc6 (>= 2.43)`, from one `libm` symbol, `asinf@GLIBC_2.43`), and would also
fail on Ubuntu 22.04 and Debian 12 through `__isoc23_strtol@GLIBC_2.38`, which glibc
2.38+'s own headers pull into any C dependency built as C23 (GCC 15's new default) or with
`_GNU_SOURCE` (**Correction:** not GCC 15 alone; a GCC 13 build against glibc 2.39 has it
too, §2). Of the ten approaches, only building
against an old glibc (a `container:` job on the retiring runner's successor), post-link
patching (polyfill-glibc) and zig's glibc stubs (cargo-zigbuild) can actually move the
floor; the rest either cannot see Rust's own references (`.symver` headers), cannot host
a dynamically linked GTK app (musl), or kill the agent's bubblewrap sandbox (Flatpak,
glibc-bundling AppImages). Recommendation: when `ubuntu-22.04` retires on 2027-04-17
(brownouts from 2027-03-23), run the same job inside `container: ubuntu:22.04` on
`ubuntu-24.04` / `ubuntu-24.04-arm`, which keeps the 2.35 / libstdc++ 12 floor exactly as
it is; move to `debian:bookworm` (2.36) when Ubuntu 22.04 is dropped from the support
table. Fallback for a host-runner build: `gcc-12` for the C/C++ dependencies plus
polyfill-glibc `--target-glibc=2.35`, which today covers every symbol in this binary
except `asinf@GLIBC_2.43` (a one-line upstream rename away). **Correction:** that fallback
works on x86-64 only; on aarch64 GCC 12 cannot build numkong (§7).

## 1. The distros: glibc, WebKitGTK, GCC

Versions read from the distros' own package indexes on 2026-11-06. "gcc" is the default
compiler, which is what sets the libstdc++ *symbols* a C++ dependency built there needs;
"libstdc++6" is the runtime, which is what an installed binary gets.

| distro                   | glibc (libc6)                                                                                   | libwebkit2gtk-4.1-0                                                                                                                                                                                | gcc / libstdc++6                                                                                                                                 | other                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 22.04 jammy       | 2.35 ([2.35-0ubuntu3.15](https://packages.ubuntu.com/jammy/libc6))                              | [2.50.4-0ubuntu0.22.04.1](https://packages.ubuntu.com/jammy/libwebkit2gtk-4.1-0) on amd64; the page lists 2.36.0-2ubuntu1 for arm64, and whether a newer arm64 security build exists is unverified | [gcc 11.2](https://packages.ubuntu.com/jammy/gcc) / [libstdc++6 12.3](https://packages.ubuntu.com/jammy/libstdc++6)                              | bubblewrap [0.6.1](https://packages.ubuntu.com/jammy/bubblewrap); GitHub runner retires 2027-04-17 (§4)                                                                                                                            |
| Debian 12 bookworm       | 2.36 ([2.36-9+deb12u14](https://sources.debian.org/api/src/glibc/))                             | [2.50.6-1~deb12u2](https://sources.debian.org/api/src/webkit2gtk/); [`libwebkit2gtk-4.1-dev` exists](https://packages.debian.org/bookworm/libwebkit2gtk-4.1-dev) on amd64 and arm64                | [gcc 12.2](https://packages.debian.org/bookworm/gcc) / [libstdc++6 12.2](https://packages.debian.org/bookworm/libstdc++6)                        | bubblewrap [0.8.0](https://sources.debian.org/api/src/bubblewrap/); libayatana-appindicator [0.5.92](https://sources.debian.org/api/src/libayatana-appindicator/)                                                                  |
| Ubuntu 24.04 noble       | 2.39 ([2.39-0ubuntu8.9](https://packages.ubuntu.com/noble/libc6))                               | [2.52.6-0ubuntu0.24.04.1](https://packages.ubuntu.com/noble/libwebkit2gtk-4.1-0)                                                                                                                   | [gcc 13.2](https://packages.ubuntu.com/noble/gcc) / [libstdc++6 14.2](https://packages.ubuntu.com/noble/libstdc++6)                              | `ubuntu-latest` today; its runner image also carries gcc 12.4 and 14.2 ([Ubuntu2404-Readme](https://raw.githubusercontent.com/actions/runner-images/main/images/ubuntu/Ubuntu2404-Readme.md))                                      |
| Debian 13 trixie         | 2.41 ([2.41-12+deb13u4](https://sources.debian.org/api/src/glibc/))                             | [2.52.6-1~deb13u1](https://sources.debian.org/api/src/webkit2gtk/)                                                                                                                                 | [gcc 14.2](https://packages.debian.org/trixie/gcc) / [libstdc++6 14.2](https://packages.debian.org/trixie/libstdc++6)                            | bubblewrap [0.12.0](https://sources.debian.org/api/src/bubblewrap/); libayatana-appindicator [0.5.94](https://sources.debian.org/api/src/libayatana-appindicator/); [libglib2.0-0t64 2.84.4](https://packages.debian.org/trixie/libglib2.0-0t64) |
| Ubuntu 26.04 resolute    | 2.43 ([2.43-2ubuntu2.4](https://packages.ubuntu.com/resolute/libc6))                            | [2.52.6-0ubuntu0.26.04.1](https://packages.ubuntu.com/resolute/libwebkit2gtk-4.1-0)                                                                                                                | [gcc 15.2](https://packages.ubuntu.com/resolute/gcc) / libstdc++6 16 (`dpkg -l` here)                                                            | this machine; GCC 15 defaults to C23 (§2)                                                                                                                                                                                          |
| Debian forky / sid       | 2.43 ([2.43-7](https://sources.debian.org/api/src/glibc/))                                      | 2.52.6-1 / 2.54.2-2                                                                                                                                                                                |                                                                                                                                                  |                                                                                                                                                                                                                                    |
| Fedora 42 / 43 / 44 / 45 | 2.41 / 2.42 / 2.43 / 2.44 (package files `glibc-2.4x-*.fcNN` in the [release trees](https://mirrors.kernel.org/fedora/releases/); F42 from the [archive](https://archives.fedoraproject.org/pub/archive/fedora/linux/releases/42/Everything/x86_64/os/Packages/g/)) |                                                                                                                                                                                                    |                                                                                                                                                  |                                                                                                                                                                                                                                    |
| RHEL 9 (AlmaLinux 9.0)   | 2.34 ([release notes](https://wiki.almalinux.org/release-notes/9.0.html))                       |                                                                                                                                                                                                    | gcc 11.2                                                                                                                                         | below today's 2.35 floor                                                                                                                                                                                                           |
| RHEL 10 (AlmaLinux 10.0) | 2.39 ([release notes](https://wiki.almalinux.org/release-notes/10.0.html))                      |                                                                                                                                                                                                    | gcc 14.2                                                                                                                                         |                                                                                                                                                                                                                                    |

Tauri's own guidance is the same baseline this table implies: "you must build your Tauri
application using the oldest base system you intend to support", naming Ubuntu 22.04 and
Debian 12 because both have WebKitGTK 4.1, and "We recommend using a Docker container or
GitHub Actions" ([distribute/debian](https://v2.tauri.app/distribute/debian/),
[distribute/appimage](https://v2.tauri.app/distribute/appimage/)). Its GitHub pipeline
example pins `ubuntu-22.04` and `ubuntu-22.04-arm`
([distribute/pipelines/github](https://v2.tauri.app/distribute/pipelines/github/)).

## 2. What raises the floor: the local binary

`objdump -p` NEEDED: `libstdc++.so.6 libgdk-3.so.0 libgdk_pixbuf-2.0.so.0 libgobject-2.0.so.0
libglib-2.0.so.0 libcairo.so.2 libdbus-1.so.3 libwebkit2gtk-4.1.so.0 libgtk-3.so.0
libsoup-3.0.so.0 libgio-2.0.so.0 libjavascriptcoregtk-4.1.so.0 libc.so.6
ld-linux-x86-64.so.2 libgcc_s.so.1 libm.so.6 libmvec.so.1`.

`objdump -T | grep -c GLIBC_` = 273 versioned glibc references, over 27 version nodes.
Everything the 22.04 floor does not already cover:

| version    | symbols                                                                                                                        | where from                                                                                                                                                                                                                                                                                                                                                                                                             | hard?                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GLIBC_2.43 | `asinf` (libm)                                                                                                                 | glibc 2.43 added correctly-rounded `asinf` from CORE-MATH (`/usr/share/doc/libc6/NEWS.gz` here, "Optimized and correctly rounded … asinf …"); this host's `libm.so.6` defines both `asinf@GLIBC_2.2.5` and `asinf@@GLIBC_2.43`, and a link binds the default, the newest. Any program calling `asinf` (Rust `f32::asin`) linked on a 2.43 host gets it.                                                                       | yes                                                                                                          |
| GLIBC_2.39 | `pidfd_spawnp`, `pidfd_getpid`                                                                                                 | Rust std's `process` since [rust-lang/rust#126827](https://github.com/rust-lang/rust/pull/126827) (1.81), weak linkage. Built on a glibc that has them, the reference is versioned.                                                                                                                                                                                                                                          | **no** — `readelf -V` marks the `GLIBC_2.39` need `Flags: WEAK` (below)                                      |
| GLIBC_2.38 | `__isoc23_strtol`, `__isoc23_sscanf`                                                                                           | GCC 15 "changes the default language version for C compilation from -std=gnu17 to -std=gnu23" ([gcc-15/changes](https://gcc.gnu.org/gcc-15/changes.html)); in C23 mode this host's `/usr/include/stdlib.h:219-221` redirects `strtol` to `__isoc23_strtol` (glibc 2.38's binary-literal support, [NEWS](https://raw.githubusercontent.com/bminor/glibc/release/2.38/master/NEWS)). Emitted by the C dependencies `cc` builds here: aws-lc-sys, bzip2-sys, libmimalloc-sys, libsqlite3-sys, numkong, onig_sys, tree-sitter, usearch, zstd-sys (`~/.cargo/registry/src`). | yes                                                                                                          |
| GLIBC_2.34 | 27 symbols: `__libc_start_main`, `dlopen`/`dlsym`/`dlclose`/`dlerror`, 21 `pthread_*`, `openpty`                               | glibc 2.34 folded libpthread, libdl and libutil into libc; `__libc_start_main@GLIBC_2.34` comes from the host's `crt1.o`. Every binary linked on glibc ≥ 2.34 carries these.                                                                                                                                                                                                                                                | yes — this is why a 22.04 (2.35) build can never reach RHEL 9's 2.34 by accident, but might reach it exactly |
| GLIBC_2.33 | `stat`, `stat64`, `fstat`, `fstat64`, `fstatat64`, `lstat64`                                                                   | glibc 2.33 made the `stat` family real symbols.                                                                                                                                                                                                                                                                                                                                                                        | yes                                                                                                          |

**Correction:** the `GLIBC_2.38` row's cause is incomplete. glibc turns the redirect on
whenever `_GNU_SOURCE` is defined, not only in C23 mode: `_GNU_SOURCE` defines
`_ISOC23_SOURCE` (`/usr/include/features.h:218-226` here), and `__GLIBC_USE_C23_STRTOL`,
which conditions the redirect, follows it (`features.h:504-513`). So a C dependency that
defines `_GNU_SOURCE` gets `__isoc23_*` from any glibc 2.38+ headers, whatever its `-std`.
Measured 2026-11-18: the `ubuntu:24.04` build (GCC 13, default `-std=gnu17`, glibc 2.39)
still references `__isoc23_sscanf` and `__isoc23_strtol` at `GLIBC_2.38`, non-weak
(`objdump -T`). Only headers older than 2.38 avoid the pair.

Weak version needs are not fatal. glibc's loader, `match_symbol` in
[`elf/dl-version.c`](https://raw.githubusercontent.com/bminor/glibc/master/elf/dl-version.c):
when a needed version is missing and the need is weak, it `return 0` (silently unless
verbose, where it prints "weak version `%s' not found"); only a non-weak miss reports
"version `%s' not found (required by %s)" and fails. The per-library needs in this binary:

```
libc.so.6:   … GLIBC_2.34 (none)  GLIBC_2.38 (none)  GLIBC_2.39 (WEAK)
libm.so.6:   GLIBC_2.2.5  GLIBC_2.27  GLIBC_2.29  GLIBC_2.43
libmvec.so.1: GLIBC_2.22
libstdc++.so.6: GLIBCXX_3.4 … GLIBCXX_3.4.22, CXXABI_1.3, CXXABI_1.3.9, CXXABI_1.3.15
```

So the real floor of this binary is **2.43** (libm), then 2.38; the 2.39 entry would not
stop it loading. `scripts/verify-linux-release.sh` and `scripts/package-linux.sh` take the
highest tag `objdump -T` prints, weak or not, so a build on a 2.39–2.42 host (Ubuntu 24.04,
Debian 13) would be reported one notch too high. Harmless on the 22.04 builder, where
glibc has no `pidfd_spawnp` and Rust emits an unversioned weak reference instead
([the `weak!` commit](https://github.com/mozilla/rust/commit/5ff6ac4287e191ee684f1de1af642e7b656947b6)),
but worth fixing (§7).

**libstdc++.** `__cxa_call_terminate@CXXABI_1.3.15` is the newest C++ symbol; GCC 14 introduced
CXXABI_1.3.15, so this binary needs `libstdc++6 >= 14`
(`docs/research/deb-dependencies-cargo-deb.md` §4 traced it). The GLIBCXX side tops out at
3.4.22 (GCC 6). The C++ in the tree is usearch/numkong (via `atlas-memory`) and the `cxx`
bridges; everything else `cc` builds is C. A 26.04 build therefore fails on Debian 12 and
Ubuntu 22.04 twice over: `libc6` and `libstdc++6`.

**The deb this host produces** (`dpkg-deb -f target/release-linux/tryatlas_0.4.1_amd64.deb`):
`Depends: libc6 (>= 2.43), libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1,
libglib2.0-0, bubblewrap`. That is the Debian 13 refusal `package-linux.sh` warns about,
reproduced.

## 3. Is anything wrong today for Debian 13?

**The release built in CI (Ubuntu 22.04): no, on paper.** glibc 2.35 ≤ 2.41 and
libstdc++ 12 ≤ 14. Every name in `scripts/linux/runtime-deps.sh` exists on trixie:
`libwebkit2gtk-4.1-0` 2.52.6, `libgtk-3-0` and `libglib2.0-0` through the time64 packages'
`Provides:` (verified on this Ubuntu's `apt-cache` in `deb-dependencies-cargo-deb.md` §3;
trixie's own `Provides:` line is not shown on packages.debian.org, so that half is inferred
from the Debian-wide transition rather than read), `libayatana-appindicator3-1` 0.5.94,
`bubblewrap` 0.12.0. Two caveats:

- Nothing has proven it. The last eight `release-linux.yml` runs on this branch were
  cancelled or failed; the two completed runs on `maklu/linux-release` (41808740456,
  41802575612) failed in "Build frontend, binary and AppImage" and the Arch docker step,
  before `Verify`. The install matrix in `verify-linux-release.sh` is `ubuntu:22.04`,
  `debian:12`, `ubuntu:24.04`, `fedora:latest`, `archlinux:latest`: Debian 13 is not in it.
- The 22.04 binary's *actual* floor is unmeasured. It is at least 2.34 (§2) and at most
  2.35; if nothing in the tree references a 2.35-only symbol, RHEL 9 is already inside
  the floor and the support table is stricter than the binary. Only a finished CI run
  can say (§7 asks `Verify` to write the number to the job summary).

**The deb built on the developer's Ubuntu 26.04: yes, twice.** apt refuses it
(`libc6 (>= 2.43)` against 2.41), and a forced install would fail at launch on
`asinf@GLIBC_2.43`. The same deb also fails on Ubuntu 22.04 / Debian 12 on
`__isoc23_strtol@GLIBC_2.38` and `CXXABI_1.3.15`. **Correction:** this said
`CFLAGS=-std=gnu17` would remove the 2.38 pair. It does not: dependencies that define
`_GNU_SOURCE` keep it (§2), and a GCC 13 build, whose default is `gnu17`, still has both.
Only building against glibc older than 2.38 removes it, and nothing short of linking
against an older `libm` removes the 2.43 one. The warning `package-linux.sh` prints is the right behaviour for a local build.

## 4. The two external clocks

- **`ubuntu-22.04` runners**, x86-64 and arm alike: "The Ubuntu 22 based runner images will
  begin deprecation on September 17th and will be fully unsupported by April 17th"
  ([ubuntu22/20260810.260](https://github.com/actions/runner-images/releases/tag/ubuntu22%2F20260810.260),
  [ubuntu22-arm64/20260628.47](https://github.com/actions/runner-images/releases/tag/ubuntu22-arm64%2F20260628.47)).
  The tracking issue, [#14254](https://github.com/actions/runner-images/issues/14254)
  (opened 2026-06-16), gives the years: "Deprecation: September 17th, 2026", "Retirement:
  April 17th, 2027", with brownouts on March 23, March 30, April 6 and April 13 (14:00 to
  00:00 UTC; the year is not stated, and can only be 2027). That is also the month Ubuntu
  22.04's five-year standard support ends (not fetched; Ubuntu's release-cycle page).
- **Node 24 for JavaScript actions**: "Beginning on June 16th, 2026, runners will begin using
  Node24 by default"; Node 20 removed September 23, 2026;
  `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true` "will only work until we upgrade the
  runner and remove Node20"
  ([changelog 2025-09-19](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)).
  As of this note both dates have passed, so the escape hatch is gone. Node 24's official
  Linux binaries need "glibc >= 2.28" and libstdc++ ≥ 6.0.25 on x64 and arm64
  ([nodejs BUILDING.md, v24.x](https://raw.githubusercontent.com/nodejs/node/v24.x/BUILDING.md)).
  In a `container:` job the runner injects its own node into the container
  (`/__e/node20/bin/node: … version 'GLIBC_2.28' not found` on `debian:bullseye`-era
  images, [actions/checkout#1590](https://github.com/actions/checkout/issues/1590)), so the
  container's glibc must be ≥ 2.28. `ubuntu:22.04` (2.35) and `debian:bookworm` (2.36) both
  clear it with room; the constraint only bites below Debian 10.

## 5. The approaches

### 5.1 Build on the oldest base (status quo, then a `container:` job)

How it works: the linker binds each reference to the default version the build host's
glibc exports, so a 2.35 host yields a ≤ 2.35 binary. Today that host is the
`ubuntu-22.04` runner. After 2027-04-17 the same thing is `runs-on: ubuntu-24.04` /
`ubuntu-24.04-arm` with `container: { image: ubuntu:22.04 }` (later `debian:bookworm`).

- **Applies to Atlas:** entirely; it is what the workflow already relies on, and the C/C++
  dependencies get the base's compiler, so the libstdc++ floor follows for free.
  **Correction:** this said "the base's GCC". That holds on x86-64; on aarch64 the
  workflow sets `CC` to Clang (`clang-15` at `c58acf8f`, Clang 18 from apt.llvm.org since
  `e80fca0c`), because jammy's GCC cannot build numkong's dot-product code. That Clang
  links the system libstdc++ 12, so the floor still follows.
- **Architectures:** `ubuntu` on Docker Hub ships `amd64 … arm64v8` for `22.04` and `24.04`
  ([hub.docker.com/_/ubuntu](https://hub.docker.com/_/ubuntu)); `debian:bookworm` likewise
  (not fetched). The 24.04 runner image has Docker Server 28.0.4; the arm64 image is
  documented by the same README, and the workflow's `VERIFY_INSTALL=1` already assumes
  Docker on the arm runner, but no run has exercised it.
- **Floors by base:** `ubuntu:22.04` → 2.35 / libstdc++ 12 (status quo: Ubuntu 22.04+,
  Debian 12+, RHEL 10, Fedora 36+); `debian:bookworm` → 2.36 / 12 (drops Ubuntu 22.04
  nominally; keeps Debian 12, RHEL 10); `ubuntu:24.04` → 2.39 / 14 (drops Ubuntu 22.04 and
  Debian 12, keeps RHEL 10 at exactly 2.39); `debian:trixie` → 2.41 / 14 (drops RHEL 10
  too).
- **Workflow cost:** container steps run as root with no `sudo` in the base image (drop the
  prefix); `actions/checkout` needs `git` in the container or it falls back to a tarball
  without history, so a `run: apt-get install -y git curl ca-certificates` step must come
  first; `jdx/mise-action`, `mozilla-actions/sccache-action` and `Swatinem/rust-cache` are
  JavaScript actions, so they run on the injected Node 24 (§4) — expected to work, not
  verified here; `HOME` becomes `/github/home`, which moves rust-cache's paths. The
  `docker run` steps (Arch package, `VERIFY_INSTALL`) need the host's socket mounted
  (`options: -v /var/run/docker.sock:/var/run/docker.sock`) or, cleaner, a second host job
  that downloads the artifacts and runs `Verify` there; the published artifacts are
  identical either way. A prebuilt image (`ghcr.io/…/linux-builder:jammy` with the apt
  list from the "Install system build dependencies" step baked in) removes the apt step
  from every run and pins the toolchain the release is built with, at the cost of one more
  thing to maintain.
- **Risks:** apt on `ubuntu:22.04` stops receiving updates after April 2027 but keeps
  serving; `debian:bookworm` has LTS until mid-2028. Both images keep `libwebkit2gtk-4.1-dev`
  at the versions in §1.
- **Verdict: the mechanism to keep.** It is the only approach that leaves the binary, the
  `Verify` step, the deb's `Depends` computation and `linux-support.md` untouched.

### 5.2 cargo-zigbuild (`x86_64-unknown-linux-gnu.2.35`)

How it works: `zig cc` ships glibc headers and link-time stubs for every glibc version and
`cargo zigbuild --target <triple>.<glibc>` links against the requested one
([cargo-zigbuild README](https://github.com/rust-cross/cargo-zigbuild)); the C
dependencies are compiled by zig's clang against the same headers, so the `__isoc23_*`
redirect never happens. It always passes `-nostdinc`; headers from the host need
`CFLAGS='-isystem /usr/include'` and libraries `RUSTFLAGS='-L /usr/lib64'`. "Certain
`RUSTFLAGS` like `-C linker` opt-out of using Zig" (`.cargo/config.toml` sets none, so no
conflict).

- **The sysroot question.** zig has no GTK. The link needs `libgtk-3.so`, `libwebkit2gtk-4.1.so`
  and friends from *somewhere*, and the host's copies turn out to be usable: none of
  `libgtk-3`, `libglib-2.0`, `libgobject-2.0`, `libwebkit2gtk-4.1`, `libjavascriptcoregtk-4.1`,
  `libsoup-3.0` define symbol versions of their own (`readelf -V` here: 0 version
  definitions each), so a link records only sonames and symbol names, never "the host's
  GTK version". The gtk-rs / webkit2gtk-rs bindings are pre-generated and feature-gated
  (wry 0.57.1 pins `webkit2gtk = "=2.0.2"` with `v2_38`, tauri adds `webkit2gtk/v2_40`),
  so the API floor is set by cargo features, not by whichever headers are on disk. The
  remaining catch is the linker: zig's lld does not follow a shared library's own
  `DT_NEEDED` (GNU ld does, and would see the host's `libgtk-3.so.0` needing
  `GLIBC_2.43` against zig's 2.35 stub). Plausible, and unverified: nobody has reported
  building a Tauri app this way (the closest reports are glibc-suffix fixes on plain
  binaries, [cargo-zigbuild#231](https://github.com/rust-cross/cargo-zigbuild/issues/231)).
- **What it replaces under the binary:** `-lgcc_s` becomes `-lunwind`, zig's static LLVM
  libunwind ([`src/zig/linker_args.rs`](https://github.com/rust-cross/cargo-zigbuild/blob/main/src/zig/linker_args.rs)
  line 109-110); C++ goes to zig's libc++ rather than libstdc++ (the `-lc++` swap in that
  file is windows-gnu only, so what happens to Linux's `-lstdc++` is unverified). Either
  way the process then holds two unwinders and two C++ runtimes, because WebKitGTK and
  JavaScriptCore load the system `libgcc_s` and `libstdc++`. `panic = "unwind"` in the root
  `Cargo.toml` is load-bearing (three `catch_unwind` guards), and a Rust panic unwinding
  through a GTK callback frame would cross from one unwinder's tables to the other's.
  Unverified whether that works; it is the kind of thing that works until it does not.
- **C/C++ dependencies:** `cc` picks up `CC_x86_64_unknown_linux_gnu` from the wrapper;
  aws-lc-sys uses CMake, which needs `CMAKE_TOOLCHAIN_FILE` (the README lists it as a
  variable for build scripts); numkong/usearch are C++ and would compile against zig's
  libc++ headers. Zig 0.15+ "bundles libc++ 19 headers which require a compatible
  libclang version" for bindgen (none in the tree).
- **Architectures:** both, natively; `aarch64-unknown-linux-gnu.2.35` on an arm runner, or
  cross from x86-64 *if* an aarch64 GTK sysroot is supplied, which reintroduces the problem
  zig was meant to remove.
- **Workflow cost:** zig and cargo-zigbuild installs, `--target` on every cargo call
  (`target/<triple>/release` paths move; the Tauri CLI's `--runner cargo-zigbuild --target`
  parse of a `.2.35` suffix is unverified), new sccache keys.
- **Verdict: not for the release.** It solves the glibc side and the C23 side, but a GTK
  app with a C++ runtime underneath WebKit is the worst case for "two of everything".
  Worth one experiment on a branch if 5.1 ever becomes impossible.

### 5.3 polyfill-glibc (post-link patching)

How it works: `polyfill-glibc --target-glibc=2.35 atlas` rewrites the ELF's dynamic symbol
and version tables, replacing every reference newer than the target with an older symbol,
a different library, or a polyfill linked into the file
([How_does_polyfill_glibc_work](https://github.com/corsix/polyfill-glibc/blob/master/docs/How_does_polyfill_glibc_work.md)).

- **Architectures:** "only implemented for x86_64 and aarch64" — exactly Atlas's two
  ([Limitations.md](https://github.com/corsix/polyfill-glibc/blob/master/docs/Limitations.md)).
- **Coverage, read from its rename tables** (`src/x86_64/renames.txt`, `src/aarch64/renames.txt`,
  both stop at `@GLIBC_2.39`): `__libc_start_main@GLIBC_2.34 → polyfill`,
  `dlopen@GLIBC_2.34 → libdl.so.2::dlopen@GLIBC_2.2.5`, `pthread_create@GLIBC_2.34 →
  libpthread.so.0::…@GLIBC_2.2.5`, `openpty@GLIBC_2.34 → libutil.so.1`, `stat64@GLIBC_2.33 →
  polyfill`, `__isoc23_strtol@GLIBC_2.38 → polyfill`, `__isoc23_sscanf@GLIBC_2.38 →
  __isoc99_sscanf@GLIBC_2.7` ("the `%i` format will no longer recognise binary numbers"),
  `pidfd_spawnp@GLIBC_2.39 → polyfill`. Weak needs above the target are dropped, not
  treated as errors (`renamer.c`: `!(i->flags & VER_FLG_WEAK)` guards `ver_bad`).
  **`asinf@GLIBC_2.43` has no rule**, so on this host's binary the tool stops with "Cannot
  change target version … due to missing knowledge about how to handle:" and leaves the
  file unchanged. The fix is one table line by analogy with the existing
  `asinf32@GLIBC_2.27 asinf@GLIBC_2.2.5` (line 586): a pull request, or a patched copy.
- **libstdc++:** "Only glibc functions are polyfilled … libstdc++ uses symbol versions
  starting with `GLIBCXX_3.`, but these are libstdc++ functions rather than glibc
  functions". So `CXXABI_1.3.15` stays, and a GCC-14+ host still produces a binary Debian
  12 cannot load; polyfill-glibc needs an old GCC beside it (5.10).
- **Maturity and licence:** MIT (README; GitHub's own detector says `NOASSERTION`), 464
  stars, no releases, built from source with ninja, last pushed 2026-08-22. Polyfill
  correctness is the project's, not glibc's; `Limitations.md` lists the deviations
  per function.
- **Interaction with the release:** run it on `target/release/atlas` *before*
  `package-linux.sh` (which computes `libc6 (>= …)` from the patched file) and `Verify`
  (which reads the patched file and would pass at the lowered number). `strip = "symbols"`
  touches `.symtab`, not the dynamic tables the tool edits — expected fine, unverified. It
  adds the 2.34 split libraries back as `DT_NEEDED` (`libdl.so.2`, `libpthread.so.0`,
  `libutil.so.1`), which exist as stubs on every glibc ≥ 2.34, and grows the file.
- **Verdict: the right fallback, not the primary.** It is the only approach that lowers a
  binary that already exists, which is the developer-laptop case, and it fails loudly
  rather than quietly when it meets a symbol it does not know.

### 5.4 Link-time symbol pinning (`.symver`, glibc_version_header)

[glibc_version_header](https://github.com/wheybags/glibc_version_header) generates a
header of `.symver sym, sym@GLIBC_x.y` directives and asks for `-include` on every
compilation unit; "So far, this work on x86_64 code only", "Weak symbols don't work", and
C++ needs libstdc++ rebuilt with it. `.symver` is an assembler directive scoped to the
object file it appears in; it changes the version *that object* references. Rust std's
references (`__libc_start_main`, `pthread_*`, `dlopen`, `stat64`, `pidfd_spawnp`) are
emitted by rustc from the `libc` crate's `extern` blocks into std's rlib, which no header
reaches, and `#[link_name]` cannot carry an `@GLIBC_` suffix. A `global_asm!(".symver …")`
in an Atlas crate would only pin references inside that crate's object. The C dependencies
could take the header through `CFLAGS`, which would address the `__isoc23_*` pair and
nothing else. **Verdict: no**, by construction.

### 5.5 An older sysroot with the host toolchain

`gcc --sysroot=/opt/bookworm` (or `-B`) plus `PKG_CONFIG_SYSROOT_DIR`, with a bookworm root
unpacked by `mmdebstrap`/`debootstrap` carrying glibc, libstdc++ and every `-dev` package
of §1. It works where the compiler honours the sysroot: C headers come from the old glibc
(so no C23 redirect), `crt1.o` and `libc.so` from the old tree. What does not follow: the
host GCC 15's own `libstdc++` headers and `libgcc`, which still emit `CXXABI_1.3.15` unless
the sysroot's GCC 12 is used for C++ as well — at which point this is a cross toolchain,
and a container is the same artifact with one `image:` line instead of a hand-built tree.
Nix pinning an old nixpkgs gives the same thing with store paths in `RUNPATH` to patch out.
**Verdict: no on CI** (5.1 is strictly simpler); **maybe on a laptop without Docker**, where
`podman` or a `systemd-nspawn` of the same unpacked root is still less work than a sysroot.

### 5.6 Static / musl

A static binary cannot `dlopen` (libappindicator-sys loads `libayatana-appindicator3.so.1`
at run time, `deb-dependencies-cargo-deb.md` §2; GLib loads GIO modules), and there is no
musl build of GTK 3 or WebKitGTK to link against; a musl-static executable that `dlopen`s
glibc libraries is unsupported by both libcs. **Verdict: no.**

### 5.7 Flatpak / Snap

Flatpak replaces the host's libraries with a runtime; Tauri's guide uses `org.gnome.Platform`
46/47 and installs the binary from a built or downloaded deb
([distribute/flatpak](https://v2.tauri.app/distribute/flatpak/)). The glibc question
disappears: the binary is built in the SDK and runs on the matching runtime on any host.
The agent sandbox does not survive it. Flatpak's own seccomp filter, `setup_seccomp()` in
[`common/flatpak-run.c`](https://raw.githubusercontent.com/flatpak/flatpak/main/common/flatpak-run.c),
blocks "subnamespace setups": `unshare`, `setns`, `mount`, `umount2`, `pivot_root`,
`chroot` with `EPERM`, and `clone` whenever `CLONE_NEWUSER` is set; it also passes
`--disable-userns` to its own bubblewrap ("Disable recursive userns for all flatpak
processes"). `bwrap` inside the sandbox therefore cannot create the namespaces the
engine's `LinuxSeccomp` sandbox needs. `flatpak-spawn --host` escapes to the host, but the
helper the engine re-execs is Atlas's own binary through the `atlas-engine-linux-sandbox`
alias (`crates/atlas-native-agent/src/linux_sandbox.rs`), and `/app/bin/atl` does not
exist on the host, so the alias would have to point at a second, host-installed helper —
a different architecture, and `--talk-name=org.freedesktop.Flatpak` is the "sandbox
escape" permission reviewers flag. Snap: Tauri's recipe is `base: core22`,
`confinement: strict` ([distribute/snapcraft](https://v2.tauri.app/distribute/snapcraft/)),
i.e. Ubuntu 22.04's glibc 2.35 — the same floor as today, and strict confinement's
AppArmor profile has the same objection to nested namespaces (not verified here).
**Verdict: no**, for the sandbox, independent of glibc.

### 5.8 AppImage bundling glibc

Tauri's AppImage is made by linuxdeploy, whose exclude list is generated from the
AppImage project's: "This file lists libraries that we will assume to be present on the
host system", with `libc.so.6` and `ld-linux-x86-64.so.2` under "part of the GNU C Library
which should never be bundled" and `libstdc++.so.6` excluded as a "Workaround for:
`GLIBCXX_3.4.21' not found" ([excludelist](https://raw.githubusercontent.com/AppImage/pkg2appimage/master/excludelist),
[linuxdeploy's generator](https://raw.githubusercontent.com/linuxdeploy/linuxdeploy/master/src/core/generate-excludelist.sh)).
appimage-builder does the opposite: it bundles "almost every dependency inside the
AppImage (including glibc and family)" and selects "at runtime the newer glibc version to
be used while running the bundled app using a custom AppRun", while advising against it
when "the target application can be built on the oldest and still maintained LTS
distribution" ([FAQ](https://appimage-builder.readthedocs.io/en/latest/faq.html)). For
Atlas it breaks the helper: a bundled loader runs as `ld-linux-x86-64.so.2 … atlas`, so
`/proc/self/exe` and `current_exe()` name the loader, and the alias `install_alias` writes
would point at it; bubblewrap re-enters the helper by that path inside a namespace where
the FUSE mount of the AppImage is not bound. It also helps only the AppImage, not the deb,
rpm, Arch package or tarball. **Verdict: no.**

### 5.9 The Rust toolchain's own floor

`x86_64-unknown-linux-gnu`: "64-bit Linux (kernel 3.2+, glibc 2.17+)";
`aarch64-unknown-linux-gnu`: "ARM64 Linux (kernel 4.1+, glibc 2.17+)"
([platform-support](https://doc.rust-lang.org/rustc/platform-support.html)). The 2.17
baseline dates from Rust 1.64 ([blog, 2022-08-01](https://blog.rust-lang.org/2022/08/01/Increasing-glibc-kernel-requirements/),
[compiler-team#493](https://github.com/rust-lang/compiler-team/issues/493)); no later
proposal to raise it was found. Rust therefore bounds nothing Atlas would want: the
practical floor of any build is set by the glibc it links against (≥ 2.34 on any modern
host, §2), and only 5.2 and 5.3 can go below that.

### 5.10 The libstdc++ side

The need comes from the C++ dependencies `cc` compiles with the host `g++`: a GCC 14+ host
emits `CXXABI_1.3.15`, a GCC 12 host at most `CXXABI_1.3.13` / `GLIBCXX_3.4.30`. Per approach:
5.1 solves it by construction (the base's GCC); 5.2 swaps in zig's libc++, statically, with
the two-runtimes hazard above; 5.3 and 5.4 do nothing for it; 5.5 only if the sysroot's
GCC is used for C++. The other lever is `-C link-arg=-static-libstdc++` (plus
`-static-libgcc`), which removes the `GLIBCXX_`/`CXXABI_` needs from the binary — but
WebKitGTK still loads the system `libstdc++.so.6`, and GNU ld exports from an executable
every symbol a linked shared library references, so WebKit's `operator new`, `__cxa_*`
and friends would bind to the static copy inside Atlas. `-Wl,--exclude-libs,ALL` keeps
the archive's symbols out of the export table and is the standard mitigation; unverified
here, and a reason to prefer letting the base decide. Whatever is chosen, keep
`package-linux.sh`'s `LIBSTDCXX_FLOOR` check and have `Verify` enforce it too (today it
checks glibc only).

## 6. Comparison

| approach                               | moves the glibc floor | moves the libstdc++ floor | x86_64 / aarch64 | deb, rpm, AppImage, tarball alike | agent sandbox intact | workflow change        | verdict                    |
| -------------------------------------- | --------------------- | ------------------------- | ---------------- | --------------------------------- | -------------------- | ---------------------- | -------------------------- |
| 5.1 old base in a `container:` job     | yes (base's)          | yes (base's GCC)          | yes / yes        | yes                               | yes                  | small, one job         | **keep; the plan**         |
| 5.2 cargo-zigbuild                     | yes (any ≥ 2.17)      | replaces with static libc++ | yes / yes      | yes                               | unknown (unwinder)   | medium, every cargo call | experiment only          |
| 5.3 polyfill-glibc                     | yes, to 2.17 (x86_64, aarch64) | no               | yes / yes        | yes                               | yes                  | one post-link step     | **fallback**, after `asinf` |
| 5.4 `.symver` headers                  | C only; not Rust std  | no                        | x86_64 only      | —                                 | —                    | —                      | no                         |
| 5.5 older sysroot, host toolchain      | yes                   | only with the old GCC     | yes / yes        | yes                               | yes                  | large, hand-built tree | no on CI                   |
| 5.6 musl / static                      | n/a                   | n/a                       | —                | —                                 | —                    | —                      | no                         |
| 5.7 Flatpak / Snap                     | sidesteps it          | sidesteps it              | yes / yes        | one more format                   | **no**               | large                  | no                         |
| 5.8 AppImage bundling glibc            | sidesteps it          | sidesteps it              | yes / yes        | AppImage only                     | **no**               | medium                 | no                         |
| 5.9 Rust's floor                       | bounds at 2.17        | —                         | —                | —                                 | —                    | —                      | not a constraint           |

## 7. Recommendation, fallback, and what they would touch

**Now, before 2027-03-23 (first brownout):** move `build-linux` to
`runs-on: ubuntu-24.04` / `ubuntu-24.04-arm` with `container: { image: ubuntu:22.04 }`. The
binary, its floor (2.35 / libstdc++ 12), the support table and every script stay as they
are; the only new facts are the container plumbing in §5.1. Do it on a PR so the dry run
exercises it, and read `Verify`'s "needs glibc X" line for the first measured floor of a
22.04 build (§3).

**Later, when Ubuntu 22.04 leaves the support table:** change the image to
`debian:bookworm` and `GLIBC_FLOOR` to `2.36`, in the same change as
`docs/reference/linux-support.md`. If the measured floor of the bookworm build is still
2.34 or 2.35, the table can keep Ubuntu 22.04 (and gain RHEL 9) on evidence rather than
on the builder's version.

**Fallback, if `container:` jobs cannot be made to carry the Docker-dependent steps:**
stay on the host runner `ubuntu-24.04(-arm)`, build the C/C++ dependencies with
`CC=gcc-12 CXX=g++-12` (both in the runner image, §1) so the libstdc++ floor stays 12 and
GCC's C default stays gnu17, and run polyfill-glibc `--target-glibc=2.35` on the binary
before packaging. Its tables cover every symbol a 2.39 host adds (§5.3); `Verify` keeps
enforcing the number. For the developer laptop the same two steps apply, once
`asinf@GLIBC_2.43` has a rename upstream or in a vendored copy.

**Correction:** as written, the fallback works on x86-64 only. On `ubuntu-24.04-arm`,
GCC 12 cannot build numkong either (`release-linux.yml`, the Clang 18 step's comment at
`1175af2d`: "GCC 12 wraps them the same way"), so aarch64 needs Clang 18 there too;
whether that Clang can be held to libstdc++ 12 on a 24.04 host is not checked. Keeping
GCC's C default at `gnu17` does not avoid `__isoc23_*` either (§2); polyfill-glibc's
tables cover that pair (§5.3).

Changes either path implies, none made here:

- `.github/workflows/release-linux.yml`: the `build-linux` matrix (`runner` → `ubuntu-24.04`,
  `ubuntu-24.04-arm`, plus `container:`), the header comment that explains the 22.04 pin,
  `sudo` dropped from the apt step and `git curl ca-certificates` installed before
  checkout, the Arch `docker run` and `Verify` either given the host socket or moved to a
  host job that consumes the artifacts, `GLIBC_FLOOR` when the base moves.
- `scripts/verify-linux-release.sh`: read version needs with `readelf -V` and ignore
  entries flagged `WEAK` (§2); add `debian:13` (and `ubuntu:26.04`) to the install matrix;
  check the libstdc++ floor the way `package-linux.sh` does; write the measured floors to
  `$GITHUB_STEP_SUMMARY`.
- `scripts/package-linux.sh`: the same weak-aware reading for `libc6 (>= …)`, and the
  comment block about Debian 13 updated to say which host produced which floor.
- `docs/reference/linux-support.md`: "built on Ubuntu 22.04" → "built against Ubuntu 22.04's
  glibc in a container", the table when the base moves, and a line on what a local build
  can and cannot do.
- `CONTRIBUTING.md`: its release section says the workflow "builds x86-64 and aarch64 on
  Ubuntu 22.04 (the glibc floor)" (line 179 at `c58acf8f`), which changes with the runner.
  `docs/architecture.md` does not name it. (**Correction:** this said "not checked".)
- Nothing in the root `Cargo.toml` (`lto = "thin"`, `panic = "unwind"`), `src-tauri/Cargo.toml`
  or `.cargo/config.toml` for 5.1 or 5.3; 5.2 would need a `--target` and would put the
  unwinder question under `panic = "unwind"`.

## 8. Open questions

- The measured floor of a 22.04 build (2.34 or 2.35?) — decides whether RHEL 9 is
  already supported and whether a `bookworm` base keeps Ubuntu 22.04.
- Whether `jdx/mise-action`, `mozilla-actions/sccache-action` and `Swatinem/rust-cache`
  behave inside `container: ubuntu:22.04` on both architectures (Node 24 clears the
  glibc bar; the rest is untested).
- Whether the arm64 24.04 runner image carries Docker as the x64 README says (no completed
  run has used it).
- Whether appimage's FUSE mount and `bwrap` interact in the container-built AppImage the
  same way they do today (nothing changes in the artifact, so presumably yes).
- cargo-zigbuild: what `-lstdc++` becomes on Linux targets, and whether a Rust panic can
  unwind across a GTK frame with zig's libunwind beside the system's `libgcc_s`.
- polyfill-glibc on a `strip = "symbols"` binary, and the fate of `asinf@GLIBC_2.43`
  upstream.
- Ubuntu jammy's current arm64 `libwebkit2gtk-4.1-0` (the package page shows the release
  pocket's 2.36.0; the security pocket's arm64 build was not read).

## Sources

Repository: `.github/workflows/release-linux.yml`, `scripts/verify-linux-release.sh`,
`scripts/package-linux.sh`, `scripts/linux/runtime-deps.sh`, `rust-toolchain.toml`,
`Cargo.toml` (profiles), `.cargo/config.toml`, `src-tauri/tauri.linux.conf.json`,
`crates/atlas-native-agent/src/linux_sandbox.rs`, `docs/reference/linux-support.md`,
`docs/research/deb-dependencies-cargo-deb.md`, `docs/research/linux-release-plan.md`;
`target/release/atlas` and `target/release-linux/tryatlas_0.4.1_amd64.deb` on this host;
`/usr/include/stdlib.h`, `/usr/share/doc/libc6/NEWS.gz`, `/lib/x86_64-linux-gnu/*.so` here;
`~/.cargo/registry/src/*/wry-0.57.1/Cargo.toml`.

- GitHub: [runner-images ubuntu22/20260810.260](https://github.com/actions/runner-images/releases/tag/ubuntu22%2F20260810.260),
  [ubuntu22-arm64/20260628.47](https://github.com/actions/runner-images/releases/tag/ubuntu22-arm64%2F20260628.47),
  [runner-images#14254](https://github.com/actions/runner-images/issues/14254),
  [Ubuntu2404-Readme.md](https://raw.githubusercontent.com/actions/runner-images/main/images/ubuntu/Ubuntu2404-Readme.md),
  [changelog: Node 20 deprecation](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/),
  [docs: running jobs in a container](https://docs.github.com/en/actions/using-jobs/running-jobs-in-a-container),
  [actions/checkout#1590](https://github.com/actions/checkout/issues/1590).
- Node: [BUILDING.md v24.x](https://raw.githubusercontent.com/nodejs/node/v24.x/BUILDING.md).
- glibc: [elf/dl-version.c](https://raw.githubusercontent.com/bminor/glibc/master/elf/dl-version.c),
  [2.38 NEWS](https://raw.githubusercontent.com/bminor/glibc/release/2.38/master/NEWS).
- GCC: [GCC 15 changes](https://gcc.gnu.org/gcc-15/changes.html).
- Rust: [platform-support](https://doc.rust-lang.org/rustc/platform-support.html),
  [Increasing the glibc and Linux kernel requirements](https://blog.rust-lang.org/2022/08/01/Increasing-glibc-kernel-requirements/),
  [compiler-team#493](https://github.com/rust-lang/compiler-team/issues/493),
  [rust#126827 (pidfd_spawn)](https://github.com/rust-lang/rust/pull/126827),
  [weak! linkage commit](https://github.com/mozilla/rust/commit/5ff6ac4287e191ee684f1de1af642e7b656947b6).
- Tauri: [debian](https://v2.tauri.app/distribute/debian/), [appimage](https://v2.tauri.app/distribute/appimage/),
  [flatpak](https://v2.tauri.app/distribute/flatpak/), [snapcraft](https://v2.tauri.app/distribute/snapcraft/),
  [pipelines/github](https://v2.tauri.app/distribute/pipelines/github/).
- cargo-zigbuild: [README](https://github.com/rust-cross/cargo-zigbuild),
  [src/zig/linker_args.rs](https://github.com/rust-cross/cargo-zigbuild/blob/main/src/zig/linker_args.rs),
  [#231](https://github.com/rust-cross/cargo-zigbuild/issues/231).
- polyfill-glibc: [README](https://github.com/corsix/polyfill-glibc),
  [Limitations.md](https://github.com/corsix/polyfill-glibc/blob/master/docs/Limitations.md),
  [How_does_polyfill_glibc_work.md](https://github.com/corsix/polyfill-glibc/blob/master/docs/How_does_polyfill_glibc_work.md),
  `src/x86_64/renames.txt`, `src/aarch64/renames.txt`, `src/renamer.c` (read via the GitHub API at HEAD, 2026-08-22).
- glibc_version_header: [README](https://github.com/wheybags/glibc_version_header).
- Flatpak: [common/flatpak-run.c](https://raw.githubusercontent.com/flatpak/flatpak/main/common/flatpak-run.c).
- AppImage: [pkg2appimage excludelist](https://raw.githubusercontent.com/AppImage/pkg2appimage/master/excludelist),
  [linuxdeploy generate-excludelist.sh](https://raw.githubusercontent.com/linuxdeploy/linuxdeploy/master/src/core/generate-excludelist.sh),
  [appimage-builder FAQ](https://appimage-builder.readthedocs.io/en/latest/faq.html).
- Distros: [sources.debian.org glibc](https://sources.debian.org/api/src/glibc/),
  [webkit2gtk](https://sources.debian.org/api/src/webkit2gtk/), [bubblewrap](https://sources.debian.org/api/src/bubblewrap/),
  [libayatana-appindicator](https://sources.debian.org/api/src/libayatana-appindicator/);
  packages.debian.org for bookworm/trixie `gcc`, `libstdc++6`, `libwebkit2gtk-4.1-dev`,
  `libglib2.0-0t64`; packages.ubuntu.com for jammy/noble/resolute `libc6`, `gcc`,
  `libstdc++6`, `libwebkit2gtk-4.1-0`, `bubblewrap`;
  [AlmaLinux 9.0](https://wiki.almalinux.org/release-notes/9.0.html) and
  [10.0](https://wiki.almalinux.org/release-notes/10.0.html) release notes;
  Fedora release trees on [mirrors.kernel.org](https://mirrors.kernel.org/fedora/releases/)
  and [archives.fedoraproject.org](https://archives.fedoraproject.org/pub/archive/fedora/linux/releases/42/Everything/x86_64/os/Packages/g/);
  [hub.docker.com/_/ubuntu](https://hub.docker.com/_/ubuntu).
- Corrections, 2026-11-18: `/usr/include/features.h` and `/usr/include/stdlib.h` on this
  host; `objdump -T` / `objdump -p` of the `ubuntu:24.04` distrobox build's binary;
  `.github/workflows/release-linux.yml` at `c58acf8f` and `1175af2d` (the aarch64 compiler
  step); `CONTRIBUTING.md` and `docs/architecture.md` at `c58acf8f`.
