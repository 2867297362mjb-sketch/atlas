//! The skill store.
//!
//! Atlas manages agent "skills" the same way the `skills` CLI and Zed do: a
//! single **canonical store** — `~/.agents/skills` (global) / `<project>/.agents/skills`
//! (project) — holds the authored `SKILL.md`, and each agent that should "see"
//! the skill gets a **symlink** into its own skills directory. Disk *is* the
//! state — there is no separate enable/disable file. See
//! `docs/adr/0005-agents-skills-is-the-canonical-store-acp-advertisement-is-the-picker.md`:
//! Atlas does not run its own second store anymore, it reads/writes the same
//! `.agents/skills` tree skills.sh and Zed already use.
//!
//! ```text
//! canonical (= installed, managed by Atlas):
//!   <root>/.agents/skills/<name>/SKILL.md
//! enablement (= symlink present, what the agent reads):
//!   <root>/.claude/skills/<name> -> ../../.agents/skills/<name>
//! ```
//!
//! `<root>` is the home dir (global scope) or the project path (project scope).
//! The agent registry is a static table for v1 (Claude Code + Codex, and the
//! native agent); detection is "does the agent's config dir exist under
//! `<root>`?". Note Codex's own *project*-scope skills dir was already
//! `.agents/skills` before this store converged onto the same path — see the
//! native-location guard in `projection`.
//!
//! Discovery also surfaces **external** skills: real directories (or symlinks
//! to directories, e.g. a skills.sh/Zed projection) that live directly in an
//! agent's skills dir (e.g. `~/.claude/skills/<name>/SKILL.md`) and are not the
//! canonical store's own entries. These are `managed = false`; the "Make for
//! all agents" (adopt) operation copies them into the canonical store and fans
//! them out to every detected agent via symlink.
//!
//! A pre-convergence Atlas install may still have content sitting in the old
//! `.atlas/skills` store; discovery moves it into the canonical store the
//! first time it finds it.
//!
//! Security: skill names are sanitized and every resolved path is verified to
//! stay inside `<root>/.agents/skills` so a crafted name can't escape via `..`.
