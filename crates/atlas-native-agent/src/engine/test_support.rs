//! Shared fixtures for the engine seam's tests.

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::test_support::FakeConnection;
use atlas_acp_thread::AcpThreadHandle;

/// A thread with a discarded event stream, on a connection that does nothing.
///
/// `AcpThread` needs a connection to exist, and tests about the *thread*
/// should not have to stand up an engine to get one. The fake keeps the
/// stream for as long as its script lives, and the thread owns the connection,
/// so every send lands.
pub fn detached_thread(session_id: acp::SessionId) -> AcpThreadHandle {
    FakeConnection::builder()
        .agent("null")
        .fail_new_session("the null connection opens no sessions")
        .fail_prompts("the null connection takes no prompts")
        .build()
        .0
        .open_thread(session_id, Vec::new())
}
