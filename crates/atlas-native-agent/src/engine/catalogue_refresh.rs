//! The picker's Refresh (ADR-0007, decision 5), behind the seam's
//! [`AgentModelCatalogue`] capability.
//!
//! The whole policy is here, in one call, so the host holds none of it: it
//! asks whichever of the connection and the launcher is in play to refresh,
//! and acts on the outcome it is handed. Three outcomes, decided by comparing
//! what the gateway now says with what the live engine loaded at connect:
//!
//! - **No live engine** ([`ModelCatalogueOutcome::Stored`]): the cache is
//!   rewritten and the next connect reads it. Nothing to reconcile.
//! - **Same fingerprint** — same slugs and context windows
//!   ([`ModelCatalogueOutcome::Applied`]): labels swap into the live
//!   connection. No teardown.
//! - **Different fingerprint** ([`ModelCatalogueOutcome::ReconnectRequired`]):
//!   the engine loaded rows it will not reload, and a slug it does not know
//!   gets invented metadata the gateway `400`s. The connection has to go, and
//!   only the host can do that — it knows which sessions are open and whether
//!   a turn is running — so this says so and changes nothing live.
//!
//! In all three the cache is already rewritten by the time the outcome is
//! known, so a reconnect the host has to postpone loses nothing. A gateway
//! that does not answer is an `Err` within
//! [`FETCH_TIMEOUT`](super::catalog_cache::FETCH_TIMEOUT) (ADR-0008), with the
//! cache and the live list left as they were: unlike a connect, a refresh
//! does not fall back, because the caller asked whether the gateway answered.

use std::sync::Arc;
use std::sync::RwLock;

use anyhow::anyhow;
use anyhow::Result;
use atlas_acp_thread::{
    AgentModelCatalogue, AgentModelId, AgentModelInfo, ModelCatalogueEmpty, ModelCatalogueOutcome,
    ModelCatalogueRefresh,
};
use futures::future::BoxFuture;
use futures::FutureExt;

use super::auth::SystemClock;
use super::catalog_cache::{project, refresh_now, CatalogueFetcher};
use super::config::EngineHome;
use super::connection::{swap_catalogue_metadata, LiveCatalogue};

pub(crate) struct CatalogueRefresh {
    /// Where the cache lives.
    pub(crate) home: EngineHome,
    pub(crate) fetcher: Arc<dyn CatalogueFetcher>,
    /// The catalogue of the connection that handed this out. `None` when the
    /// launcher did: no engine is running on any list.
    pub(crate) live: Option<Arc<RwLock<LiveCatalogue>>>,
}

impl AgentModelCatalogue for CatalogueRefresh {
    fn refresh(&self) -> BoxFuture<'static, Result<ModelCatalogueRefresh>> {
        let home = self.home.clone();
        let fetcher = self.fetcher.clone();
        let live = self.live.clone();
        async move {
            let cache = refresh_now(home.path(), fetcher.as_ref(), &SystemClock)
                .await
                .map_err(|err| anyhow!("could not refresh models: {err}"))?;
            let Some(projected) = project(&cache) else {
                // Written anyway: the next connect will refuse on the same
                // grounds, honestly, rather than run on the previous list.
                return Err(ModelCatalogueEmpty.into());
            };
            let models = projected.picker.clone();
            let default_model = AgentModelId::new(projected.default_model.as_str());
            let outcome = match live {
                None => ModelCatalogueOutcome::Stored,
                Some(live) => {
                    let next = LiveCatalogue::from_projection(projected, cache.fetched_at, false);
                    match swap_catalogue_metadata(&live, next) {
                        Ok(before) => ModelCatalogueOutcome::Applied {
                            changed: labels(&before.picker) != labels(&models),
                        },
                        Err(_) => ModelCatalogueOutcome::ReconnectRequired,
                    }
                }
            };
            Ok(ModelCatalogueRefresh {
                models,
                default_model,
                outcome,
            })
        }
        .boxed()
    }
}

/// What the picker shows of each row: the only part a same-fingerprint
/// refresh can change.
fn labels(models: &[AgentModelInfo]) -> Vec<(&str, Option<&str>)> {
    models
        .iter()
        .map(|model| (&*model.name, model.description.as_deref()))
        .collect()
}
