//! The `name`/`description` frontmatter of a `SKILL.md`, parsed by hand.

// ── Frontmatter (minimal, no YAML crate — mirrors agent_memory.rs) ──────────────

#[derive(Default)]
pub(crate) struct Frontmatter {
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
}

/// Parse the leading `---` frontmatter block for `name`/`description`. Returns
/// the parsed scalars plus the body with the block stripped.
pub(crate) fn parse_frontmatter(raw: &str) -> (Frontmatter, String) {
    let mut fm = Frontmatter::default();
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return (fm, raw.to_string());
    }
    let Some(close) = lines.iter().skip(1).position(|l| l.trim_end() == "---") else {
        return (fm, raw.to_string()); // unterminated → all body
    };
    let close = close + 1; // un-skip

    for line in &lines[1..close] {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if let Some((k, v)) = line.trim().split_once(':') {
            let key = k.trim();
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match key {
                "name" if !indented => fm.name = Some(val),
                "description" if !indented => fm.description = Some(val),
                _ => {}
            }
        }
    }

    let body = lines[close + 1..].join("\n");
    let body = body.trim_start_matches(['\n', '\r']).to_string();
    (fm, body)
}
