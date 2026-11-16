//! atlas-bus — the outbound middleware pipeline for the Atlas agent subsystem.
//!
//! [`OutboundPipeline`] is an ordered chain of [`OutboundMiddleware`] that
//! observes every emitted event (window broadcast, telemetry, capture,
//! memory-ingest). The concrete middleware live in the host; this crate only
//! owns the plumbing, and is generic: no dependency on any agent or ACP type,
//! so it stays reusable and cheap to test.
//!
//! The crate once also held a `tokio::sync::broadcast` fan-out, `EventBus`.
//! Nothing ever subscribed to it, and a consumer that must not lose an event
//! could not have: a broadcast ring drops for a subscriber that lags. Such a
//! consumer is a pipeline stage instead, which runs on the emit thread and
//! cannot lag.

mod middleware;

pub use middleware::{OutboundMiddleware, OutboundPipeline};
