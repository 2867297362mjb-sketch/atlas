//! Atlas Agent — the native agent — on the `AgentConnection` seam.
//!
//! The native agent occupies the same slot an external ACP agent does, so the
//! manager, the thread model and the UI treat it identically. Everything
//! specific to it — fork, reasoning effort, refreshing its own model list —
//! is a capability it advertises on that seam, which any other agent could
//! advertise too.
//!
//! # One engine, no switch
//!
//! The previous native runtime that used to back this seam is gone (#54). The
//! engine in [`engine`] is the only implementation, and it is no longer
//! behind a cargo feature — the development-time switch existed so the previous
//! native path could keep shipping while the engine was proved, and there is no
//! longer a second path for it to select.
//!
//! What survived the deletion, deliberately:
//!
//! - **[`ATLAS_AGENT_ID`]** — the stored agent id, the literal string
//!   `"atlas-agent"`. It is a **storage key**: every recorded thread resolves
//!   through it, so it is the one string the app and the store must agree on
//!   (ADR-0011).
//! - **Reasoning effort** — a control ACP has no word for. It crosses the
//!   seam as a capability the connection advertises
//!   (`AgentConnection::session_effort`), as fork and the model-catalogue
//!   refresh do; the app never reaches for the concrete connection.
//!
//! What did not: tool-output compression. It had no engine counterpart and is
//! a named casualty (D8), so the trait, its command and its toggle are gone
//! rather than left as a control that does nothing.
//!
//! # What the native agent does not implement, and why
//!
//! - **`AgentSessionTruncate`.** Rewinding to a user message needs a map from
//!   client message id to history index; the engine stores neither.
//! - **`auth_methods` / `authenticate`.** The native agent authenticates with
//!   the user's Atlas account through the D10 token provider, not with an ACP
//!   auth method. It advertises none, which is what makes the sign-in flow skip
//!   it.
//! - **Elicitations, bar one.** Nothing is asked of the user mid-turn except
//!   tool permission and a clarifying question (ADR-0013). Permission has its
//!   own path; the question is the engine's `request_user_input` tool, raised
//!   as an elicitation on the thread so the existing question card answers it
//!   ([`engine::questions`]). MCP servers' elicitations stay refused: a tool
//!   server returns candidates and the model asks. The one elicitation served
//!   is the engine's OWN — its approval before an outward action on one of
//!   Atlas's tool servers (ADR-0014), which is tool permission in an MCP
//!   envelope and goes to the approval card ([`engine::tool_approvals`]).

pub mod engine;
mod helper;
#[cfg(target_os = "linux")]
mod linux_sandbox;

/// The native agent's stored id.
///
/// A storage key every recorded thread resolves through, so it must match the
/// frontend's `NATIVE_AGENT_ID` and the thread-metadata store's rows. It was
/// renamed from the retired id in ADR-0011; rows under the old id were dropped
/// by the store's V3 migration rather than aliased. Renaming it again is a data
/// migration, not a rename.
pub const ATLAS_AGENT_ID: &str = "atlas-agent";

/// Install the OS credential store (idempotent) before making a `keyring_core::Entry`.
///
/// keyring-core has no store until one is set; the engine's own keychain access
/// installs it lazily through the same function, so the app and the engine share one
/// process-wide default and neither can run first.
pub use atlas_engine_keyring_store::ensure_default_store as ensure_credential_store;
pub use engine::connection::EngineConnection;
pub use engine::EngineAgentServer;
pub use helper::run_engine_helper_if_asked;
