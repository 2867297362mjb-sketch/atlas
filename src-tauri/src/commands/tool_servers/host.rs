//! The running listener, and the app-level host that owns it.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use tokio::sync::oneshot;

use super::tenant::Tenant;
use super::tokens::{require_token, SessionTokens};

/// The session manager every tenant is mounted on: the host's one session
/// policy. No idle timeout — an agent can go many minutes between calls to
/// any one server, and rmcp's default drops a session idle for five
/// ([`SessionConfig::DEFAULT_KEEP_ALIVE`]), which the next call then has to
/// recover from by initialising again. The timeout exists to reap sessions
/// whose connection silently dropped behind a proxy. This listener is
/// loopback only, so the worst case is a client that went away without
/// closing its session: one parked task until the app quits.
///
/// [`SessionConfig::DEFAULT_KEEP_ALIVE`]: rmcp::transport::streamable_http_server::session::local::SessionConfig::DEFAULT_KEEP_ALIVE
fn session_manager() -> LocalSessionManager {
    let mut sessions = LocalSessionManager::default();
    sessions.session_config.keep_alive = None;
    sessions
}

/// The running listener. Dropping it (or [`shutdown`](Self::shutdown)) stops it.
pub struct ToolServer {
    addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    /// Each tenant's session manager, by tenant name.
    #[cfg(test)]
    sessions: Vec<(&'static str, Arc<LocalSessionManager>)>,
}

impl ToolServer {
    /// Bind `127.0.0.1:0` and serve each of `tenants` at its path, admitting
    /// only requests bearing a live token from `tokens`. One listener and one
    /// token check for all of them: the token table holds one token per
    /// session, so a second listener's token would revoke the first. Returns
    /// once bound; serving continues on the runtime.
    pub async fn start(tokens: Arc<SessionTokens>, tenants: &[Tenant]) -> std::io::Result<Self> {
        for (i, tenant) in tenants.iter().enumerate() {
            if tenants[..i]
                .iter()
                .any(|other| other.name() == tenant.name() || other.path() == tenant.path())
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!(
                        "two tool servers share the name `{}` or the path `{}`",
                        tenant.name(),
                        tenant.path()
                    ),
                ));
            }
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let mut router = axum::Router::new();
        #[cfg(test)]
        let mut mounted = Vec::new();
        for tenant in tenants {
            let sessions = Arc::new(session_manager());
            #[cfg(test)]
            mounted.push((tenant.name(), sessions.clone()));
            router = router.merge(tenant.mount(sessions));
        }
        // Last, so it wraps every tenant.
        let router = router.layer(middleware::from_fn_with_state(tokens, require_token));
        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
            if let Err(e) = served {
                tracing::warn!(target: "atlas::tool_servers", "tool server host stopped: {e}");
            }
        });
        let paths: Vec<&str> = tenants.iter().map(Tenant::path).collect();
        tracing::info!(target: "atlas::tool_servers", "tool server host on http://{addr} serving {paths:?}");
        Ok(Self {
            addr,
            stop: Some(stop),
            #[cfg(test)]
            sessions: mounted,
        })
    }

    /// The endpoint of the tenant served at `path`, e.g. `url_at("/ui")` is
    /// `http://127.0.0.1:53124/ui`.
    pub fn url_at(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    /// How long the tenant named `name` keeps an idle session; `None` inside
    /// is "for ever". `None` outside: no such tenant is mounted.
    #[cfg(test)]
    pub(crate) fn keep_alive_of(&self, name: &str) -> Option<Option<std::time::Duration>> {
        self.sessions
            .iter()
            .find(|(tenant, _)| *tenant == name)
            .map(|(_, sessions)| sessions.session_config.keep_alive)
    }

    /// Stop serving.
    pub fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl Drop for ToolServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The app's one tool server host as managed state: its tokens, its tenants
/// and its listener. Tokens exist from the start; the tenants once the app
/// has [started](Self::start) it; the listener's address once it has bound.
#[derive(Default)]
pub struct ToolServerHost {
    tokens: Arc<SessionTokens>,
    tenants: std::sync::OnceLock<Vec<Tenant>>,
    server: std::sync::OnceLock<ToolServer>,
}

impl ToolServerHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// The live session tokens (minted and revoked by the session lifecycle).
    pub fn tokens(&self) -> &Arc<SessionTokens> {
        &self.tokens
    }

    /// The tool servers on this host, in the order they were registered —
    /// the order a session's entries are offered in.
    pub fn tenants(&self) -> &[Tenant] {
        self.tenants.get().map(Vec::as_slice).unwrap_or_default()
    }

    /// The tenant agents know as `name`.
    pub fn tenant(&self, name: &str) -> Option<&Tenant> {
        self.tenants().iter().find(|tenant| tenant.name() == name)
    }

    /// Whether the listener has bound. Before that, or if binding failed,
    /// sessions run without Atlas's tool servers.
    pub fn is_running(&self) -> bool {
        self.server.get().is_some()
    }

    /// The endpoint of the tenant served at `path`, once the listener has
    /// bound.
    pub fn url_at(&self, path: &str) -> Option<String> {
        self.server.get().map(|s| s.url_at(path))
    }

    /// Register `tenants` and start serving them on the async runtime;
    /// returns at once. A failure to bind is logged and leaves the host not
    /// [running](Self::is_running). A second call is ignored: the host has
    /// one set of tenants.
    pub fn start(self: &Arc<Self>, tenants: Vec<Tenant>) {
        if self.tenants.set(tenants).is_err() {
            return;
        }
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            match ToolServer::start(host.tokens.clone(), host.tenants()).await {
                Ok(server) => {
                    let _ = host.server.set(server);
                }
                Err(e) => {
                    tracing::warn!(target: "atlas::tool_servers", "tool server host did not start: {e}")
                }
            }
        });
    }

    /// A host already serving `tenants`, for tests.
    #[cfg(test)]
    pub(crate) async fn running(tenants: Vec<Tenant>) -> Arc<Self> {
        let host = Self::registered(tenants);
        let server = ToolServer::start(host.tokens.clone(), host.tenants())
            .await
            .expect("the tool server host binds");
        let _ = host.server.set(server);
        host
    }

    /// A host that knows `tenants` but never bound, for tests.
    #[cfg(test)]
    pub(crate) fn registered(tenants: Vec<Tenant>) -> Arc<Self> {
        let host = Arc::new(Self::new());
        let _ = host.tenants.set(tenants);
        host
    }

    /// The running listener, for tests.
    #[cfg(test)]
    pub(crate) fn server(&self) -> &ToolServer {
        self.server.get().expect("the host is running")
    }
}
