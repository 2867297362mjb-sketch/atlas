//! The shared `FakeConnection` does what its builder says.
//!
//! Every other suite in the tree leans on this fake, so the parts they do not
//! exercise themselves are pinned here: a held turn, an answer delivered by
//! hand, a pushed update, a dropped connection, and the live count.
//!
//! Every wait is bounded. A fake that hung instead of failing would hold a
//! test binary, and the build lock behind it, open.

use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::test_support::{FakeCall, FakeConnection};
use atlas_acp_thread::AgentConnection;
use futures::FutureExt;
use tokio::time::timeout;

const SOON: Duration = Duration::from_secs(5);

fn prompt(session_id: &str, text: &str) -> acp::PromptRequest {
    acp::PromptRequest::new(
        acp::SessionId::new(session_id),
        vec![acp::ContentBlock::Text(acp::TextContent::new(text))],
    )
}

#[tokio::test]
async fn with_nothing_scripted_it_opens_numbered_sessions_and_ends_turns() {
    let (connection, fake) = FakeConnection::builder().agent("some-agent").build();

    assert_eq!(connection.agent_id().as_str(), "some-agent");
    assert!(!connection.supports_load_session());
    assert!(!connection.supports_fork());
    assert!(connection.session_list().is_none());

    let first = connection.clone().new_session(Vec::new()).await.unwrap();
    let second = connection.clone().new_session(Vec::new()).await.unwrap();
    assert_eq!(
        first.lock().unwrap().session_id().to_string(),
        "session-some-agent-0"
    );
    assert_eq!(
        second.lock().unwrap().session_id().to_string(),
        "session-some-agent-1"
    );

    let answer = timeout(SOON, connection.prompt(prompt("s", "hello")))
        .await
        .expect("an unscripted turn ends at once")
        .unwrap();
    assert_eq!(answer.stop_reason, acp::StopReason::EndTurn);
    assert_eq!(
        fake.calls(),
        vec![
            FakeCall::NewSession,
            FakeCall::NewSession,
            FakeCall::Prompt {
                session_id: "s".into(),
                text: "hello".into()
            },
        ]
    );
}

#[tokio::test]
async fn a_held_turn_runs_until_released_or_cancelled() {
    let (connection, fake) = FakeConnection::builder().hold_prompts().build();

    let mut turn = connection.prompt(prompt("s", "one"));
    assert!(
        (&mut turn).now_or_never().is_none(),
        "held until the test says otherwise"
    );
    fake.release_prompt();
    timeout(SOON, turn).await.expect("released").unwrap();

    let turn = connection.prompt(prompt("s", "two"));
    connection.cancel(&acp::SessionId::new("s"));
    timeout(SOON, turn)
        .await
        .expect("a cancel ends it")
        .unwrap();
    assert_eq!(fake.cancels(), 1);
    assert_eq!(fake.prompts(), vec!["one", "two"]);
}

#[tokio::test]
async fn a_queued_answer_is_delivered_by_hand_ahead_of_the_script() {
    let (connection, fake) = FakeConnection::builder()
        .fail_prompts("the model refused")
        .build();

    let answer = fake.queue_prompt();
    let turn = connection.prompt(prompt("s", "one"));
    answer.send(Ok(acp::StopReason::Cancelled)).unwrap();
    let response = timeout(SOON, turn).await.expect("answered").unwrap();
    assert_eq!(response.stop_reason, acp::StopReason::Cancelled);

    // The queue is empty again, so the script answers.
    let error = timeout(SOON, connection.prompt(prompt("s", "two")))
        .await
        .expect("a scripted failure is immediate")
        .expect_err("the script fails every turn");
    assert_eq!(error.to_string(), "the model refused");
}

#[tokio::test]
async fn a_pushed_update_lands_on_the_sessions_thread() {
    let (connection, fake) = FakeConnection::builder().session_id("s-1").build();
    let thread = connection.clone().new_session(Vec::new()).await.unwrap();
    let session_id = acp::SessionId::new("s-1");
    fake.drain_events(&session_id);

    fake.push_update(
        &session_id,
        acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(acp::ContentBlock::Text(
            acp::TextContent::new("hello"),
        ))),
    )
    .expect("the session is open");

    assert_eq!(thread.lock().unwrap().entries().len(), 1);
    assert!(
        !fake.drain_events(&session_id).is_empty(),
        "and the thread announced it"
    );
    assert!(
        fake.push_update(
            &acp::SessionId::new("nobody"),
            acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(acp::ContentBlock::Text(
                acp::TextContent::new("lost")
            ))),
        )
        .is_err(),
        "an update for a session the fake never opened is refused"
    );
}

#[tokio::test]
async fn a_dropped_connection_resolves_exited_and_not_before() {
    let (connection, fake) = FakeConnection::builder().build();

    let mut exited = connection.clone().exited();
    assert!((&mut exited).now_or_never().is_none());
    fake.drop_connection();
    timeout(SOON, exited).await.expect("the process is gone");
}

#[tokio::test]
async fn the_handle_keeps_no_connection_or_thread_alive() {
    let (connection, fake) = FakeConnection::builder().session_id("s-1").build();
    let again = fake.connection();
    assert_eq!(fake.live_connections(), 2);
    drop(again);
    assert_eq!(fake.live_connections(), 1);

    let thread = connection.clone().new_session(Vec::new()).await.unwrap();
    drop(connection);
    assert_eq!(fake.live_connections(), 1, "the thread owns its connection");
    drop(thread);
    assert_eq!(fake.live_connections(), 0);
    assert!(fake.thread(&acp::SessionId::new("s-1")).is_none());
}

#[tokio::test]
async fn capabilities_are_what_the_builder_advertised() {
    let (connection, fake) = FakeConnection::builder()
        .supports_load()
        .supports_close()
        .supports_fork("s-forked")
        .supports_effort()
        .supports_session_list()
        .supports_session_delete()
        .build();
    let session_id = acp::SessionId::new("s-1");

    assert!(connection.supports_load_session());
    assert!(connection.supports_close_session());
    assert!(connection.supports_fork());
    let forked = connection.fork(&session_id).unwrap().run().await.unwrap();
    assert_eq!(forked.to_string(), "s-forked");
    connection
        .session_effort(&session_id)
        .unwrap()
        .set_effort(Some("high".into()))
        .unwrap();
    let list = connection.session_list().unwrap();
    assert!(list.supports_delete());
    list.delete_session(&session_id).await.unwrap();
    connection
        .clone()
        .close_session(session_id.clone())
        .await
        .unwrap();

    assert_eq!(
        fake.call_names(),
        vec!["fork", "set_effort", "delete_session", "close_session"]
    );
    assert_eq!(fake.efforts(), vec![Some("high".to_string())]);
    assert_eq!(fake.closes(), vec!["s-1"]);
}
