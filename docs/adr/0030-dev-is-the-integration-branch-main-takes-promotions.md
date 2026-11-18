# ADR-0030: `dev` is the integration branch; `main` takes promotions and hotfixes

**Status:** Proposed (2026-11-18). Would supersede the trunk-based model of PR #613
(`c97a7344`, 2026-11-07). The merge-commit rule of `8ca3b186` stands, and now applies to
promotions too.

**For agents:** open every pull request against `dev` (`gh pr create --base dev`).
`main` stays the default branch, so every tool offers it as the base; it takes only a
promotion from `dev`, a `hotfix/*` branch, and release-please's release PR.

## Context

Since #613, every pull request lands on `main`, and anything on `main` can go out in the
next release: `CONTRIBUTING.md` asks that `main` "stay shippable", and unfinished work
waits on its branch or lands behind a setting. Since `8ca3b186`, pull requests land as
merge commits and release-please reads every commit on `main`.

That model has no stage between "merged" and "released". Several pull requests are first
tested together after they are already on `main`, and `main` then holds work nobody has
tried as a whole. The proposal is a stage where merged work is integrated and tested
(previews, QA) before it reaches `main`, so `main` holds only what was released or is
about to be.

## Decision

- **`dev` is the integration branch.** Every pull request targets it and lands as a merge
  commit titled with its Conventional title (`pr-title.yml`, unchanged).
- **`main` stays the default branch** and changes only three ways:
  - a **promotion**: a pull request from `dev` into `main`, `chore: promote dev to main`,
    merged with a merge commit. A squash would give `main` a commit `dev` lacks, and every
    later promotion would conflict.
  - a **hotfix**: `hotfix/<slug>` branched from `main`, merged into `main`, after which
    `main` is merged back into `dev`.
  - the **release PR**, as today.
- **Releases are cut from `main`** by the existing release-please flow. After each
  release, `main` is merged back into `dev`, so `dev` carries the new version and
  changelog. Promote only when you mean to release, so `main` never holds work waiting.
- **The rule is enforced in writing first, then by a bot.** Because `main` is the
  default, GitHub, `gh pr create` and Linear all propose it as the base. The PR template,
  `CONTRIBUTING.md`, `AGENTS.md` and `README.md` say `dev`; rollout step 2 adds a check
  that retargets a pull request into `main` and fails it.

## Consequences

- `Fixes #N` closes its issue when the work reaches `main`, at the promotion: closing
  keywords act on the default branch, and the merge commit carries the PR description.
  Linear's **Done** moves to "merged into `dev`".
- Two long-lived branches to keep in step. A hotfix or a release commit not merged back
  leaves `dev` behind `main`, and the next promotion can conflict on it.
- A fix reaches users at the next promotion, or as a hotfix.
- Until step 2, a pull request into `dev` finds no warm Rust cache there: `ci.yml` runs on
  pushes to `main` and `release/**` only, and its comment puts a cold app job at ~16
  minutes against ~2.
- `bun run ci:local` plans against the branch's upstream; for a pull request, pass
  `--base origin/dev`.
- `release/X.Y` branches and the cherry-pick hotfix steps retire: a hotfix now releases
  through the release PR like everything else.

## Rollout

1. **This change**: the ADR and the docs. When it merges, an admin creates `dev` from
   `main` with a ruleset (pull request and `CI passed` required, merge commits only), and
   open pull requests, all but the release PR, are retargeted to `dev`.
2. **CI wiring**: a `pr-base.yml` check that retargets and fails a pull request into
   `main` from anything but `dev`, `hotfix/*` or the release branch; `dev` in `ci.yml`'s
   push branches and in the weekly full run; `ci-affected.mjs` treating a push to `dev`
   like one to `main`; `ci:local` defaulting to `origin/dev`.
3. **The version commit on `dev`**: release-please with `target-branch: dev` and no
   GitHub release, and a job on `main` that tags the promotion's `dev`-side parent
   (`HEAD^2`), so release-please on `dev` can find its last release in `dev`'s history.
   Prototype on a fork first: release-please stops on a merged release PR it has not
   tagged, and a tag on `main`'s own merge commit is not in `dev`'s history.
4. **Preview builds from `dev`**: GitHub prereleases `alpha-X.Y.Z-dev.N`, never offered
   by the updater.

The research note `docs/research/github-repo-architecture.md` carries over with `dev` in
place of `main` for its merge queue (§13.1), and its channels (§13.5) map onto the
branches: `dev` → preview, `main` → stable.

## Considered options

- **Keep trunk-based** (#613) and add the research note's merge queue and channels.
  Cheaper, with one branch and one release path, but integration testing still happens
  after the merge, on `main`.
- **Make `dev` the default branch.** Pull requests would target it unprompted and issues
  would close on merge, but the repository's front page, a fresh clone and the scheduled
  CI run would all track unreleased work.
- **Squash promotions.** Rejected: `main` and `dev` diverge after the first one.
