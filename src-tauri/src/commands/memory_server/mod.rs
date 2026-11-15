//! The **memory tool server**: shared memory as MCP tools, served by the
//! Tauri backend itself over streamable HTTP on loopback. It is the only way
//! memory reaches an agent — nothing is prepended to a prompt (ADR-0010).
//!
//! - **One server per app**, bound to `127.0.0.1` on a port the OS picks. The
//!   app starts it at setup on the async runtime, so the main thread never
//!   waits on it ([`ToolServerHost::start`]).
//! - **One bearer token per (session, scope)** ([`tokens`]): minted when a
//!   session starts, revoked when it ends, checked on every request. The
//!   token says who is calling and which scope's record to open.
//! - **Handed to every agent** ([`offers`]): every ACP agent as a stdio
//!   server (this binary's `mcp-bridge`, ADR-0019), the token in a private
//!   file the entry names and never in the entry itself, which an adapter may
//!   put on a command line (ADR-0020); the native agent over HTTP through its
//!   thread's engine config.
//! - **Ten tools** ([`tools`]), read first, write last: `memory_briefing`,
//!   `memory_changes`, `memory_search`, `memory_get`, `memory_list`,
//!   `memory_history`, `memory_why`, `memory_remember`, `memory_feedback`,
//!   `memory_forget`. The server's instructions
//!   ([`INSTRUCTIONS`]) tell the agent when to call each — the briefing first
//!   in every session — because with nothing pushed, the protocol is what
//!   makes memory reach the model.
//! - **What a session has seen** ([`briefing`]): a per-session clock behind
//!   `memory_changes`, so a resumed agent asks for the delta rather than the
//!   whole record again.
//! - **Failure is "no memory", never a crash.** A read that fails returns an
//!   empty result; a write that fails returns a tool error the agent can read.

#[cfg(test)]
mod bench;
mod briefing;
#[cfg(test)]
mod tests;
mod tools;

// The module's surface. The app wires `ToolServerHost`, `SessionOffers`
// and the source types; the rest is reached through the host or by the tests.
#[allow(unused_imports)]
pub use briefing::{SessionClocks, SessionReads};
pub(crate) use tools::MemoryTools;
#[allow(unused_imports)]
pub use tools::{
    Bootstrap, BootstrapSource, CitationCheck, IndexDoc, IndexEvict, IndexSearch, INSTRUCTIONS,
};

/// The path the MCP endpoint is served at.
pub const MCP_PATH: &str = "/mcp";

/// The name the server goes by in every agent's MCP configuration.
pub const MEMORY_SERVER_NAME: &str = "atlas_memory";

/// Whether shared memory is switched on for a launch directory (the Memory
/// panel's sharing toggle). Checked on every tool call, so flipping it off
/// mid-session takes effect at once.
pub type SharingGate = std::sync::Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// What the tools answer from beyond the record: the project's indexed
/// documents (`memory_search`) and the first-look extras (`memory_briefing`:
/// the curated pack read from foreign stores, and the recent-session
/// handoff). Both are seams into the app; a server without them answers from
/// the record alone.
#[derive(Clone, Default)]
pub struct Sources {
    pub index: Option<IndexSearch>,
    pub bootstrap: Option<BootstrapSource>,
    /// Drop one document from the index now (`memory_forget`). Without it a
    /// forgotten entry's text stays retrievable until the next corpus pass.
    pub evict: Option<IndexEvict>,
    /// The session recorder, read-only: where a memory's writing session is
    /// resolved to its title and commits. The default reads the launch
    /// directory and the repository's worktrees.
    pub capture: crate::commands::memory_capture::CaptureReader,
    /// Checks a memory's code citations (M3). Without it the cited files are
    /// read directly, with no symbol lookup for moved code.
    pub check: Option<CitationCheck>,
}
