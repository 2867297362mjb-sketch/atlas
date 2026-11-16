//! Whether a session is offered the organisation tool server, and in which
//! organisation it will act.
//!
//! The tool server host asks every tenant whether a session is offered it;
//! this is the organisation server's own answer ([`admission`]). Unlike the
//! other tenants' it yields something besides yes or no: the [`OrgScope`] the
//! Project is bound to, which it stamps on the session's grant.

use std::sync::Arc;

use super::{OrgAccessGate, OrgScope};
use crate::commands::tool_servers::Grant;

/// What the offer needs to know about the account and the Project, read from
/// the app's existing state: whether anyone is signed in, and which
/// organisation and Workspace a launch directory's Project is bound to. A
/// seam so the offer can be decided in a test without an account or a
/// capture store.
pub trait SessionOrgs: Send + Sync {
    /// Whether an account is signed in on this machine.
    fn signed_in(&self) -> bool;
    /// The organisation (and Workspace) the Project in `cwd` is bound to, or
    /// `None` when it is not bound to the cloud — local-only, never bound,
    /// capture switched off, or its store unreadable. A binding with no
    /// Workspace still names its organisation here; the offer, not this,
    /// decides that it is not enough.
    fn bound_to(&self, cwd: &str) -> Option<OrgScope>;
}

/// The organisation server's admission rule. The setting, the account and
/// the binding are read only when they can matter, in that order: a session
/// with the setting off never opens a store. Bound means bound to a
/// Workspace: a binding made before the server's Workspace id was recorded
/// names an organisation but nothing to read.
pub(super) fn admission(
    gate: OrgAccessGate,
    orgs: Arc<dyn SessionOrgs>,
) -> impl Fn(&str, &mut Grant) -> Result<(), &'static str> + Send + Sync + 'static {
    move |cwd, grant| {
        if !gate(cwd) {
            return Err("organisation access is off in Settings");
        }
        if !orgs.signed_in() {
            return Err("not signed in");
        }
        let scope = orgs
            .bound_to(cwd)
            .filter(|scope| scope.workspace_id.is_some())
            .ok_or("project is not bound to a cloud Workspace")?;
        grant.org = Some(scope);
        Ok(())
    }
}
