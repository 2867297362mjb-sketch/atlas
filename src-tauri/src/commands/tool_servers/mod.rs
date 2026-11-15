//! The **tool server host**: the loopback listener Atlas's MCP tool servers
//! are served on, the per-session bearer tokens that admit a request to it,
//! and the offer that hands the servers to each session.

mod host;
pub(crate) mod offers;
mod tokens;

#[allow(unused_imports)]
pub use host::{ToolServer, ToolServerHost};
#[allow(unused_imports)]
pub use offers::{OfferDecision, SessionOffers, BRIDGE_ARG};
#[allow(unused_imports)]
pub use tokens::{Grant, SessionTokens};

/// How long a client may treat a `tools/list` answer as fresh. The tools
/// never change while the app runs.
pub(crate) const TOOLS_LIST_TTL_MS: u64 = 60 * 60 * 1000;
