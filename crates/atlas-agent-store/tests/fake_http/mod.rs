//! A canned HTTP client, so no test in this crate touches the network.
//!
//! It answers a known URL with known bytes, 404s everything else, and counts
//! requests so a throttle can be asserted.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use atlas_agent_store::http::{HttpClient, HttpResponse};
use futures::future::BoxFuture;
use futures::StreamExt as _;

#[derive(Default)]
pub struct FakeHttp {
    responses: Mutex<HashMap<String, (u16, Vec<u8>)>>,
    requests: Mutex<Vec<String>>,
    /// Held before every response, so a test can keep a fetch in flight long
    /// enough for a second caller to arrive while it is still running.
    delay: Mutex<Option<std::time::Duration>>,
    /// Split every body into chunks of this size. A real server streams, and a
    /// single-chunk fake cannot tell a cumulative byte counter apart from a
    /// per-chunk one — which is the difference between a download cap that
    /// holds and one a slow drip walks straight through.
    chunk_size: Mutex<Option<usize>>,
    /// URL → how many body bytes to deliver before the stream fails. A real
    /// download that loses its connection errors mid-body, not up front, and
    /// a staged install has to be proven to discard what it had.
    fail_after: Mutex<HashMap<String, usize>>,
    /// URL → how many times a stream actually delivered its cut. A test that
    /// sets a cut should assert [`Self::cuts_delivered`], so it cannot pass on
    /// a fault that never fired.
    cuts: Arc<Mutex<HashMap<String, usize>>>,
}

impl FakeHttp {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn with(self: &Arc<Self>, url: &str, status: u16, body: impl Into<Vec<u8>>) -> Arc<Self> {
        let body = body.into();
        if let Some(&cut) = self.fail_after.lock().unwrap().get(url) {
            assert_cut_lands(url, cut, body.len());
        }
        self.responses
            .lock()
            .unwrap()
            .insert(url.to_string(), (status, body));
        self.clone()
    }

    /// Deliver every body in `size`-byte chunks instead of one piece.
    pub fn chunked(self: &Arc<Self>, size: usize) -> Arc<Self> {
        *self.chunk_size.lock().unwrap() = Some(size.max(1));
        self.clone()
    }

    /// Make every response take `delay`, so concurrent callers overlap.
    pub fn slow(self: &Arc<Self>, delay: std::time::Duration) -> Arc<Self> {
        *self.delay.lock().unwrap() = Some(delay);
        self.clone()
    }

    /// Deliver `bytes` of `url`'s body, then fail the stream — a connection
    /// dropped mid-download. Combine with [`Self::chunked`] to decide where the
    /// cut lands relative to a chunk boundary.
    ///
    /// Register `url` with [`Self::with`] first. Panics when the cut cannot
    /// land inside the body: a cut at or past the end would deliver the whole
    /// body, and the test would run without the fault it is about.
    pub fn failing_after(self: &Arc<Self>, url: &str, bytes: usize) -> Arc<Self> {
        let body_len = self
            .responses
            .lock()
            .unwrap()
            .get(url)
            .map(|(_, body)| body.len())
            .unwrap_or_else(|| panic!("failing_after({url}): register the URL with `with` first"));
        assert_cut_lands(url, bytes, body_len);
        self.fail_after
            .lock()
            .unwrap()
            .insert(url.to_string(), bytes);
        self.clone()
    }

    /// Undo [`Self::failing_after`] for `url` — the link came back.
    pub fn heal(self: &Arc<Self>, url: &str) -> Arc<Self> {
        self.fail_after.lock().unwrap().remove(url);
        self.clone()
    }

    /// How many times `url`'s stream delivered its cut.
    pub fn cuts_delivered(&self, url: &str) -> usize {
        self.cuts.lock().unwrap().get(url).copied().unwrap_or(0)
    }

    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    pub fn request_count(&self, url: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|requested| *requested == url)
            .count()
    }
}

impl HttpClient for FakeHttp {
    fn get(&self, url: &str) -> BoxFuture<'static, Result<HttpResponse>> {
        self.requests.lock().unwrap().push(url.to_string());
        let (status, body) = self
            .responses
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .unwrap_or((404, b"not found".to_vec()));
        let delay = *self.delay.lock().unwrap();
        let chunk_size = *self.chunk_size.lock().unwrap();
        let fail_after = self.fail_after.lock().unwrap().get(url).copied();
        let cuts = self.cuts.clone();
        let url = url.to_string();
        Box::pin(async move {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let chunks: Vec<Vec<u8>> = match chunk_size {
                Some(size) if !body.is_empty() => body.chunks(size).map(<[u8]>::to_vec).collect(),
                _ => vec![body],
            };
            let total: usize = chunks.iter().map(Vec::len).sum();
            let body = match fail_after {
                // A cut at or past the end is no cut at all.
                Some(limit) if limit < total => {
                    // Everything up to the cut, then one error, then nothing.
                    let mut delivered = 0usize;
                    let mut kept = Vec::new();
                    for chunk in chunks {
                        if delivered >= limit {
                            break;
                        }
                        let take = chunk.len().min(limit - delivered);
                        delivered += take;
                        kept.push(Ok(chunk[..take].to_vec()));
                    }
                    kept.push(Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "connection reset by peer (fake)",
                    )));
                    // Counted when the error is read, not when the response is
                    // built: a cut nobody reached was not delivered.
                    futures::stream::iter(kept)
                        .inspect(move |item| {
                            if item.is_err() {
                                *cuts.lock().unwrap().entry(url.clone()).or_default() += 1;
                            }
                        })
                        .boxed()
                }
                _ => futures::stream::iter(chunks.into_iter().map(Ok)).boxed(),
            };
            Ok(HttpResponse { status, body })
        })
    }
}

/// A cut at or past the end of the body delivers the whole body, so the test
/// would run without the fault it is about. Checked on the test's own thread,
/// at configuration time: a panic inside `get` would land on whatever task is
/// downloading and come back as an ordinary error.
fn assert_cut_lands(url: &str, cut: usize, body_len: usize) {
    assert!(
        cut < body_len,
        "failing_after({url}): this cut can never fire — the body is {body_len} bytes and the \
         cut is at {cut}. Place the cut relative to the body's length."
    );
}
