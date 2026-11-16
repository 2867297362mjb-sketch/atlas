//! The frontend's TypeScript for the app-state payloads is generated from the
//! Rust types and committed under `src/bindings/app-state/`: what
//! `bootstrap_app_state` answers ([`BootstrapPayload`]) and what
//! `save_app_state` takes ([`AppStatePatch`]), with every type they reach.
//! The app store and the stores it hydrates read those types, so a field
//! added, renamed or retyped here reaches each reader as a `tsc` error
//! instead of an `undefined` at runtime, or a key serde drops in silence.
//!
//! Beside the types sits `fixtures.ts`: the JSON these payloads serialize to,
//! for a fully populated state and for one with every optional field empty,
//! each held to its type with `satisfies`. That is the join between the two
//! sides. The types say what the derive read from the attributes; the
//! fixtures are what `serde_json` wrote. `tsc` fails when they disagree: a
//! key the type lacks, one it requires that never arrives, a `null` it does
//! not allow. They are a TypeScript module and not `.json` because an
//! imported `.json` has its string literals widened, so a tagged enum's tag
//! never matches its union, and is not checked for keys the type lacks. The
//! frontend's restart test (`app-state-restart.test.ts`) hydrates the real
//! stores from the same module.
//!
//! [`committed_bindings_match_the_rust_types`] regenerates the whole tree and
//! compares it with the committed one, file for file. `bun run bindings:gen`
//! rewrites it; review the diff, then fix whatever no longer type-checks.
//!
//! `settings` is left out of the fixtures. Its TypeScript is written by
//! `bun run settings:gen` from the registry the Rust struct is held to, and
//! a fixture holding every default would go stale with each new setting.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use ts_rs::{Config, TS};

use super::app_state::fixtures::{full_state, minimal_state, patch_of};
use super::app_state::AppStatePatch;
use super::atlas_config::{AppSettings, ConfigStatus};
use crate::commands::app_state::BootstrapPayload;

const REGENERATE: &str = "`bun run bindings:gen`";

fn committed_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/bindings/app-state")
}

/// Every `.ts` file directly under `dir`, by name. The export writes no
/// subdirectories.
fn read_dir_ts(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries {
        let path = entry.expect("reads a directory entry").path();
        if path.extension().is_some_and(|e| e == "ts") {
            let name = path.file_name().expect("has a name").to_string_lossy();
            out.insert(
                name.into_owned(),
                fs::read_to_string(&path).expect("reads a binding"),
            );
        }
    }
    out
}

