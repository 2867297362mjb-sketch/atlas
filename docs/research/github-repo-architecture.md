# How the Atlas GitHub repository should be organised

_Research note, 2026-11-08, branch `ukaykhingmarma28/editor-code-font` at `93692b7d`.
Read against GitHub's docs, Tauri's docs and the updater plugin's source, the compared
projects' own trees (Zed, VS Code) and the actions' READMEs. Atlas's settings were read
with `gh api` on the same day. Nothing was changed on GitHub and nothing was built._

_Corrected 2026-11-18 at `1175af2d`, where a review found claims that were wrong at
`93692b7d`; each fix is marked **Correction**. Since the reading, `8ca3b186` (2026-11-10)
moved the repo from squash merges to merge commits; the note still describes squash, as
it was when read._

## Question

Atlas went trunk-based in PR #613 (`CONTRIBUTING.md` "Branching model"): every PR
squash-merges into `main`, release-please keeps a `chore: release X.Y.Z` PR
(`.github/workflows/release.yml`, `release-please-config.json`), merging it tags
`alpha-X.Y.Z` and builds installers, and the installed apps then learn of the version
from six PostHog remote-config values set by hand. Much of the surrounding machinery is
either missing (merge queue, CODEOWNERS, SHA pins, channels, staged rollout, backports)
or home-grown (`sync-version`, the PostHog updater, the pre-push hook) (**Correction:**
this said "Eleven pieces" and named nine). For each: what does the owning source say it does, what are its limits, and what
would it cost Atlas to adopt it?

## Method

