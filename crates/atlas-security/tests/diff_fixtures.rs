//! `parse_unified` over the cases every unified-diff reader in Atlas is held
//! to: `src/features/git/lib/unified-diff.fixtures.json`, whose docblock is in
//! `unified-diff.fixtures.test.ts` beside it.
//!
//! What this reader is for is the scan: which files a commit touches, under
//! which path, renamed from where, binary or not, and each hunk's lines with
//! the line numbers a finding is reported at. So a case is read as exactly
//! that. Two things it states differently from the fixtures, by design:
//!
//! - a line's text has no trailing `\r` (a rule matches the line, not its
//!   ending), so the fixture's `\r` is dropped before comparing;
//! - it also numbers lines, which the fixtures do not state, so the expected
//!   numbers are counted from each hunk's start here.
//!
//! A case it reads differently is in `DIFFERS`, with why that is not a case
//! it is given and what it answers instead. An entry that stops differing
//! fails, so a fix removes it.

use atlas_security::diff::{parse_unified, FileStatus, LineKind};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    diff: String,
    files: Vec<FixtureFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureFile {
    path: String,
    old_path: Option<String>,
    #[serde(default)]
    binary: bool,
    hunks: Vec<FixtureHunk>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureHunk {
    old_start: u32,
    new_start: u32,
    lines: Vec<String>,
}

/// One file as the scan sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Reading {
    path: String,
    renamed_from: Option<String>,
    binary: bool,
    /// `(old start, new start, lines)`, a line being its marker and its text.
    hunks: Vec<(u32, u32, Vec<String>)>,
    /// Every added line with its number in the new file.
    added: Vec<(u32, String)>,
}

fn stated(file: &FixtureFile) -> Reading {
    let mut added = Vec::new();
    let hunks = file
        .hunks
        .iter()
        .map(|hunk| {
            let mut new_no = hunk.new_start;
            let lines: Vec<String> = hunk
                .lines
                .iter()
                .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
                .collect();
            for line in &lines {
                match line.as_bytes()[0] {
                    b'+' => {
                        added.push((new_no, line[1..].to_string()));
                        new_no += 1;
                    }
                    b' ' => new_no += 1,
                    _ => {}
                }
            }
            (hunk.old_start, hunk.new_start, lines)
        })
        .collect();
    Reading {
        path: file.path.clone(),
        renamed_from: file.old_path.clone(),
        binary: file.binary,
        hunks,
        added,
    }
}

fn read(diff: &str) -> Vec<Reading> {
    parse_unified(diff.as_bytes())
        .iter()
        .map(|file| Reading {
            path: file.path.clone(),
            renamed_from: match &file.status {
                FileStatus::Renamed { from } => Some(from.clone()),
                _ => None,
            },
            binary: file.binary,
            hunks: file
                .hunks
                .iter()
                .map(|hunk| {
                    let lines = hunk.lines.iter().map(|line| {
                        let marker = match line.kind {
                            LineKind::Added => '+',
                            LineKind::Removed => '-',
                            LineKind::Context => ' ',
                        };
                        format!("{marker}{}", line.text)
                    });
                    (hunk.old_start, hunk.new_start, lines.collect())
                })
                .collect(),
            added: file
                .added_lines()
                .map(|(no, text)| (no, text.to_string()))
                .collect(),
        })
        .collect()
}

/// Case, why the scan is never handed it, and what the reader answers
/// instead (as an edit to what the fixture states).
type Differs = (&'static str, &'static str, fn(&mut Vec<Reading>));

const DIFFERS: &[Differs] = &[
    (
        "mnemonic-prefix",
        "the scan reads `git diff-tree`, plumbing, which ignores diff.mnemonicPrefix and always \
         prints a/ and b/; only those two prefixes are stripped",
        |files| files[0].path = "i/blank-context.txt".to_string(),
    ),
    (
        "combined-merge",
        "the scan reads one commit against its first parent, never a conflicted merge; a `@@@` \
         hunk is skipped like anything else it does not recognise",
        |files| {
            files[0].hunks.clear();
            files[0].added.clear();
        },
    ),
];

#[test]
fn it_reads_the_shared_fixtures_as_they_state() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../../src/features/git/lib/unified-diff.fixtures.json"
    ))
    .expect("the fixture table parses");
    assert!(cases.len() >= 20);
    for (name, why, _) in DIFFERS {
        assert!(
            cases.iter().any(|case| case.name == *name),
            "DIFFERS names a case that is gone: {name}"
        );
        assert!(why.len() >= 20, "{name}: a difference needs a real reason");
    }

    for case in &cases {
        let stated: Vec<Reading> = case.files.iter().map(stated).collect();
        let got = read(&case.diff);
        match DIFFERS.iter().find(|(name, _, _)| *name == case.name) {
            None => assert_eq!(got, stated, "{}", case.name),
            Some((name, _, answer)) => {
                assert_ne!(
                    got, stated,
                    "{name} is read as the fixtures state it: remove it from DIFFERS"
                );
                let mut answered = stated;
                answer(&mut answered);
                assert_eq!(got, answered, "{name}");
            }
        }
    }
}

/// Git quotes a control character in a name whatever `core.quotepath` says,
/// so these reach the scan in production.
#[test]
fn a_c_quoted_name_is_read_byte_for_byte() {
    let diff = "diff --git \"a/say \\\"hi\\\"\\r.txt\" \"b/say \\\"hi\\\"\\r.txt\"\n\
                --- \"a/say \\\"hi\\\"\\r.txt\"\n\
                +++ \"b/say \\\"hi\\\"\\r.txt\"\n\
                @@ -1 +1 @@\n-a\n+b\n";
    let files = parse_unified(diff.as_bytes());
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "say \"hi\"\r.txt");
}
