# ADR-0030: `dev` is the integration branch; `main` takes promotions and hotfixes

**Status:** Accepted (2026-11-18). Supersedes the trunk-based model of PR #613
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
tried as a whole. The team wants a stage where merged work is integrated and tested
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
- **Releases are cut from `main`** by the existing release-please flow. After a release
  or a hotfix, `main` is merged back into `dev`, so `dev` carries the new version and
  changelog: `back-merge.yml` keeps that PR open whenever merging `main` would change
  `dev`. Promote only when you mean to release, so `main` never holds work waiting.
- **The rule is written down and enforced by a bot.** Because `main` is the default,
  GitHub, `gh pr create` and Linear all propose it as the base. The PR template,
  `CONTRIBUTING.md`, `AGENTS.md` and `README.md` say `dev`, and `pr-base.yml` moves a pull
  request aimed at `main` to `dev` and says why. It is not a required check: the release
  PR is opened with `GITHUB_TOKEN`, whose events start no workflow, so it would never
  report there and would block every release.

## Consequences

- `Fixes #N` closes its issue when the work reaches `main`, at the promotion: closing
  keywords act on the default branch, and the merge commit carries the PR description.
  Linear's **Done** moves to "merged into `dev`".
- Two long-lived branches to keep in step. A hotfix or a release commit not merged back
  leaves `dev` behind `main`, and the next promotion can conflict on it.
- A fix reaches users at the next promotion, or as a hotfix.
- A push to `dev` runs the full suite but writes no Rust caches, which keeps the
  repository inside its 10 GB cache budget (`ci.yml`, "Cache budget"). A pull request
  into `dev` restores from `main`, the default branch, so it rebuilds what changed since
  the last promotion.
- `bun run ci:local` plans against the branch's upstream; for a pull request, pass
  `--base origin/dev`.
- `release/X.Y` branches and the cherry-pick hotfix steps retire: a hotfix now releases
  through the release PR like everything else.

## Rollout

1. **Done with this ADR**: the docs; `pr-base.yml` and `back-merge.yml`; `ci.yml` and
   `ci-affected.mjs` running the full suite on a push to `dev`; Dependabot's version
   updates (Cargo, Actions) opened against `dev`. Then `dev` is created from `main` with
   a ruleset (pull request and `CI passed` required, merge commits only), `main`'s
   ruleset allows merge commits only, and open pull requests, all but the release PR,
   move to `dev`.
2. **Not done: the version commit on `dev`**: release-please with `target-branch: dev`
   and no GitHub release, and a job on `main` that tags the promotion's `dev`-side parent
   (`HEAD^2`), so release-please on `dev` can find its last release in `dev`'s history.
   Prototype on a fork first: release-please stops on a merged release PR it has not
   tagged, and a tag on `main`'s own merge commit is not in `dev`'s history.
3. **Not done: preview builds from `dev`**: GitHub prereleases `alpha-X.Y.Z-dev.N`,
   never offered by the updater.

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
