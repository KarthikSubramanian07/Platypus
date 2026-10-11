//! The plain-text report, a port of packages/shared/src/audit/report.ts.

use crate::{AuditResult, Counts, RULES, Severity};

fn paint(on: bool, code: &str, s: &str) -> String {
    if on {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

fn pairs(m: &Counts) -> String {
    let mut v: Vec<&(String, u64)> = m.0.iter().collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.1));
    if v.is_empty() {
        return "none".into();
    }
    v.iter()
        .map(|(k, n)| format!("{k} {n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// One line per rule (a check mark or a cross), the violations under it, then the stats.
pub fn format_report(
    result: &AuditResult,
    source: Option<&str>,
    color: bool,
    max_per_rule: usize,
) -> String {
    let green = |s: &str| paint(color, "32", s);
    let red = |s: &str| paint(color, "31", s);
    let yellow = |s: &str| paint(color, "33", s);
    let dim = |s: &str| paint(color, "2", s);
    let bold = |s: &str| paint(color, "1", s);
    let st = &result.stats;
    let mut lines: Vec<String> = Vec::new();
    let span = match (&st.first_at, &st.last_at) {
        (Some(a), Some(b)) => format!(" from {a} to {b}"),
        _ => String::new(),
    };
    lines.push(bold(&format!(
        "Platypus event-log audit (Rust){}",
        source.map(|s| format!(": {s}")).unwrap_or_default()
    )));
    lines.push(dim(&format!("{} events{span}", st.events)));
    lines.push(String::new());

    for rule in &result.rules {
        let mark = if rule.errors > 0 {
            red("\u{2717}")
        } else if rule.warnings > 0 {
            yellow("!")
        } else {
            green("\u{2713}")
        };
        let nn = RULES
            .iter()
            .find(|r| r.0 == rule.id)
            .map(|r| {
                r.2.iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let tally = if rule.errors > 0 {
            red(&plural(rule.errors, "violation", "violations"))
        } else if rule.warnings > 0 {
            yellow(&plural(rule.warnings, "warning", "warnings"))
        } else {
            dim(&format!("{} checked", rule.checked))
        };
        lines.push(format!(
            "{mark} {}  {} {}  {tally}",
            rule.id,
            rule.title,
            dim(&format!("(non-negotiable {nn})"))
        ));
        let found: Vec<_> = result
            .violations
            .iter()
            .filter(|v| v.rule == rule.id)
            .collect();
        for v in found.iter().take(max_per_rule) {
            let tag = if v.severity == Severity::Error {
                red("error  ")
            } else {
                yellow("warning")
            };
            let at = v
                .event_id
                .as_ref()
                .filter(|e| !e.is_empty())
                .map(|e| dim(&format!(" [{e}]")))
                .unwrap_or_default();
            lines.push(format!("    {tag} {}{at}", v.message));
        }
        if found.len() > max_per_rule {
            lines.push(dim(&format!(
                "    ...and {} more",
                found.len() - max_per_rule
            )));
        }
    }

    lines.push(String::new());
    lines.push(bold("Stats"));
    lines.push(format!(
        "  bookings  {} total; by status: {}; by route: {}; confirmed by: {}",
        st.bookings_total,
        pairs(&st.bookings_by_status),
        pairs(&st.bookings_by_route),
        pairs(&st.bookings_confirmed_by)
    ));
    lines.push(format!(
        "  calls     {} placed, {} ended, {} transcribed, {} disclosure verified, {} disclosure missing, {} tool calls",
        st.calls_placed, st.calls_ended, st.calls_transcribed, st.calls_disclosure_verified, st.calls_disclosure_missing, st.calls_tool_calls
    ));
    lines.push(format!(
        "  holds     {} placed, {} converted, {} released, {} expired, {} active now",
        st.holds_placed,
        st.holds_converted,
        st.holds_released,
        st.holds_expired,
        st.holds_active_at_end
    ));
    lines.push(format!(
        "  consents  {} recorded, {} revoked, {} active now",
        st.consents_recorded, st.consents_revoked, st.consents_active_at_end
    ));
    lines.push(format!(
        "  messages  {} sent ({}), {} received, {} held back",
        st.messages_sent,
        pairs(&st.messages_by_channel),
        st.messages_received,
        st.messages_not_sent
    ));
    let reply = match st.owner_reply_median {
        None => "no replies yet".to_string(),
        Some(m) => format!(
            "median {m:.1}s over {}",
            plural(st.owner_reply_samples, "reply", "replies")
        ),
    };
    lines.push(format!("  owner reply time  {reply}"));
    lines.push(String::new());
    let errors = result
        .violations
        .iter()
        .filter(|v| v.severity == Severity::Error)
        .count() as u64;
    let warnings = result.violations.len() as u64 - errors;
    lines.push(if result.ok {
        let w = if warnings > 0 {
            format!(" ({})", plural(warnings, "warning", "warnings"))
        } else {
            String::new()
        };
        green(&format!("All {} rules hold{w}.", result.rules.len()))
    } else {
        let failing = result.rules.iter().filter(|r| r.errors > 0).count();
        red(&format!(
            "{} across {failing} rule(s).",
            plural(errors, "violation", "violations")
        ))
    });
    lines.join("\n")
}
