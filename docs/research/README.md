# Research

Findings captured by the research workflow: a question, the method, the primary
sources read, and a verdict. Each note is dated and names the branch and commit it was
read at, so it can be judged stale without guessing.

A note is added when an investigation answers a question the code or an ADR depends on.
When a decision is made from it, the ADR cites the note; when the note is superseded or
its subject is gone, it moves to `docs/archive/`. Notes are not edited to track later
code, only corrected when they were wrong.

- `agent-org-teams-api-access.md` - what exists for giving Atlas Agent access to the organisation and teams API.
- `macos-window-corners.md` - whether `.atlas-window-border` is still needed for macOS window corners.
- `org-name-rename-staleness.md` - why an organisation rename never reaches the desktop.
- `org-tool-server-prefix.md` - the measured fixed-prefix cost of the organisation tool server.
- `linux-release-plan.md` - what the Linux release is missing to be production grade, and a phased fix that leaves macOS untouched.
- `deb-dependencies-cargo-deb.md` - whether cargo-deb's `$auto` (dpkg-shlibdeps) should replace the release deb's hand-written Depends.
- `glibc-backward-compat.md` - how the Linux binary can run on an older glibc than its build host: what raises the floor, ten approaches judged, and the plan for the `ubuntu-22.04` runner's retirement.
- `github-repo-architecture.md` - merge queue, rulesets, CODEOWNERS, the Tauri updater, channels and staged rollout (Zed, VS Code, Warp, Cursor), backports, action lockfiles, provenance, release-please, local hooks and Dependabot: what each source supports against what the repo does today.