One primary source per claim: docs.github.com for GitHub features (the REST reference
where the UI page is vague), v2.tauri.app plus `plugins/updater/src/updater.rs` for the
updater, the raw workflow and script files in `zed-industries/zed` and `microsoft/vscode`
for how they release, each action's README for the actions. Pages whose summariser
dropped a sentence were downloaded and grepped. Where a source could not be found
(Zed's release doc, Cursor's beta doc, GitHub's immutable-releases doc) the note says
so and uses the next-best primary: a changelog, a script, a staff forum post.

## Answer

Everything Atlas does by hand has a documented replacement, and most of them are a
small change. The merge queue is available to this repo today (public, org-owned) and
needs one line (`merge_group:`) in `ci.yml` plus a branch in `ci-affected.mjs`; the
rulesets it already uses can require it. The Tauri updater plugin would replace the
PostHog values with one signed `latest.json` per channel, and its Linux side now
installs deb and rpm, not only AppImage. release-please can move three of the four
version files itself (`extra-files`), leaving `Cargo.lock` as the one `sync-version`
still has to touch, and a GitHub App token would let the tag start the build workflow
the normal way. Staged rollout is not a Tauri feature: Zed, VS Code and Warp all do it
as channels (nightly / preview / stable) served from their own endpoint, and Cursor
gates by percentage server-side. §12 lists the assumptions in the brief that were wrong
(**Correction:** this said three; it lists more).

## 1. Merge queue

- What it does: "Pull requests merge first-in-first-out, and the required checks must
  always pass"; it removes the "Require branches to be up to date" round trip
  ([managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
- Availability: "Pull request merge queues are available in any public repository
  owned by an organization, or in private repositories owned by organizations using
  GitHub Enterprise Cloud" (same page, product note). `tryatlas/atlas` is public and
  org-owned, the org is on the free plan (`gh api orgs/tryatlas`), so it is available.
- The trigger: "You must use the `merge_group` event to trigger your GitHub Actions
  workflow"; "The `merge_group` event is separate from the `pull_request` and `push`
  events"; a `pull_request`-only workflow means "status checks will not be triggered
  when you add a pull request to a merge queue" and "The merge will fail as the
  required status check will not be reported" (same page). The only activity type is
  `checks_requested`; `GITHUB_SHA` and `GITHUB_REF` are the merge group's
  ([events: merge_group](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)).
  Third-party CI instead watches pushes to "a branch that begins with the special
  prefix `gh-readonly-queue/{base_branch}`".
- The check name: the queue waits for the required contexts by name, so `ci-ok`
  ("CI passed", `.github/workflows/ci.yml`) just has to run on `merge_group` too. Its
  `if: always()` fan-in is exactly what the queue wants: one context that is always
  reported.
- Atlas's wrinkle: `scripts/ci-affected.mjs` `resolveRange` recognises `schedule`,
  `workflow_dispatch`, `pull_request` (via `PR_BASE`) and `push`; anything else is
  `{ all: "unrecognised event …" }`, so a `merge_group` run would do a full run today.
  `github.event.merge_group.base_sha` and `head_sha` are the right range; otherwise
  every queued PR pays the full matrix.
- Merge method and release-please: the queue's merge method is a setting, "merge,
  rebase, or squash" (REST: `merge_method` `MERGE` / `SQUASH` / `REBASE`,
  [rules API](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)).
  The repo's squash settings are `squash_merge_commit_title=PR_TITLE`,
  `squash_merge_commit_message=PR_BODY` (`gh api repos/tryatlas/atlas`), which is
  what release-please parses; a queue merge is still a push to `main`, which is
  `release.yml`'s trigger. Nothing in either doc says they conflict; it is unverified
  in practice.
- Limits: not on a wildcard branch pattern; build concurrency and group sizes 1–100;
  a status-check timeout (`check_response_timeout_minutes`, 1–360) removes the PR;
  `grouping_strategy` `ALLGREEN` / `HEADGREEN`; "Only merge non-failing pull requests"
  is a toggle (same page; [rules API](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)).
  With 0 required reviews and `strict_required_status_checks_policy=false` (the `main`
  ruleset) the queue's one gain is "two green PRs that break together", for one more
  CI run per merge. `pr-title.yml` is `pull_request_target`, not required: untouched.

## 2. Rulesets

- Versus branch protection: "A ruleset does not have a priority", overlapping rules
  resolve to "the most restrictive version", several rulesets can cover one branch,
  "Anyone with read access to a repository can view its active rulesets", and the two
  systems "work alongside each other" ([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).
  Enforcement `disabled` / `active` / `evaluate`; "evaluate is only available with
  GitHub Enterprise" ([rules API](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)).
- The `pull_request` rule's parameters, all required: `required_approving_review_count`
  (0–10), `dismiss_stale_reviews_on_push`, `require_code_owner_review`,
  `require_last_push_approval` ("Whether the most recent reviewable push must be
  approved by someone other than the person who pushed it"),
  `required_review_thread_resolution`, `allowed_merge_methods` (same API page). Atlas
  today: 0 approvals, every boolean false, `allowed_merge_methods: ["squash"]`, and
  `require_extra_approval_for_unattributed_changes: true` (the Copilot default; "no
  effect if the ruleset requires zero approvals",
  [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)).
- Bypass actors: `actor_type` is `Integration`, `OrganizationAdmin`, `RepositoryRole`,
  `Team`, `DeployKey` or `User`; `bypass_mode` `always` (default), `pull_request`
  (bypass only through a PR; branch rulesets only) or `exempt` (no bypass audit entry)
  ([rules API](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28)).
  Both Atlas rulesets carry `{actor_type: RepositoryRole, actor_id: 5, bypass_mode:
  always}`; role id 5 is the admin role, so "bypass = any RepositoryRole" in the brief
  overstates it (§12). "Admins + a bot" is two entries: that one plus
  `{actor_type: Integration, actor_id: <app installation>}`.
- Requiring the queue: `merge_queue` is a ruleset rule type with the parameters in §1
  (same API page); the UI page only says the queue is "configured under branch
  protection rules or rulesets".

## 3. CODEOWNERS

- Locations: `.github/`, the root, or `docs/`; "GitHub will search for them in that
  order and use the first one it finds". Syntax is gitignore-like minus `!`, `[ ]`
  ranges and `\#`; "the last matching pattern takes the most precedence"; owners
  "must have write permissions for the repository"; the file must be on the PR's base
  branch; under 3 MB
  ([about code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).
- With `require_code_owner_review`: "any pull request that modifies content with a
  code owner must be approved by that code owner", and approval from "any of the
  owners is sufficient" ([available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)).
  Paths with no owner: the doc states no rule, only its example, "Without an owner,
  changes to `apps/github` can be made with the approval of any user who has" write
  access, i.e. the rule does not bite there.
- For Atlas the natural owners are the silent-invariant surfaces `CLAUDE.md` lists:
  `tests/`, `.github/`, `src-tauri/tauri.conf.json`, `Cargo.toml`, `vite.config.ts`,
  `crates/atlas-native-agent/`. With one maintainer it is documentation, not a gate.

## 4. Tauri v2 updater

- Signing: `tauri signer generate -w ~/.tauri/myapp.key`; `pubkey` goes in
  `tauri.conf.json` ("It cannot be a file path!"); the private key is
  `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) at build time; losing it means "Users
  with the app installed can no longer receive new updates"; signing "cannot be
  disabled" ([plugin/updater](https://v2.tauri.app/plugin/updater/)). The plugin
  verifies with minisign (`PublicKey::decode` … `public_key.verify(data, &signature,
  true)` in [`updater.rs`](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs)).
- Config: `bundle.createUpdaterArtifacts: true` (`"v1Compatible"` for migrations;
  "will be removed in v3"), `plugins.updater.endpoints[]`, `pubkey`,
  `windows.installMode` `passive` (default, recommended) / `basicUi` / `quiet`.
  Placeholders `{{current_version}}`, `{{target}}` (`linux` / `windows` / `darwin`),
  `{{arch}}` (`x86_64` / `i686` / `aarch64` / `armv7`); the source also substitutes
  `{{bundle_type}}` and looks up `{os}-{arch}-{installer}` before `{os}-{arch}`
  (`get_urls` in `updater.rs`). Endpoints fall through "only … if a non-2XX status
  code is returned".
- Static manifest: `version` (semver, required), `notes`, `pub_date` (RFC 3339),
  `platforms.{darwin-aarch64,…}.{url,signature}`; "`signature` is the content of the
  `.sig` file"; the whole file is validated before `version` is compared. Dynamic
  server: `204 No Content` for none, else `200` with `{version, notes, pub_date, url,
  signature}` ([plugin/updater](https://v2.tauri.app/plugin/updater/)).
- `tauri-action`: `uploadUpdaterJson` (default `true`) writes a `latest.json` that
  "assume[s] you're using the GitHub Release as your updater endpoint";
  `updaterJsonPreferNsis`; with `releaseId` and no `tagName` the URLs point at
  `releases/latest/download/<bundle>` ([tauri-action README](https://github.com/tauri-apps/tauri-action)).
  Tauri's own pipeline page matrices `macos-latest` ×2 targets, `ubuntu-22.04`,
  `windows-latest` ([pipelines/github](https://v2.tauri.app/distribute/pipelines/github/)).
- Linux: the doc page describes AppImage only, but the plugin source dispatches on
  the running bundle — `installer_for_bundle_type(bundle_type())` → `install_deb`
  (`dpkg -i`), `install_rpm`, else `install_appimage`, with `pkexec` tried first for a
  graphical prompt (`updater.rs` lines ~1214–1390, 1871). So deb and rpm are
  installable; the tarball and Arch package are not (no installer variant).
- Channels and rollout: no feature. The doc's examples are a `?channel=` query and
  per-channel subdomains; the Rust builder's `.endpoints()`, `.pubkey()` (key
  rotation) and `.version_comparator()` (downgrades, "useful for rollbacks") are the
  hooks ([plugin/updater](https://v2.tauri.app/plugin/updater/)). The pattern that
  follows: one static `latest.json` per channel on the release, or a dynamic endpoint
  that reads `{{current_version}}` and a client id, applies a percentage, and answers
  204 or the manifest.

## 5. Staged rollouts: Zed, VS Code, Warp, Cursor

- **Zed**: "Nightly: Built daily from the `main`" branch; "Preview: Our weekly release
  with recent features that have undergone initial internal testing"; stable is last
  week's preview; a `-pre` tag marks a branch as preview; "During the week between
  minor releases, we may cherry-pick important fixes to the preview or stable branches
  and release new patches" ([zed.dev/faq](https://zed.dev/faq)). The release doc the
  brief named (`docs/src/development/releases.md`) is not in `main`'s
  `docs/src/development/` and `zed.dev/docs/development/releases` is 404.
  Mechanism, from the tree: `script/bump-zed-version` warns unless it is Wednesday
  ("Zednesdays") and runs `bump_zed_version.yml`, which reads
  `crates/zed/RELEASE_CHANNEL` (`dev` on `main`), cuts `v{major}.{minor}.x` from
  `main`, tags `v{version}-pre`, promotes the released preview to stable and opens a
  `bump-zed-to-v…` PR ([bump-zed-version](https://raw.githubusercontent.com/zed-industries/zed/main/script/bump-zed-version),
  [bump_zed_version.yml](https://raw.githubusercontent.com/zed-industries/zed/main/.github/workflows/bump_zed_version.yml)).
  `release.yml` runs on tags `v*`; `script/determine-release-channel` reads the
  channel file and refuses unless the tag is `v{version}` (stable) or
  `v{version}-pre` (preview); `-pre` tags auto-publish the draft when their
  major.minor matches the released preview
  ([release.yml](https://raw.githubusercontent.com/zed-industries/zed/main/.github/workflows/release.yml),
  [determine-release-channel](https://raw.githubusercontent.com/zed-industries/zed/main/script/determine-release-channel)).
  Nightly: cron `0 2,14 * * *`, every bundle job overwrites `RELEASE_CHANNEL` with
  `nightly`, then `script/upload-nightly` and a force-move of the `nightly` tag
  ([release_nightly.yml](https://raw.githubusercontent.com/zed-industries/zed/main/.github/workflows/release_nightly.yml)).
  Patches: `script/trigger-release {preview|stable}` → `bump_patch_version.yml` on
  `v0.NNN.x`, `cargo set-version --bump patch`, a bot commit and a tag
  ([trigger-release](https://raw.githubusercontent.com/zed-industries/zed/main/script/trigger-release),
  [bump_patch_version.yml](https://raw.githubusercontent.com/zed-industries/zed/main/.github/workflows/bump_patch_version.yml)).
  The client polls `/releases/{channel}/{version}/asset?…` on Zed's cloud hourly
  (15 min for nightly) (`crates/auto_update/src/auto_update.rs`, `POLL_INTERVAL`), so
  any percentage gate lives in that endpoint; nothing in the tree shows one.
- **VS Code**: Azure Pipelines, not Actions. `build/azure-pipelines/product-build.yml`
  has four weekday crons (`0 5/11/17/23 * * Mon-Fri`) and a `VSCODE_QUALITY`
  parameter, `insider` (default) or `stable`
  ([product-build.yml](https://raw.githubusercontent.com/microsoft/vscode/main/build/azure-pipelines/product-build.yml)).
  "New builds every day" for Insiders, which "Runs next to the Stable build"
  ([insiders](https://code.visualstudio.com/insiders/)). "During endgame, a release
  branch is created: `release/1.10`", fixes go to both, stable "is built from the
  `1.10.0` tag", recovery builds are `1.10.1`, `1.10.2` from the branch
  ([wiki: Release Process](https://github.com/microsoft/vscode/wiki/Release-Process)).
  The client asks `{baseUpdateUrl}/api/update/{platform}/{quality}/{commit}` hourly
  (`createUpdateURL`, [abstractUpdateService.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/update/electron-main/abstractUpdateService.ts));
  the server that answers is not public, so any rollout logic is invisible.
- **Warp** (public info): Preview is "a separate version from our stable build" that
  runs "alongside your Stable build" and needs sign-in ([warp-preview](https://www.warp.dev/blog/warp-preview);
  [README](https://github.com/warpdotdev/Warp) adds nothing on cadence).
- **Cursor** (public info): staff on the forum, "we're rolling out this update gradually
  to catch critical errors early on" (Dean Rie, 2025-01-27, [thread](https://forum.cursor.com/t/pro-users-version-0-45-rollout-timeline/44856));
  `docs.cursor.com/settings/beta` redirects, so the "Early Access" setting is unsourced.
- The common shape: a channel is a build-time constant (Zed's `RELEASE_CHANNEL`,
  VS Code's `quality`) baked into the binary, a branch per minor, and an endpoint that
  answers per channel. Percentage rollout is server-side in every case.

## 6. Backport automation

- `korthout/backport-action`: label `backport <branch>` (pattern `^backport ([^ ]+)$`)
  or `target_branches`; runs on `pull_request_target: [closed]`; "Supports all merge
  methods including merge queue and Bors"; "For 'Squash and merge', the action
  cherry-picks the squashed commit"; conflicts: "the action will stop the cherry-pick
  at the first conflict", `fail` (default) or `draft_commit_conflicts`; "By default,
  the action creates backport pull requests with `GITHUB_TOKEN`", on which "your CI
  may not run at all" — a GitHub App token is preferred
  ([README](https://github.com/korthout/backport-action)).
- `sorenlouv/backport`: `github.com/sqren/backport` redirects to it
  (`gh api repos/sqren/backport` → `sorenlouv/backport`), so the brief's third tool is
  the same one. A CLI that is "interactive and run manually locally"; `.backportrc.json`
  with `targetBranchChoices` and `branchLabelMapping` (`"^backport-to-(.+)$": "$1"`);
  token in `~/.backport/config.json` ([README](https://github.com/sorenlouv/backport)).
  Its action, `sorenlouv/backport-github-action@v12`, runs on `pull_request_target:
  [labeled, closed]` with `auto_backport_label_prefix: backport-to-`
  ([README](https://github.com/sorenlouv/backport-github-action)).
- GitHub itself: no backport feature was found in docs.github.com.
- Zed: `cherry_pick.yml` is `workflow_dispatch` (inputs commit, branch, channel,
  pr_number), authenticates as a GitHub App (`actions/create-github-app-token`), and
  `script/cherry-pick` checks out `origin/$BRANCH -B cherry-pick-$BRANCH-$SHA`,
  cherry-picks, force-pushes and opens a PR titled "… (cherry-pick to $CHANNEL)"
  ([cherry_pick.yml](https://raw.githubusercontent.com/zed-industries/zed/main/.github/workflows/cherry_pick.yml),
  [script/cherry-pick](https://raw.githubusercontent.com/zed-industries/zed/main/script/cherry-pick)).
  VS Code's wiki only says fixes are "delivered to both `main` and `release/1.10`".
- For Atlas's `release/X.Y` hotfix branches, korthout's action with a `backport
  release/0.4` label is the smallest change: squash commits are what it expects.

## 7. Action SHA pinning, and what superseded it

- GitHub: "Pin actions to a full-length commit SHA" because "a tag can be moved or
  deleted if a bad actor gains access"; "verify it is from the action's repository and
  not a repository fork"; "always audit the source code of the action". And, new: "The
  best measure is to lock your workflow dependencies with a lockfile … This is the
  strongest protection available, and supersedes SHA pinning for repositories that
  adopt it" ([security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
- The lockfile: `.github/workflows/actions.lock`, "pins a commit SHA to every action
  your workflows depend on, including transitive dependencies", generated by the
  `gh actions-lock` CLI extension and "should never be edited by hand"; workflows are
  onboarded "one at a time or all at once"
  ([workflow dependency lockfiles](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)).
  GA 2026-10-28 on Free, Team and Enterprise; Dependabot "also regenerates the matching
  lockfile entry in the same pull request"; a "Require lockfile" policy exists; "they
  don't determine whether a dependency is safe"
  ([changelog 2026-10-28](https://github.blog/changelog/2026-10-28-github-actions-workflow-lockfiles-are-generally-available/),
  [preview 2026-10-14](https://github.blog/changelog/2026-10-14-github-actions-workflow-lockfiles-in-public-preview/)).
  This is the answer to the brief's "immutable actions" question: that was a 2025
  runner-side migration note, never a repo feature; the lockfile is what shipped.
- Dependabot and SHA pins: "Dependabot will now update the semver version in comments
  when updating Actions workflows with a commit SHA version"
  ([changelog 2022-10-31](https://github.blog/changelog/2022-10-31-dependabot-now-updates-comments-in-github-actions-workflows-referencing-action-versions/)).
  The current Dependabot pages no longer say this; they describe the lockfile path.
- Tools: `pinact run` rewrites `uses:` to a SHA with a `# v3.5.1` comment, `--check`
  for CI ([pinact](https://github.com/suzuki-shunsuke/pinact)); `frizbee actions`
  "will only replace the `uses` field" ([frizbee](https://github.com/stacklok/frizbee));
  secure-repo also computes minimum `GITHUB_TOKEN` permissions and inserts
  Harden-Runner ([secure-repo](https://github.com/step-security/secure-repo)).
- Immutable releases (the other 2025 feature): GA 2025-10-28; once published, assets
  "can't be added, modified, or deleted" and tags are protected; enabled per repo or
  org; releases get Sigstore-bundle attestations
  ([changelog 2025-10-28](https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/),
  [preview 2025-08-26](https://github.blog/changelog/2025-08-26-releases-now-support-immutability-in-public-preview/)).
  `release.yml` uploads DMGs and the MSI with `gh release upload … --clobber` *after*
  release-please publishes, which immutability would refuse; the fix is a draft
  release published last, or `release-linux.yml`'s single publishing step. The docs
  page for the feature was 404 at both guessed URLs; the changelogs are the source.

## 8. Build provenance

- `actions/attest-build-provenance` "is simply a wrapper on top of `actions/attest`"
  (v4) and binds a subject to a "SLSA build provenance" predicate, signed with "a
  short-lived Sigstore-issued signing certificate"; public repos use "the public-good
  instance of Sigstore", private ones "the GitHub private Sigstore instance";
  "available in public repositories for all current GitHub plans"
  ([README](https://github.com/actions/attest-build-provenance)).
- Permissions `id-token: write`, `attestations: write`, `contents: read`; inputs
  `subject-path` (globs, comma or newline lists) / `subject-digest` / `subject-checksums`,
  or none to take the runner's `$GITHUB_ARTIFACTS_LIST`; "No more than 1024 subjects
  can be attested at the same time" ([actions/attest README](https://github.com/actions/attest/blob/main/README.md)).
- "by itself provides SLSA v1.0 Build Level 2", and a reusable workflow "can meet
  SLSA v1.0 Build Level 3" ([artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations));
  verify with `gh attestation verify PATH/TO/YOUR/BUILD/ARTIFACT-BINARY -R
  ORGANIZATION_NAME/REPOSITORY_NAME` ([how-to](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)).
- Runner OS: neither README nor doc restricts it; it is a JavaScript action reading a
  runner-provided variable. Atlas runs it in the `publish` job, on `ubuntu-24.04`
  (`release-linux.yml:354`; **Correction:** this said `ubuntu-24.04-arm`); on
  `macos-latest` / `windows-latest` it is unverified here.
  Because `release-linux.yml` is a reusable workflow called from `release.yml`, the
  Linux artifacts are already on the Level 3 path; the macOS and Windows jobs in
  `release.yml` attest nothing today.

## 9. release-please

- `Release-As: x.x.x` "in the commit body" of a commit on the main branch forces that
  version ([README](https://github.com/googleapis/release-please)). With
  `squash_merge_commit_message=PR_BODY` a PR body footer reaches `main`.
- Versioning strategies `default`, `always-bump-patch`, `always-bump-minor`,
  `always-bump-major`, `prerelease`; "A prerelease version number will only be created
  if the prerelease setting is set to `true`" ([customizing.md](https://github.com/googleapis/release-please/blob/main/docs/customizing.md));
  `prerelease-type` sets "the prerelease part of the version to the provided value in
  case prerelease part is not present", `prerelease` marks the GitHub release as
  prerelease, `bump-minor-pre-major` / `bump-patch-for-minor-pre-major` are the pre-1.0
  rules `release.yml`'s header describes, `last-release-sha` is "uncommon … and should
  generally be avoided" (Atlas sets it) ([schemas/config.json](https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json)).
- `extra-files`: a path with `x-release-please-version` / `x-release-please-start-version`
  … `x-release-please-end` annotations, or `{type: json|toml|yaml, path, jsonpath}`
  (same schema; [customizing.md](https://github.com/googleapis/release-please/blob/main/docs/customizing.md)).
  That covers `src-tauri/tauri.conf.json` (`$.version`) and `src-tauri/Cargo.toml`
  (`$.package.version`); `Cargo.lock` has no annotation cargo would keep and many
  `version =` lines, so `scripts/bump.sh`'s lock-file edit stays, or the release PR
  runs `cargo update -p atlas --offline`. `sync-version` shrinks; it does not vanish.
- Branches: the action's `target-branch` input, "branch to open pull release PR
  against (detected by default)", shown with `${{ github.ref_name }}` for multi-branch
  releases ([action README](https://github.com/googleapis/release-please-action)) — a
  `release/0.4` branch could keep its own release PR.
- Tokens: "events triggered by the `GITHUB_TOKEN` will not create a new workflow run,
  with the following exceptions: `workflow_dispatch` and `repository_dispatch`"
  ([triggering a workflow](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow));
  the action README's fix is a PAT secret, and `actions/create-github-app-token` is the
  App form Zed uses in every bot workflow (`permission-contents: write` etc.,
  [README](https://github.com/actions/create-github-app-token)). With one, the tag
  would trigger `release-linux.yml` directly and `sync-version`'s `gh workflow run
  ci.yml` step would be unnecessary.

## 10. Local hooks

- `vitest run --changed origin/main` runs "everything on this branch"; `--changed
  <upstream>` is the recipe's row for "the commits you are about to push"; a test runs
  "when any file in its import graph is in the list"; changes to `setupFiles`,
  `globalSetup`, the config and its imports rerun everything
  ([affected tests recipe](https://vitest.dev/guide/recipes/affected-tests),
  [config: changed](https://vitest.dev/config/changed)). `vitest related <files>` "Works
  with static imports … but not the dynamic ones" and is the lint-staged form
  ([cli](https://vitest.dev/guide/cli)). `--since-last-run` is the Git-free variant.
- Husky: "disable hooks temporarily with `HUSKY=0`", `git -n/--no-verify` per command,
  `export HUSKY=0` in `~/.config/husky/init.sh` for a machine, `HUSKY: 0` in CI
  ([husky how-to](https://typicode.github.io/husky/how-to.html)).
- For `.husky/pre-push`: `bun x vitest run --changed @{upstream}` (fallback
  `origin/main`) keeps the hook's purpose — the red frontend jobs its comment
  remembers — without the full run on a loaded laptop. The contract suites in `tests/`
  import from everywhere, so most still select; that is the point.

## 11. Dependabot

- `schedule.interval`: `daily`, `weekly` (default Monday; `day` picks another),
  `monthly`, `quarterly`, `semiannually`, `yearly`, `cron` (needs `cronjob`;
  `timezone` separate); `open-pull-requests-limit` default 5, "setting this option to
  zero" disables version updates, security PRs "are subject to a separate, fixed limit
  of 10"
  ([options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)).
- `cooldown`: "only available for version updates, not security updates"; "By default,
  Dependabot applies a cooldown period of 3 days"; `default-days`, `semver-major-days`,
  `semver-minor-days`, `semver-patch-days`, `include`, `exclude` (150 each, `*`);
  the SemVer keys work for Bun and Cargo, `default-days` for GitHub Actions
  ([options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference),
  [about version updates](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/about-dependabot-version-updates)).
- `groups`: `applies-to: version-updates | security-updates` (default version),
  `patterns`, `exclude-patterns`, `dependency-type`, `update-types`, `group-by:
  dependency-name`; "If a dependency matches more than one rule, it's included in the
  first group" (same page). Atlas's `.github/dependabot.yml` already groups all three
  ecosystems and uses `group-by: dependency-name` for cargo; what it lacks is a
  security-updates group and an explicit `cooldown` (a `semver-major-days` of, say,
  14 for Bun would blunt the bun-ignore defect its comment documents, since cooldown
  does hold for Bun).

## 12. Corrections to assumptions

- **Bypass is not "any RepositoryRole".** Both rulesets name one actor, `RepositoryRole`
  id 5 with `bypass_mode: always`, which is the admin role. Narrowing means adding an
  `Integration` entry for the bot, not removing roles.
- **The Tauri updater is not AppImage-only on Linux.** The doc page is, the plugin is
  not: `install_deb` / `install_rpm` / `install_appimage` are dispatched on the running
  bundle type (§4). The tarball and Arch package remain outside it.
- **"Immutable actions" did not ship as a repo feature.** What shipped is the workflow
  dependency lockfile (GA 2026-10-28), which GitHub now ranks above SHA pinning, and
  immutable releases (GA 2025-10-28), which would break `release.yml`'s post-publish
  `gh release upload --clobber` (§7).
- **`sqren/backport` is `sorenlouv/backport`.** Two tools to compare, not three.
- **`sync-version` cannot go away entirely.** `extra-files` moves two of the three
  remaining files; `Cargo.lock` still needs a script or `cargo update -p atlas` (§9).
- **Atlas does not use `tauri-plugin-updater` and has no `pubkey`.** `tauri.conf.json`
  has `"plugins": {}`; `updater_macos.rs` verifies the DMG's Apple signature and Team
  ID (`codesign --verify --deep --strict`, `spctl`) instead of minisign, and
  `updater_linux.rs` only announces a URL. The brief had this as a question; it is
  confirmed, and it means adopting the plugin is a new trust root (a minisign key in
  the `release` environment) on top of the Apple one, not a swap. **Correction:** on top
  of the Apple one on macOS only. `updater_windows.rs` says the MSI "is not
  Authenticode-signed yet, so there is no equivalent anchor" (HTTPS and the UAC prompt
  are all it has), so on Windows the minisign key would be the first one.
- The Zed release doc and Cursor beta doc the brief named no longer resolve; their
  claims come from scripts, workflows, the FAQ and a staff forum post.

## 13. Recommendation

In cost order, each independent of the others:

1. `merge_group:` in `ci.yml` and a `merge_group` branch in `resolveRange`; then the
   `merge_queue` rule on the `main` ruleset with `merge_method: SQUASH`. One CI run per
   merge extra; protects against the two-green-PRs case the weekly full run otherwise
   catches a week late.
2. `.husky/pre-push` → `vitest run --changed @{upstream}`; keep `bun run test` as the
   documented pre-PR step it already is (`CONTRIBUTING.md` "Verification").
3. `gh actions-lock` on every workflow in `.github/workflows/` (**Correction:** this said
   five; there are four), `pinact run --check` or the lockfile's own
   verify in `ci.yml`; Dependabot keeps both. Drop the by-tag pins afterwards or keep
   them as the readable half.
4. `extra-files` for `tauri.conf.json` and `src-tauri/Cargo.toml`; a GitHub App token
   for release-please so the `alpha-*` tag triggers `release-linux.yml` on `push:
   tags` and `sync-version` loses its `gh workflow run`.
5. The Tauri updater for the DMG, MSI, deb, rpm and AppImage, with
   `createUpdaterArtifacts`, a minisign key in the `release` environment and a
   `latest.json` per channel attached to the release by `tauri-action` or by
   `release-linux.yml`'s publishing step. The PostHog values become one file per
   channel; the "staged" part is a `?channel=` endpoint that answers 204 to the
   percentage it holds back. Before that, decide the channel model: Zed's
   (branch per minor, channel constant baked in, `-pre` tags) fits release-please's
   `prerelease` + `target-branch` with no new tooling.
6. CODEOWNERS over the invariant surfaces, informational until there is a second
   reviewer; `require_last_push_approval` and `dismiss_stale_reviews_on_push` only
   when `required_approving_review_count` becomes 1.
7. Backports: `korthout/backport-action` keyed on `backport release/X.Y`, App token,
   once a `release/` branch exists that outlives a week.

## 14. Today → sources → cost

| topic                  | Atlas today                                                                 | what the sources support                                                                            | cost                                                    |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1 merge queue          | none; `CI passed` required, non-strict                                      | available (public, org-owned); `merge_group` trigger; `merge_queue` ruleset rule; squash OK         | 1 line in `ci.yml`, 1 branch in `ci-affected.mjs`, +1 CI run/merge |
| 2 rulesets             | 2 rulesets; 0 approvals; admin-role bypass                                  | all five PR parameters in the API; `Integration` bypass actor; `evaluate` is Enterprise-only       | settings only; reviews need a second maintainer         |
| 3 CODEOWNERS           | none                                                                        | `.github/CODEOWNERS`, last match wins, owners need write; only bites with `require_code_owner_review` | one file                                              |
| 4 Tauri updater        | PostHog remote config + Apple signature; `plugins: {}`                      | minisign-signed `latest.json`, `{{target}}/{{arch}}` endpoints, deb/rpm/AppImage/DMG/MSI install    | new key, 3 updater modules replaced, per-channel JSON   |
| 5 staged rollout       | one version for everyone, set by hand                                       | channels as build constant + branch per minor (Zed, VS Code); percentage is server-side everywhere  | a channel constant, a `release/` cadence, a tiny endpoint |
| 6 backports            | hand cherry-pick, `bun run bump`, hand tag                                  | korthout (label, squash-aware, App token) or sorenlouv action; Zed's dispatch-driven script         | one workflow + App token                                |
| 7 SHA pinning          | tags (`actions/checkout@v5`)                                                | lockfile (`actions.lock`, GA 2026-10) supersedes SHA pins; Dependabot regenerates it                | `gh actions-lock` once, a verify step                   |
| 8 provenance           | Linux only, via reusable workflow (Level 3 path)                            | runner-agnostic by construction (unverified on mac/win); `gh attestation verify -R tryatlas/atlas`  | two steps in `release.yml`                              |
| 9 release-please       | `node` type, `sync-version` job, `GITHUB_TOKEN`, `last-release-sha`         | `extra-files` (json/toml), `prerelease`/`prerelease-type`, `target-branch`, App token for triggers  | config edit + App secret; `Cargo.lock` step stays       |
| 10 local hooks         | pre-push runs everything (~5,400 tests)                                     | `--changed <upstream>` selects by import graph; `HUSKY=0` to skip                                   | one line in `.husky/pre-push`                           |
| 11 Dependabot          | monthly, grouped, bun version updates off                                   | `cooldown` (3-day default; per-semver for Bun/Cargo), `applies-to: security-updates` groups        | config edit                                             |

## 15. Open questions

- Whether a queue-built squash commit carries the PR body (for `Release-As:` footers)
  the way a direct squash does; neither doc says.
- Whether `actions/attest` runs on `macos-latest` and `windows-latest` (no doc
  sentence either way; Atlas has only run it on Linux).
- Whether `tauri-action`'s `latest.json` can be made per-channel without a fork, or
  whether `release-linux.yml`'s publish step should write the manifests itself.
- Whether the Tauri updater's `pkexec` deb/rpm path survives the bubblewrap-sandboxed
  agent on Linux (the engine re-execs the app binary; an in-place `dpkg -i` swaps it).
- The lockfile and `jdx/mise-action` / `Swatinem/rust-cache` transitive pins: the doc
  promises transitive coverage, not tested here.
- Cursor's exact rollout window and Zed's cloud-side gating: not public.

## Sources

Every claim above links its source inline. Repository files read: `CONTRIBUTING.md`,
`.github/workflows/{ci,release,release-linux,pr-title}.yml`, `.github/dependabot.yml`,
`.husky/{pre-commit,pre-push}`, `release-please-config.json`, `.release-please-manifest.json`,
`scripts/{bump.sh,ci-affected.mjs}`, `src-tauri/tauri.conf.json`,
`src-tauri/src/commands/updater{,_macos,_linux,_stub}.rs`,
`src/features/updater/lib/updater-api.ts`, `src/features/telemetry/posthog-client.ts`;
`gh api repos/tryatlas/atlas`, `…/rulesets/{26721929,26721942}`, `gh api orgs/tryatlas`.
External trees were read at `main` on 2026-11-08 via raw.githubusercontent.com:
`zed-industries/zed` (`script/{bump-zed-version,trigger-release,cherry-pick,determine-release-channel,get-released-version}`,
`.github/workflows/{release,release_nightly,bump_zed_version,bump_patch_version,cherry_pick,after_release}.yml`,
`crates/zed/RELEASE_CHANNEL`, `crates/auto_update/src/auto_update.rs`), `microsoft/vscode`
(`build/azure-pipelines/product-build.yml`, `src/vs/platform/update/electron-main/abstractUpdateService.ts`),
`tauri-apps/plugins-workspace@v2` (`plugins/updater/src/updater.rs`), `googleapis/release-please`
(`README.md`, `docs/customizing.md`, `schemas/config.json`), `vitest-dev/vitest` (`docs/guide/cli.md`,
`docs/guide/recipes/affected-tests.md`, `docs/config/changed.md`, `packages/vitest/src/node/cli/cli-config.ts`),
`actions/attest` (`README.md`), `sorenlouv/backport-github-action` (`README.md`),
`actions/create-github-app-token` (`README.md`).

Corrections, 2026-11-18: `src-tauri/src/commands/updater_windows.rs` and
`.github/workflows/release-linux.yml` at `93692b7d`; `git log` for `8ca3b186`.
