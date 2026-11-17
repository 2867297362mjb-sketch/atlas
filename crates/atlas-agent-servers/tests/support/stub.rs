//! A no-op `AgentConnection` for tests that need a thread but never talk to an
//! agent.

use std::sync::Arc;

use atlas_acp_thread::test_support::FakeConnection;
use atlas_acp_thread::AgentConnection;

pub fn stub_connection() -> Arc<dyn AgentConnection> {
    FakeConnection::builder()
        .agent("stub")
        .fail_new_session("stub")
        .fail_prompts("stub")
        .build()
        .0
}
