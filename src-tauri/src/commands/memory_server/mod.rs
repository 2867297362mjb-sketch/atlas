//! The **memory tool server**: shared memory as MCP tools, served by the
//! Tauri backend itself. It is the only way memory reaches an agent — nothing
//! is prepended to a prompt (ADR-0010). One of the tenants of the tool server
//! host ([`tool_servers`](crate::commands::tool_servers)), which owns the
//! listener, the session's token and how the server reaches each agent.
//!
//! - **Offered to every agent** in a project with shared memory on
//!   ([`tenant`]). The session's grant says who is calling and which scope's
//!   record to open.
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

// The module's surface. The app builds `MemoryTools` from the source types
// and registers `tenant` on the tool server host; the rest is reached by the
// tests.
#[allow(unused_imports)]
pub use briefing::{SessionClocks, SessionReads};
#[allow(unused_imports)]
pub use tools::{
    tenant, Bootstrap, BootstrapSource, CitationCheck, IndexDoc, IndexEvict, IndexSearch,
    MemoryTools, INSTRUCTIONS,
};

/// Where the service is mounted on the tool-server listener.
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

/// The memory tenant over an empty record with no sources, for the tests of
/// the host and of the other tenants, which need it only to be there.
#[cfg(test)]
pub(crate) fn test_tenant(gate: SharingGate) -> crate::commands::tool_servers::Tenant {
    tenant(MemoryTools::new(
        crate::commands::shared_memory::SharedMemoryStore::default(),
        gate,
        Default::default(),
        Default::default(),
        Sources::default(),
    ))
}