/// `value` as indented JSON with its keys sorted. `serde_json`'s own order
/// depends on whether some crate in the graph turned on `preserve_order`,
/// and the committed file must not.
fn write_json(value: &Value, indent: usize, out: &mut String) {
    let pad = "  ".repeat(indent + 1);
    let close = "  ".repeat(indent);
    match value {
        Value::Object(map) if !map.is_empty() => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            out.push_str("{\n");
            for key in keys {
                out.push_str(&pad);
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                write_json(&map[key], indent + 1, out);
                out.push_str(",\n");
            }
            out.push_str(&close);
            out.push('}');
        }
        Value::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            for item in items {
                out.push_str(&pad);
                write_json(item, indent + 1, out);
                out.push_str(",\n");
            }
            out.push_str(&close);
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// What `bootstrap_app_state` answers for `state`, less its settings.
fn bootstrap_json(state: super::AppState, config_status: ConfigStatus) -> Value {
    let payload = BootstrapPayload {
        state,
        settings: AppSettings::default(),
        config_generation: 7,
        config_status,
    };
    let mut value = serde_json::to_value(payload).expect("serializes the payload");
    value
        .as_object_mut()
        .expect("is an object")
        .remove("settings")
        .expect("carries settings");
    value
}

fn fixtures_module() -> String {
    let full = full_state();
    let minimal = minimal_state();
    let consts: [(&str, &str, &str, Value); 4] = [
        (
            "bootstrapFull",
            "Bootstrap",
            "`bootstrap_app_state`'s answer for a state with every field set.",
            bootstrap_json(
                full.clone(),
                ConfigStatus::UsingLastKnownGood {
                    error: "line 3: expected a boolean".into(),
                },
            ),
        ),
        (
            "bootstrapMinimal",
            "Bootstrap",
            "The same for a state with every optional field empty.",
            bootstrap_json(minimal.clone(), ConfigStatus::Ok),
        ),
        (
            "patchFull",
            "AppStatePatch",
            "The `save_app_state` payload that reproduces `bootstrapFull`.",
            serde_json::to_value(patch_of(&full)).expect("serializes the patch"),
        ),
        (
            "patchMinimal",
            "AppStatePatch",
            "The `save_app_state` payload that reproduces `bootstrapMinimal`.",
            serde_json::to_value(patch_of(&minimal)).expect("serializes the patch"),
        ),
    ];

    let mut out = String::from(
        "// This file was generated by `src-tauri/src/state/app_state_bindings.rs`. Do not edit\n\
         // this file manually: `bun run bindings:gen` rewrites it.\n\
         //\n\
         // What the Rust side serializes, held to the generated types. `tsc` fails here\n\
         // when a type and the JSON it describes disagree.\n\
         import type { AppStatePatch } from \"./AppStatePatch\";\n\
         import type { BootstrapPayload } from \"./BootstrapPayload\";\n\
         \n\
         /** Settings are generated from their own registry (`bun run settings:gen`). */\n\
         type Bootstrap = Omit<BootstrapPayload, \"settings\">;\n",
    );
    for (name, ty, doc, value) in consts {
        out.push_str(&format!("\n/** {doc} */\nexport const {name} = "));
        write_json(&value, 0, &mut out);
        out.push_str(&format!(" satisfies {ty};\n"));
    }
    out
}

fn generate() -> BTreeMap<String, String> {
    let out = tempfile::tempdir().expect("creates a temp dir");
    // Large integers cross Tauri's IPC as JSON, which has no bigint.
    let cfg = Config::new()
        .with_large_int("number")
        .with_out_dir(out.path());
    BootstrapPayload::export_all(&cfg).expect("exports the bootstrap payload");
    AppStatePatch::export_all(&cfg).expect("exports the patch");
    let mut tree = read_dir_ts(out.path());
    tree.insert("fixtures.ts".into(), fixtures_module());
    tree
}

#[test]
fn committed_bindings_match_the_rust_types() {
    let fresh = generate();
    for expected in ["BootstrapPayload.ts", "AppStatePatch.ts", "Organisation.ts"] {
        assert!(
            fresh.contains_key(expected),
            "the export did not write {expected}: {:?}",
            fresh.keys().collect::<Vec<_>>()
        );
    }
    let dir = committed_dir();

    if std::env::var_os("ATLAS_BLESS").is_some() {
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("creates the dir");
        for (name, text) in &fresh {
            fs::write(dir.join(name), text).expect("writes a binding");
        }
        return;
    }

    let committed = read_dir_ts(&dir);
    let missing: Vec<_> = fresh
        .keys()
        .filter(|k| !committed.contains_key(*k))
        .collect();
    let stale: Vec<_> = committed
        .keys()
        .filter(|k| !fresh.contains_key(*k))
        .collect();
    let changed: Vec<_> = fresh
        .iter()
        .filter(|(k, v)| committed.get(*k).is_some_and(|c| c != *v))
        .map(|(k, _)| k)
        .collect();
    assert!(
        missing.is_empty() && stale.is_empty() && changed.is_empty(),
        "src/bindings/app-state/ is out of date with the Rust types: run {REGENERATE} and \
         review the diff.\n  missing: {missing:?}\n  no longer generated: {stale:?}\n  \
         changed: {changed:?}"
    );
}

/// The patch fixtures are what the frontend must send. They deserialize as
/// the patch they were written from, so the fixture and the command agree on
/// every key.
#[test]
fn the_patch_fixtures_deserialize_as_the_patch_they_came_from() {
    for state in [full_state(), minimal_state()] {
        let patch = patch_of(&state);
        let json = serde_json::to_value(&patch).expect("serializes the patch");
        let back: AppStatePatch = serde_json::from_value(json).expect("deserializes the patch");
        assert_eq!(back, patch);
    }
}
