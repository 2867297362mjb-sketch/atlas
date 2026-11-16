//! Ordered middleware chains for the agent subsystem.
//!
//! Outbound only: observe every emitted agent event (`E`). Used by the host for
//! the window broadcast, telemetry, and memory-ingest — each a small, testable
//! unit instead of one monolithic sink body.

use std::sync::Arc;

/// Observes an emitted event. Implementations must be cheap / non-blocking on
/// the calling thread — offload heavy work (disk, network) to a spawned task.
pub trait OutboundMiddleware<E>: Send + Sync {
    fn on_event(&self, event: &E);
}

/// An ordered chain of outbound middleware. `run` invokes each in registration
/// order for a single event.
pub struct OutboundPipeline<E> {
    stages: Vec<Arc<dyn OutboundMiddleware<E>>>,
}

impl<E> OutboundPipeline<E> {
    pub fn new() -> Self {
        Self { stages: Vec::new() }
    }

    /// Append a stage (builder style).
    pub fn with(mut self, stage: Arc<dyn OutboundMiddleware<E>>) -> Self {
        self.stages.push(stage);
        self
    }

    /// Append a stage in place.
    pub fn push(&mut self, stage: Arc<dyn OutboundMiddleware<E>>) {
        self.stages.push(stage);
    }

    /// Run every stage for `event`, in order.
    pub fn run(&self, event: &E) {
        for stage in &self.stages {
            stage.on_event(event);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.stages.is_empty()
    }
}

impl<E> Default for OutboundPipeline<E> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Recorder {
        tag: &'static str,
        log: Arc<Mutex<Vec<String>>>,
    }
    impl OutboundMiddleware<u32> for Recorder {
        fn on_event(&self, event: &u32) {
            self.log
                .lock()
                .unwrap()
                .push(format!("{}:{event}", self.tag));
        }
    }

    #[test]
    fn outbound_runs_in_order() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let pipe = OutboundPipeline::new()
            .with(Arc::new(Recorder {
                tag: "a",
                log: log.clone(),
            }))
            .with(Arc::new(Recorder {
                tag: "b",
                log: log.clone(),
            }));
        pipe.run(&5);
        assert_eq!(*log.lock().unwrap(), vec!["a:5", "b:5"]);
    }

    /// Why a consumer that must not miss an event is a stage here: the
    /// pipeline runs synchronously on the emit thread, so it cannot lag and
    /// has no buffer to overflow. A burst far larger than any ring a
    /// subscription would be given arrives whole and in order.
    ///
    /// Session capture depends on this: a dropped event there is a turn
    /// missing from the permanent record.
    #[test]
    fn the_pipeline_sees_every_event_of_a_burst_in_order() {
        const BURST: u32 = 4096;

        let seen = Arc::new(Mutex::new(Vec::new()));
        let pipe = OutboundPipeline::new().with(Arc::new(Recorder {
            tag: "capture",
            log: seen.clone(),
        }));

        for event in 0..BURST {
            pipe.run(&event);
        }

        let expected: Vec<String> = (0..BURST).map(|event| format!("capture:{event}")).collect();
        assert_eq!(*seen.lock().unwrap(), expected);
    }
}
