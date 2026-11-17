//! Packs: a plugin-shaped tree that ships several component kinds (skills,
//! agents, commands, hooks, rules, scripts), installed into
//! `<root>/.atlas/packs/<name>/` and projected into each tool's homes.

pub(crate) mod install;
pub(crate) mod lockfile;
pub(crate) mod parse;
pub(crate) mod projection;
pub(crate) mod source;
