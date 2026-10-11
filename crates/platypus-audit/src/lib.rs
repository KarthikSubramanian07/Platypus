//! A second, independent reading of the Platypus event-log auditor.
//!
//! `audit_event_log` replays the append-only log and checks rules R1 to R8, the
//! non-negotiables that can be judged from events alone. It mirrors
//! `packages/shared/src/audit/audit.ts` rule for rule: the same severities, the
//! same event each finding points at, the same `checked` counts and the same
//! stats. `pnpm ci:audit-diff` runs both on hundreds of logs and fails on any
//! disagreement, so a misreading in either one shows up as a diff.

// The replay mirrors audit.ts branch for branch, nested ifs and `!(a < b)` included, so the
// two stay easy to read side by side.
#![allow(clippy::collapsible_if, clippy::neg_cmp_op_on_partial_ord)]

pub mod js;
pub mod report;

use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

// ---- Constants copied from the TypeScript sources (the differential harness checks them) ----

/// packages/shared/src/testing/call-script.ts
pub const DISCLOSURE: &str =
    "Hi, this is an AI assistant calling on behalf of a customer's agent through Platypus.";
/// packages/shared/src/events/types.ts
pub const EVENT_ACTORS: [&str; 5] = ["agent", "owner", "autopilot", "voice", "system"];
/// packages/shared/src/db/types.ts
pub const BOOKING_STATUSES: [&str; 12] = [
    "quote_pending",
    "quoted",
    "pending",
    "countered",
    "confirmed",
    "rescheduled",
    "completed",
    "no_show",
    "disputed",
    "declined",
    "expired",
    "cancelled",
];
/// packages/shared/src/booking/machine.ts
pub const TRANSITIONS: [(&str, &[&str]); 12] = [
    (
        "quote_pending",
        &["quoted", "declined", "expired", "cancelled"],
    ),
    ("quoted", &["pending", "expired", "cancelled"]),
    (
        "pending",
        &["confirmed", "countered", "declined", "expired", "cancelled"],
    ),
    ("countered", &["confirmed", "cancelled", "expired"]),
    (
        "confirmed",
        &[
            "rescheduled",
            "cancelled",
            "completed",
            "no_show",
            "disputed",
        ],
    ),
    ("rescheduled", &["confirmed", "cancelled"]),
    ("completed", &[]),
    ("no_show", &[]),
    ("disputed", &[]),
    ("declined", &[]),
    ("expired", &[]),
    ("cancelled", &[]),
];
pub const OCCUPYING_STATUSES: [&str; 2] = ["confirmed", "rescheduled"];
// audit.ts
pub const DEFAULT_EXEMPT_KINDS: [&str; 3] = ["stop_confirmation", "stop", "help"];
pub const DEFAULT_DNC_CONFIDENCE: f64 = 0.9;
pub const TERMINAL_FOR_CONFIRM: [&str; 3] = ["declined", "cancelled", "expired"];
pub const SETTLED: [&str; 7] = [
    "confirmed",
    "completed",
    "no_show",
    "disputed",
    "declined",
    "expired",
    "cancelled",
];
/// Event types that record a state change and so must say why (the NEEDS_REASON regex, expanded).
pub const NEEDS_REASON: [&str; 23] = [
    "booking.quote_pending",
    "booking.quoted",
    "booking.pending",
    "booking.countered",
    "booking.confirmed",
    "booking.rescheduled",
    "booking.completed",
    "booking.no_show",
    "booking.disputed",
    "booking.declined",
    "booking.expired",
    "booking.cancelled",
    "booking.slot_agreed",
    "hold.placed",
    "hold.converted",
    "hold.released",
    "hold.expired",
    "consent.recorded",
    "consent.revoked",
    "business.channel_changed",
    "call.placed",
    "call.ended",
    "call.status_changed",
];
/// packages/shared/src/audit/rules.ts: id, title, non-negotiables.
pub const RULES: [(&str, &str, &[u32]); 8] = [
    ("R1", "A booking is confirmed only by the owner's yes", &[1]),
    ("R2", "Every call opens with the AI disclosure", &[2]),
    ("R3", "No message without consent", &[3]),
    (
        "R4",
        "One live call per business, no blind retries, do-not-call honored",
        &[4],
    ),
    (
        "R5",
        "Every event is well formed and every transition is legal",
        &[7],
    ),
    ("R6", "No sms to non-Dial numbers", &[8]),
    ("R7", "No double booking", &[1]),
    ("R8", "A transcript is never a confirmation", &[1]),
];

pub fn can_transition(from: &str, to: &str) -> bool {
    TRANSITIONS
        .iter()
        .any(|(f, tos)| *f == from && tos.contains(&to))
}

/// Every constant above as JSON, so the harness can diff them against the TypeScript ones.
pub fn constants_json() -> Value {
    json!({
        "disclosure": DISCLOSURE,
        "event_actors": EVENT_ACTORS,
        "booking_statuses": BOOKING_STATUSES,
        "transitions": TRANSITIONS.iter().map(|(f, t)| (f.to_string(), json!(t))).collect::<Map<String, Value>>(),
        "occupying_statuses": OCCUPYING_STATUSES,
        "default_exempt_kinds": DEFAULT_EXEMPT_KINDS,
        "default_dnc_confidence": DEFAULT_DNC_CONFIDENCE,
        "terminal_for_confirm": TERMINAL_FOR_CONFIRM,
        "settled": SETTLED,
        "needs_reason": NEEDS_REASON,
        "rules": RULES.iter().map(|(id, title, nn)| json!({"id": id, "title": title, "non_negotiables": nn})).collect::<Vec<_>>(),
    })
}

// ---- Result types ------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Violation {
    pub rule: &'static str,
    pub severity: Severity,
    pub event_id: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct RuleSummary {
    pub id: &'static str,
    pub title: &'static str,
    pub checked: u64,
    pub errors: u64,
    pub warnings: u64,
}

/// A string-keyed counter that keeps first-insertion order, like a JS object.
#[derive(Clone, Debug, Default)]
pub struct Counts(pub Vec<(String, u64)>);

impl Counts {
    fn inc(&mut self, k: &str) {
        match self.0.iter_mut().find(|(key, _)| key == k) {
            Some((_, v)) => *v += 1,
            None => self.0.push((k.to_string(), 1)),
        }
    }
    pub fn get(&self, k: &str) -> u64 {
        self.0
            .iter()
            .find(|(key, _)| key == k)
            .map_or(0, |(_, v)| *v)
    }
    fn to_json(&self) -> Value {
        Value::Object(self.0.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
    }
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub events: u64,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    pub events_by_actor: Counts,
    pub bookings_total: u64,
    pub bookings_by_route: Counts,
    pub bookings_by_status: Counts,
    pub bookings_confirmed_by: Counts,
    pub calls_placed: u64,
    pub calls_ended: u64,
    pub calls_transcribed: u64,
    pub calls_disclosure_verified: u64,
    pub calls_disclosure_missing: u64,
    pub calls_live_at_end: u64,
    pub calls_tool_calls: u64,
    pub holds_placed: u64,
    pub holds_converted: u64,
    pub holds_released: u64,
    pub holds_expired: u64,
    pub holds_active_at_end: u64,
    pub consents_recorded: u64,
    pub consents_revoked: u64,
    pub consents_active_at_end: u64,
    pub messages_sent: u64,
    pub messages_received: u64,
    pub messages_not_sent: u64,
    pub messages_by_channel: Counts,
    pub owner_reply_median: Option<f64>,
    pub owner_reply_samples: u64,
}

#[derive(Clone, Debug)]
pub struct AuditResult {
    pub ok: bool,
    pub violations: Vec<Violation>,
    pub rules: Vec<RuleSummary>,
    pub stats: Stats,
}

impl AuditResult {
    /// The same shape as the TypeScript `AuditResult`.
    pub fn to_json(&self) -> Value {
        let s = &self.stats;
        json!({
            "ok": self.ok,
            "violations": self.violations.iter().map(|v| json!({
                "rule": v.rule, "severity": v.severity.as_str(), "event_id": v.event_id, "message": v.message,
            })).collect::<Vec<_>>(),
            "rules": self.rules.iter().map(|r| json!({
                "id": r.id, "title": r.title, "checked": r.checked, "errors": r.errors, "warnings": r.warnings,
            })).collect::<Vec<_>>(),
            "stats": {
                "events": s.events,
                "first_at": s.first_at,
                "last_at": s.last_at,
                "events_by_actor": s.events_by_actor.to_json(),
                "bookings": {
                    "total": s.bookings_total,
                    "by_route": s.bookings_by_route.to_json(),
                    "by_status": s.bookings_by_status.to_json(),
                    "confirmed_by": s.bookings_confirmed_by.to_json(),
                },
                "calls": {
                    "placed": s.calls_placed, "ended": s.calls_ended, "transcribed": s.calls_transcribed,
                    "disclosure_verified": s.calls_disclosure_verified, "disclosure_missing": s.calls_disclosure_missing,
                    "live_at_end": s.calls_live_at_end, "tool_calls": s.calls_tool_calls,
                },
                "holds": {
                    "placed": s.holds_placed, "converted": s.holds_converted, "released": s.holds_released,
                    "expired": s.holds_expired, "active_at_end": s.holds_active_at_end,
                },
                "consents": { "recorded": s.consents_recorded, "revoked": s.consents_revoked, "active_at_end": s.consents_active_at_end },
                "messages": {
                    "sent": s.messages_sent, "received": s.messages_received, "not_sent": s.messages_not_sent,
                    "by_channel": s.messages_by_channel.to_json(),
                },
                "owner_reply_seconds": { "median": s.owner_reply_median, "samples": s.owner_reply_samples },
            },
        })
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    pub disclosure: String,
    pub dnc_confidence: f64,
    pub consent_exempt_kinds: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            disclosure: DISCLOSURE.to_string(),
            dnc_confidence: DEFAULT_DNC_CONFIDENCE,
            consent_exempt_kinds: DEFAULT_EXEMPT_KINDS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

// ---- Readers that never fail on a malformed event --------------------------------------------

fn field<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(k))
}

/// A non-empty string, or nothing.
fn str_of(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn ms(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::String(s)) => js::parse_date(s),
        _ => None,
    }
}

fn short(id: Option<&str>) -> String {
    match id {
        Some(id) if !id.is_empty() => {
            let units: Vec<u16> = id.encode_utf16().collect();
            if units.len() > 14 {
                format!(
                    "{}\u{2026}{}",
                    String::from_utf16_lossy(&units[..4]),
                    String::from_utf16_lossy(&units[units.len() - 6..])
                )
            } else {
                id.to_string()
            }
        }
        _ => "?".to_string(),
    }
}

/// A JSON value printed the way `String(v)` would, for messages only.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(Some(x))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

/// Lowercase words only, so punctuation and transcription case never matter.
pub fn words(s: &str) -> Vec<String> {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for c in lower.chars() {
        match c {
            '\'' | '\u{2019}' | '\u{2018}' => {}
            'a'..='z' | '0'..='9' | ' ' => out.push(c),
            _ => out.push(' '),
        }
    }
    out.split(' ')
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// The agent's opening: its first turn, joined with any agent turns before the other party speaks.
pub fn opening_starts_with_disclosure(
    turns: Option<&Value>,
    disclosure: &str,
) -> (bool, Option<String>) {
    let Some(Value::Array(turns)) = turns else {
        return (false, None);
    };
    let expected = words(disclosure);
    let is_agent =
        |t: &Value| t.is_object() && field(t, "speaker").and_then(Value::as_str) == Some("agent");
    let text_of = |t: &Value| {
        field(t, "text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let clipped = |t: &Value| {
        let w = words(&text_of(t));
        !w.is_empty()
            && w.len() < expected.len()
            && w.iter().enumerate().all(|(i, x)| expected[i] == *x)
    };
    let mut first = turns.iter().position(is_agent);
    while let Some(f) = first {
        if !clipped(&turns[f]) {
            break;
        }
        match turns
            .iter()
            .enumerate()
            .position(|(i, t)| i > f && is_agent(t))
        {
            Some(next) => first = Some(next),
            None => break,
        }
    }
    let Some(first) = first else {
        return (false, None);
    };
    let parts: Vec<String> = turns[first..]
        .iter()
        .take_while(|t| is_agent(t))
        .map(text_of)
        .collect();
    let opening = parts.join(" ");
    let said = words(&opening);
    let ok = expected
        .iter()
        .enumerate()
        .all(|(i, w)| said.get(i) == Some(w));
    (ok, Some(js::slice_utf16(&opening, 120)))
}

// ---- Replay state ------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Slot {
    start: f64,
    end: f64,
}

fn overlaps(a: Slot, b: Slot) -> bool {
    a.start < b.end && b.start < a.end
}

fn slot_of(p: &Value) -> Option<Slot> {
    match (ms(field(p, "slot_start")), ms(field(p, "slot_end"))) {
        (Some(start), Some(end)) => Some(Slot { start, end }),
        _ => None,
    }
}

struct Booking {
    id: String,
    business_id: Option<String>,
    status: String,
    route: Option<String>,
    slot: Option<Slot>,
    holds: HashSet<String>,
    slot_agreed: bool,
    slot_agreed_hold: Option<String>,
    ever_confirmed: bool,
    transcript_findings: u64,
    confirmed_by: Option<String>,
}

fn new_booking(
    id: &str,
    business_id: Option<String>,
    status: &str,
    route: Option<String>,
) -> Booking {
    Booking {
        id: id.to_string(),
        business_id,
        status: status.to_string(),
        route,
        slot: None,
        holds: HashSet::new(),
        slot_agreed: false,
        slot_agreed_hold: None,
        ever_confirmed: false,
        transcript_findings: 0,
        confirmed_by: None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HoldStatus {
    Active,
    Converted,
    Released,
    Expired,
}

impl HoldStatus {
    fn name(self) -> &'static str {
        match self {
            HoldStatus::Active => "active",
            HoldStatus::Converted => "converted",
            HoldStatus::Released => "released",
            HoldStatus::Expired => "expired",
        }
    }
}

struct Hold {
    id: String,
    business_id: Option<String>,
    booking_id: Option<String>,
    slot: Option<Slot>,
    status: HoldStatus,
}

struct Transcript {
    ok: bool,
    opening: Option<String>,
    event_id: String,
}

struct Call {
    id: String,
    business_id: Option<String>,
    booking_id: Option<String>,
    checked_placement: bool,
    live: bool,
    ended: bool,
    transcript: Option<Transcript>,
    flagged_missing: bool,
    verified_event: Option<String>,
}

/// Insertion-ordered map, like a JS Map.
struct Ordered<V> {
    index: HashMap<String, usize>,
    items: Vec<V>,
}

impl<V> Ordered<V> {
    fn new() -> Self {
        Ordered {
            index: HashMap::new(),
            items: Vec::new(),
        }
    }
    fn get(&self, k: &str) -> Option<&V> {
        self.index.get(k).map(|&i| &self.items[i])
    }
    fn get_mut(&mut self, k: &str) -> Option<&mut V> {
        self.index.get(k).map(|&i| &mut self.items[i])
    }
    fn has(&self, k: &str) -> bool {
        self.index.contains_key(k)
    }
    /// Map.set: replaces in place, or appends.
    fn set(&mut self, k: &str, v: V) {
        match self.index.get(k) {
            Some(&i) => self.items[i] = v,
            None => {
                self.index.insert(k.to_string(), self.items.len());
                self.items.push(v);
            }
        }
    }
    fn len(&self) -> usize {
        self.items.len()
    }
}

struct Received {
    business_id: Option<String>,
    booking_id: Option<String>,
}

struct Consent {
    business_id: Option<String>,
    active: bool,
}

struct Auditor<'o> {
    opts: &'o Options,
    violations: Vec<Violation>,
    checked: [u64; 8],
    bookings: Ordered<Booking>,
    holds: Ordered<Hold>,
    calls: Ordered<Call>,
    calls_by_dial_id: HashMap<String, String>,
    live_call_by_business: HashMap<String, String>,
    unresolved_placement: HashMap<String, String>,
    do_not_call: HashMap<String, String>,
    consents: Ordered<Consent>,
    revoked_businesses: HashSet<String>,
    received: HashMap<String, Received>,
    reply_class: HashMap<String, String>,
    used_yes: HashMap<String, String>,
    stats: Stats,
    last_sent_at: HashMap<String, f64>,
    reply_seconds: Vec<f64>,
    previous_id: Option<String>,
    seen_ids: HashSet<String>,
}

fn rule_index(rule: &str) -> usize {
    RULES
        .iter()
        .position(|(id, _, _)| *id == rule)
        .expect("known rule")
}

impl Auditor<'_> {
    fn fail(&mut self, rule: &'static str, event_id: Option<&str>, message: String) {
        self.fail_as(rule, event_id, message, Severity::Error);
    }
    fn warn(&mut self, rule: &'static str, event_id: Option<&str>, message: String) {
        self.fail_as(rule, event_id, message, Severity::Warning);
    }
    fn fail_as(
        &mut self,
        rule: &'static str,
        event_id: Option<&str>,
        message: String,
        severity: Severity,
    ) {
        self.violations.push(Violation {
            rule,
            severity,
            event_id: event_id.map(str::to_string),
            message,
        });
    }
    fn check(&mut self, rule: &str) {
        self.checked[rule_index(rule)] += 1;
    }

    /// calls.get(id) ?? callsByDialId.get(id): the call's own id.
    fn call_for(&self, id: Option<&str>) -> Option<String> {
        let id = id?;
        if self.calls.has(id) {
            return Some(id.to_string());
        }
        self.calls_by_dial_id.get(id).cloned()
    }

    fn ensure_call(
        &mut self,
        id: &str,
        business: &Option<String>,
        booking: &Option<String>,
    ) -> &mut Call {
        if !self.calls.has(id) {
            self.calls.set(
                id,
                Call {
                    id: id.to_string(),
                    business_id: business.clone(),
                    booking_id: booking.clone(),
                    checked_placement: false,
                    live: false,
                    ended: false,
                    transcript: None,
                    flagged_missing: false,
                    verified_event: None,
                },
            );
        }
        let c = self.calls.get_mut(id).unwrap();
        if c.business_id.is_none() {
            c.business_id = business.clone();
        }
        if c.booking_id.is_none() {
            c.booking_id = booking.clone();
        }
        c
    }

    fn check_slot_change(&mut self, booking: &str, id: Option<&str>, ty: &str) {
        let b = self.bookings.get(booking).unwrap();
        if SETTLED.contains(&b.status.as_str()) {
            let msg = format!(
                "{ty} changes the slot of booking {}, which is {}; its time and price may only change through a transition (rescheduled).",
                short(Some(&b.id)),
                b.status
            );
            self.fail("R5", id, msg);
        }
    }

    fn event(&mut self, e: &Value) {
        let id: Option<String> = field(e, "id").and_then(Value::as_str).map(str::to_string);
        let idr = id.as_deref();
        let ty: String = field(e, "type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let ty = ty.as_str();
        let empty = Value::Object(Map::new());
        let refs = field(e, "refs").filter(|v| v.is_object()).unwrap_or(&empty);
        let p = field(e, "payload")
            .filter(|v| v.is_object())
            .unwrap_or(&empty);
        let business_id = str_of(field(refs, "business_id"));
        let booking_id = str_of(field(refs, "booking_id"));
        let actor = field(e, "actor");
        let type_or = |d: &str| {
            if ty.is_empty() {
                d.to_string()
            } else {
                ty.to_string()
            }
        };

        // ---- R5: shape, actor, confidence, ids, reasons
        self.check("R5");
        match idr {
            None | Some("") => self.fail(
                "R5",
                None,
                format!("An event of type \"{}\" has no id.", type_or("?")),
            ),
            Some(i) => {
                // ids only ever grow, so the previous id is the greatest seen.
                let prev = self.previous_id.clone();
                if self.seen_ids.contains(i) {
                    self.fail(
                        "R5",
                        idr,
                        format!(
                            "Event id {i} appears twice; the log is append-only and ids are unique."
                        ),
                    );
                } else if let Some(prev) =
                    prev.filter(|p| js::cmp_utf16(i, p) != std::cmp::Ordering::Greater)
                {
                    self.fail("R5", idr, format!("Event id {i} is not greater than the previous id {prev}; ids must increase monotonically."));
                }
                self.seen_ids.insert(i.to_string());
                self.previous_id = Some(i.to_string());
            }
        }
        if ty.is_empty() {
            self.fail("R5", idr, "An event has no type.".into());
        }
        let actor_str = actor.and_then(Value::as_str);
        if !actor_str.is_some_and(|a| EVENT_ACTORS.contains(&a)) {
            self.fail(
                "R5",
                idr,
                format!(
                    "{} has actor \"{}\", which is not one of {}.",
                    type_or("Event"),
                    js_string(actor),
                    EVENT_ACTORS.join(", ")
                ),
            );
        }
        let conf = field(e, "confidence");
        let conf_ok = conf
            .and_then(Value::as_f64)
            .is_some_and(|c| (0.0..=1.0).contains(&c));
        if !conf_ok {
            self.fail(
                "R5",
                idr,
                format!(
                    "{} has confidence {}; it must be a number in [0, 1].",
                    type_or("Event"),
                    js_string(conf)
                ),
            );
        }
        if NEEDS_REASON.contains(&ty) {
            let has_reason =
                matches!(field(e, "reason"), Some(Value::String(r)) if !js::trim(r).is_empty());
            if !has_reason {
                self.fail(
                    "R5",
                    idr,
                    format!("{ty} changes state but records no reason."),
                );
            }
        }
        let at = ms(field(e, "created_at"));
        if at.is_none() {
            self.fail(
                "R5",
                idr,
                format!("{} has no valid created_at timestamp.", type_or("Event")),
            );
        } else {
            let created = field(e, "created_at")
                .and_then(Value::as_str)
                .map(str::to_string);
            if self.stats.first_at.is_none() {
                self.stats.first_at = created.clone();
            }
            self.stats.last_at = created;
        }
        if let Some(a) = actor_str {
            self.stats.events_by_actor.inc(a);
        }

        // ---- Bookings
        if let Some(sub) = ty.strip_prefix("booking.") {
            if BOOKING_STATUSES.contains(&sub) && booking_id.is_some() {
                self.booking_transition(
                    e,
                    idr,
                    ty,
                    sub,
                    p,
                    booking_id.as_deref().unwrap(),
                    &business_id,
                );
            } else if sub == "slot_agreed" && booking_id.is_some() {
                let bk = booking_id.as_deref().unwrap();
                if !self.bookings.has(bk) {
                    self.bookings
                        .set(bk, new_booking(bk, business_id.clone(), "pending", None));
                }
                self.check_slot_change(bk, idr, ty);
                let b = self.bookings.get_mut(bk).unwrap();
                b.slot_agreed = true;
                b.slot_agreed_hold = str_of(field(refs, "hold_id"));
                if let Some(s) = slot_of(p) {
                    b.slot = Some(s);
                }
            } else if sub == "transcript_candidate" && booking_id.is_some() {
                if let Some(b) = self.bookings.get_mut(booking_id.as_deref().unwrap()) {
                    b.transcript_findings += 1;
                }
            } else if sub == "route_changed" && booking_id.is_some() {
                if let (Some(b), Some(to)) = (
                    self.bookings.get_mut(booking_id.as_deref().unwrap()),
                    str_of(field(p, "to")),
                ) {
                    b.route = Some(to);
                }
            }
        }

        // ---- Holds (R7)
        let hold_id = str_of(field(refs, "hold_id"));
        if let (Some(h_id), true) = (hold_id.as_deref(), ty == "hold.placed") {
            self.stats.holds_placed += 1;
            self.check("R7");
            let slot = slot_of(p);
            match slot {
                None => self.fail(
                    "R7",
                    idr,
                    format!(
                        "hold.placed {} has no readable slot_start/slot_end.",
                        short(Some(h_id))
                    ),
                ),
                Some(s) if !(s.start < s.end) => self.fail(
                    "R7",
                    idr,
                    format!("hold.placed {} ends before it starts.", short(Some(h_id))),
                ),
                _ => {}
            }
            if self.holds.has(h_id) {
                self.fail(
                    "R7",
                    idr,
                    format!("Hold {} was placed twice.", short(Some(h_id))),
                );
            }
            if let (Some(s), Some(biz)) = (slot, business_id.as_deref()) {
                let mut found = Vec::new();
                for h in &self.holds.items {
                    if h.id != h_id
                        && h.status == HoldStatus::Active
                        && h.business_id.as_deref() == Some(biz)
                        && h.slot.is_some_and(|hs| overlaps(hs, s))
                    {
                        found.push(format!(
                            "Hold {} overlaps active hold {} for the same business.",
                            short(Some(h_id)),
                            short(Some(&h.id))
                        ));
                    }
                }
                for b in &self.bookings.items {
                    if Some(b.id.as_str()) == booking_id.as_deref()
                        || b.business_id.as_deref() != Some(biz)
                    {
                        continue;
                    }
                    let Some(bs) = b.slot else { continue };
                    if OCCUPYING_STATUSES.contains(&b.status.as_str()) && overlaps(bs, s) {
                        found.push(format!(
                            "Hold {} overlaps confirmed booking {} of the same business.",
                            short(Some(h_id)),
                            short(Some(&b.id))
                        ));
                    }
                }
                for m in found {
                    self.fail("R7", idr, m);
                }
            }
            self.holds.set(
                h_id,
                Hold {
                    id: h_id.to_string(),
                    business_id: business_id.clone(),
                    booking_id: booking_id.clone(),
                    slot,
                    status: HoldStatus::Active,
                },
            );
            if let Some(bk) = booking_id.as_deref() {
                if self.bookings.has(bk) {
                    self.check_slot_change(bk, idr, ty);
                    let b = self.bookings.get_mut(bk).unwrap();
                    b.holds.insert(h_id.to_string());
                    if let Some(s) = slot {
                        b.slot = Some(s);
                    }
                }
            }
        } else if let (Some(h_id), Some(next)) = (
            hold_id.as_deref(),
            match ty {
                "hold.converted" => Some(HoldStatus::Converted),
                "hold.released" => Some(HoldStatus::Released),
                "hold.expired" => Some(HoldStatus::Expired),
                _ => None,
            },
        ) {
            match next {
                HoldStatus::Converted => self.stats.holds_converted += 1,
                HoldStatus::Released => self.stats.holds_released += 1,
                _ => self.stats.holds_expired += 1,
            }
            if let Some(prev) = self.holds.get(h_id).map(|h| h.status) {
                if prev != HoldStatus::Active {
                    self.fail(
                        "R7",
                        idr,
                        format!(
                            "Hold {} became {}, but it was already {}.",
                            short(Some(h_id)),
                            next.name(),
                            prev.name()
                        ),
                    );
                }
                let h = self.holds.get_mut(h_id).unwrap();
                h.status = next;
                if booking_id.is_some() && h.booking_id.is_none() {
                    h.booking_id = booking_id.clone();
                }
            }
            if let Some(b) = booking_id
                .as_deref()
                .and_then(|bk| self.bookings.get_mut(bk))
            {
                b.holds.insert(h_id.to_string());
            }
        }

        // ---- Calls (R2, R4)
        let call_id = str_of(field(refs, "call_id"));
        let cid = call_id.as_deref();
        if ty == "call.placing" || ty == "call.placed" {
            if let Some(cid) = cid {
                let dial = str_of(field(p, "dial_call_id"));
                self.ensure_call(cid, &business_id, &booking_id);
                if let Some(d) = dial {
                    self.calls_by_dial_id.insert(d, cid.to_string());
                }
                let c = self.calls.get(cid).unwrap();
                if !c.checked_placement && c.business_id.is_some() {
                    let biz = c.business_id.clone().unwrap();
                    self.calls.get_mut(cid).unwrap().checked_placement = true;
                    self.check("R4");
                    if let Some(dnc) = self
                        .do_not_call
                        .get(&biz)
                        .filter(|d| !d.is_empty())
                        .cloned()
                    {
                        self.fail(
                            "R4",
                            idr,
                            format!("A call to business {} was placed after the owner asked not to be called ({}).", short(Some(&biz)), short(Some(&dnc))),
                        );
                    }
                    if let Some(live) = self
                        .live_call_by_business
                        .get(&biz)
                        .filter(|l| l.as_str() != cid)
                        .cloned()
                    {
                        self.fail("R4", idr, format!("Call {} was placed while call {} to the same business was still live.", short(Some(cid)), short(Some(&live))));
                    }
                    if let Some(unknown) = self
                        .unresolved_placement
                        .get(&biz)
                        .filter(|u| u.as_str() != cid)
                        .cloned()
                    {
                        self.fail(
                            "R4",
                            idr,
                            format!(
                                "Call {} was attempted while the placement of call {} was still unknown: a blind retry. List calls and reconcile first.",
                                short(Some(cid)),
                                short(Some(&unknown))
                            ),
                        );
                    }
                }
                if ty == "call.placed" {
                    self.stats.calls_placed += 1;
                    let c = self.calls.get_mut(cid).unwrap();
                    c.live = true;
                    if let Some(biz) = c.business_id.clone() {
                        self.live_call_by_business.insert(biz, cid.to_string());
                    }
                }
            }
        } else if let (Some(cid), "call.placement_unknown") = (cid, ty) {
            let c = self.ensure_call(cid, &business_id, &booking_id);
            if let Some(biz) = c.business_id.clone() {
                self.unresolved_placement.insert(biz, cid.to_string());
            }
        } else if let (Some(cid), "call.placement_reconciled") = (cid, ty) {
            let c = self.ensure_call(cid, &business_id, &booking_id);
            if let Some(biz) = c.business_id.clone() {
                if self.unresolved_placement.get(&biz).map(String::as_str) == Some(cid) {
                    self.unresolved_placement.remove(&biz);
                }
            }
            if let Some(d) = str_of(field(p, "dial_call_id")) {
                self.calls_by_dial_id.insert(d, cid.to_string());
            }
        } else if let (Some(cid), "call.ended") = (cid, ty) {
            self.stats.calls_ended += 1;
            let c = self.ensure_call(cid, &business_id, &booking_id);
            c.live = false;
            c.ended = true;
            if let Some(biz) = c.business_id.clone() {
                if self.live_call_by_business.get(&biz).map(String::as_str) == Some(cid) {
                    self.live_call_by_business.remove(&biz);
                }
            }
        } else if let (Some(cid), "call.transcribed") = (cid, ty) {
            self.stats.calls_transcribed += 1;
            let disclosure = self.opts.disclosure.clone();
            let c = self.ensure_call(cid, &business_id, &booking_id);
            let (ok, opening) = opening_starts_with_disclosure(field(p, "turns"), &disclosure);
            c.transcript = Some(Transcript {
                ok,
                opening,
                event_id: idr.unwrap_or("").to_string(),
            });
        } else if let (Some(cid), "call.disclosure_missing") = (cid, ty) {
            self.stats.calls_disclosure_missing += 1;
            self.ensure_call(cid, &business_id, &booking_id)
                .flagged_missing = true;
        } else if let (Some(cid), "call.disclosure_verified") = (cid, ty) {
            self.stats.calls_disclosure_verified += 1;
            self.ensure_call(cid, &business_id, &booking_id)
                .verified_event = id.clone();
        } else if let (Some(biz), "call.do_not_call") = (business_id.as_deref(), ty) {
            if js::to_number_or_zero(conf) >= self.opts.dnc_confidence {
                self.do_not_call
                    .insert(biz.to_string(), idr.unwrap_or("").to_string());
            }
        } else if ty == "voice.tool_called" {
            self.stats.calls_tool_calls += 1;
        } else if ty == "transcript.mined" {
            let bid = booking_id.clone().or_else(|| {
                self.call_for(cid)
                    .and_then(|c| self.calls.get(&c).unwrap().booking_id.clone())
            });
            if let Some(b) = bid.and_then(|bid| self.bookings.get_mut(&bid)) {
                b.transcript_findings += 1;
            }
        }

        // ---- Consent and messages (R3, R6)
        let consent_id = str_of(field(refs, "consent_id"));
        match ty {
            "consent.recorded" => {
                self.stats.consents_recorded += 1;
                if let Some(c) = consent_id {
                    self.consents.set(
                        &c,
                        Consent {
                            business_id: business_id.clone(),
                            active: true,
                        },
                    );
                } else if business_id.is_some() {
                    let key = format!("anon:{}", idr.unwrap_or("null"));
                    self.consents.set(
                        &key,
                        Consent {
                            business_id: business_id.clone(),
                            active: true,
                        },
                    );
                }
            }
            "consent.revoked" => {
                self.stats.consents_revoked += 1;
                if let Some(b) = &business_id {
                    self.revoked_businesses.insert(b.clone());
                }
                if let Some(c) = consent_id.as_deref().and_then(|c| self.consents.get_mut(c)) {
                    c.active = false;
                } else if business_id.is_some() {
                    for x in self.consents.items.iter_mut() {
                        if x.business_id == business_id {
                            x.active = false;
                        }
                    }
                }
            }
            "message.received" => {
                self.stats.messages_received += 1;
                if let Some(mid) = str_of(field(refs, "message_id")) {
                    self.received.insert(
                        mid,
                        Received {
                            business_id: business_id.clone(),
                            booking_id: booking_id.clone(),
                        },
                    );
                }
                if let (Some(biz), Some(at), Some("owner")) =
                    (business_id.as_deref(), at, actor_str)
                {
                    if let Some(&sent_at) = self.last_sent_at.get(biz) {
                        if at >= sent_at {
                            self.reply_seconds.push((at - sent_at) / 1000.0);
                            self.last_sent_at.remove(biz);
                        }
                    }
                }
            }
            "reply.classified" => {
                if let (Some(mid), Some(cls)) =
                    (str_of(field(refs, "message_id")), str_of(field(p, "class")))
                {
                    self.reply_class.insert(mid, cls);
                }
            }
            "message.not_sent" => self.stats.messages_not_sent += 1,
            "message.sent" => {
                self.stats.messages_sent += 1;
                let channel = str_of(field(p, "channel")).unwrap_or_else(|| "unknown".into());
                self.stats.messages_by_channel.inc(&channel);
                let kind = str_of(field(p, "kind"));
                let kind_name = kind.clone().unwrap_or_else(|| "message".into());

                self.check("R3");
                match business_id.as_deref() {
                    None => self.warn(
                        "R3",
                        idr,
                        "message.sent names no business, so its consent cannot be checked.".into(),
                    ),
                    Some(biz) => {
                        let active = self
                            .consents
                            .items
                            .iter()
                            .any(|c| c.active && c.business_id.as_deref() == Some(biz));
                        if !active {
                            if kind
                                .as_ref()
                                .is_some_and(|k| self.opts.consent_exempt_kinds.contains(k))
                            {
                                // The one-time STOP confirmation and HELP replies are allowed without consent.
                            } else if self.revoked_businesses.contains(biz) {
                                self.fail(
                                    "R3",
                                    idr,
                                    format!(
                                        "A {kind_name} text went to business {} after it revoked consent; only STOP and HELP confirmations may follow a revocation.",
                                        short(Some(biz))
                                    ),
                                );
                            } else {
                                self.fail("R3", idr, format!("A {kind_name} text went to business {}, which never consented to texts.", short(Some(biz))));
                            }
                        }
                    }
                }

                self.check("R6");
                if channel == "sms" && field(p, "dial_to_dial") != Some(&Value::Bool(true)) {
                    self.fail(
                        "R6",
                        idr,
                        format!(
                            "A text went out over sms to business {} without the dial_to_dial flag; sms to non-Dial numbers needs 10DLC.",
                            short(business_id.as_deref())
                        ),
                    );
                }
                if let (Some(biz), Some(at)) = (business_id, at) {
                    self.last_sent_at.insert(biz, at);
                }
            }
            _ => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn booking_transition(
        &mut self,
        e: &Value,
        idr: Option<&str>,
        ty: &str,
        to: &str,
        p: &Value,
        bk: &str,
        business_id: &Option<String>,
    ) {
        let from = str_of(field(p, "from"));
        let mut r1_flagged = false;
        if to == "confirmed" {
            r1_flagged = self.check_confirmation(e, idr, p, bk);
        }
        let exists = self.bookings.has(bk);
        match from.as_deref() {
            None => {
                if let Some(b) = self.bookings.get(bk) {
                    let msg = format!(
                        "{ty} re-creates booking {}, which already exists ({}).",
                        short(Some(bk)),
                        b.status
                    );
                    self.fail("R5", idr, msg);
                } else if to != "pending" && to != "quote_pending" {
                    self.fail(
                        "R5",
                        idr,
                        format!("Booking {} first appears as {to} with no \"from\" status; bookings start as pending or quote_pending.", short(Some(bk))),
                    );
                }
                if !exists {
                    self.bookings.set(
                        bk,
                        new_booking(bk, business_id.clone(), to, str_of(field(p, "route"))),
                    );
                }
            }
            Some(from) if !exists => {
                let known = BOOKING_STATUSES.contains(&from);
                self.bookings.set(
                    bk,
                    new_booking(
                        bk,
                        business_id.clone(),
                        if known { from } else { "pending" },
                        None,
                    ),
                );
                if !known {
                    self.fail(
                        "R5",
                        idr,
                        format!(
                            "{ty} says it moved from \"{from}\", which is not a booking status."
                        ),
                    );
                } else if !can_transition(from, to) && !r1_flagged {
                    self.fail("R5", idr, format!("Booking {} moved {from} \u{2192} {to}, which the state machine does not allow.", short(Some(bk))));
                }
            }
            Some(from) => {
                let status = self.bookings.get(bk).unwrap().status.clone();
                if from != status {
                    self.fail("R5", idr, format!("{ty} says booking {} moved from {from}, but the log has it at {status}.", short(Some(bk))));
                }
                if !can_transition(&status, to) && !r1_flagged {
                    self.fail("R5", idr, format!("Booking {} moved {status} \u{2192} {to}, which the state machine does not allow.", short(Some(bk))));
                }
            }
        }
        if to == "confirmed" {
            let ev = field(p, "evidence")
                .filter(|v| v.is_object())
                .and_then(|ev| str_of(field(ev, "kind")));
            let b = self.bookings.get_mut(bk).unwrap();
            b.ever_confirmed = true;
            b.confirmed_by = Some(ev.unwrap_or_else(|| "none".into()));
            // A confirmed booking occupies its slot: it may not overlap another one (R7).
            if let (Some(slot), Some(biz)) = (b.slot, b.business_id.clone()) {
                self.check("R7");
                let mut found = Vec::new();
                for other in &self.bookings.items {
                    if other.id == bk || other.business_id.as_deref() != Some(biz.as_str()) {
                        continue;
                    }
                    let Some(os) = other.slot else { continue };
                    if OCCUPYING_STATUSES.contains(&other.status.as_str()) && overlaps(os, slot) {
                        found.push(format!(
                            "Booking {} was confirmed for a slot that overlaps confirmed booking {} of the same business (double booking).",
                            short(Some(bk)),
                            short(Some(&other.id))
                        ));
                    }
                }
                for m in found {
                    self.fail("R7", idr, m);
                }
            }
        }
        self.bookings.get_mut(bk).unwrap().status = to.to_string();
    }

    /// Returns true when it reported the confirmation as illegal, so R5 does not report it twice.
    fn check_confirmation(&mut self, e: &Value, idr: Option<&str>, p: &Value, bk_id: &str) -> bool {
        self.check("R1");
        let bk = short(Some(bk_id));
        let mut illegal = false;
        let (b_exists, ever_confirmed, status, findings, slot_agreed, b_business, held) =
            match self.bookings.get(bk_id) {
                Some(b) => {
                    let held = b.holds.iter().any(|h| self.holds.has(h))
                        || b.slot_agreed_hold
                            .as_deref()
                            .is_some_and(|h| self.holds.has(h));
                    (
                        true,
                        b.ever_confirmed,
                        b.status.clone(),
                        b.transcript_findings,
                        b.slot_agreed,
                        b.business_id.clone(),
                        held,
                    )
                }
                None => (false, false, String::new(), 0, false, None, false),
            };
        if b_exists && ever_confirmed && status != "rescheduled" {
            self.fail("R1", idr, format!("Booking {bk} was confirmed twice."));
            illegal = true;
        }
        if b_exists && TERMINAL_FOR_CONFIRM.contains(&status.as_str()) {
            self.fail(
                "R1",
                idr,
                format!("Booking {bk} was confirmed after it was {status}."),
            );
            illegal = true;
        }

        let evidence = field(p, "evidence").filter(|v| v.is_object());
        let transcript_shaped = evidence.is_some_and(|ev| {
            field(ev, "kind").and_then(Value::as_str) == Some("transcript")
                || field(ev, "source").and_then(Value::as_str) == Some("transcript")
                || ev.as_object().unwrap().contains_key("transcript_turn")
        });
        if b_exists && (findings > 0 || transcript_shaped) {
            self.check("R8");
        }
        if transcript_shaped {
            self.fail("R8", idr, format!("Booking {bk} was confirmed with evidence taken from the transcript; a transcript is never a confirmation."));
        }
        let Some(evidence) = evidence else {
            self.fail(
                "R1",
                idr,
                format!("Booking {bk} was confirmed with no evidence of the owner's yes."),
            );
            return illegal;
        };
        let kind = field(evidence, "kind");
        let actor = field(e, "actor");
        let actor_is = |a: &str| actor.and_then(Value::as_str) == Some(a);
        let refs = field(e, "refs");
        let business_id = b_business.or_else(|| refs.and_then(|r| str_of(field(r, "business_id"))));
        let target = refs.and_then(|r| str_of(field(r, "booking_id")));

        match kind.and_then(Value::as_str) {
            Some("call") => {
                if !actor_is("voice") {
                    self.fail("R1", idr, format!("Booking {bk} has call evidence but was confirmed by actor \"{}\", not the voice tools.", js_string(actor)));
                }
                if !str_of(field(evidence, "quotedSentence"))
                    .is_some_and(|q| !js::trim(&q).is_empty())
                {
                    self.fail(
                        "R1",
                        idr,
                        format!(
                            "Booking {bk} was confirmed on a call without quoting the owner's yes."
                        ),
                    );
                }
                let cited = str_of(field(evidence, "callId"));
                match self.call_for(cited.as_deref()) {
                    None => self.fail(
                        "R1",
                        idr,
                        format!(
                            "Booking {bk} cites call {}, which never appears in the log.",
                            short(cited.as_deref())
                        ),
                    ),
                    Some(c) => {
                        let call = self.calls.get(&c).unwrap();
                        let (call_biz, ended, call_name) =
                            (call.business_id.clone(), call.ended, call.id.clone());
                        if let (Some(cb), Some(bb)) = (&call_biz, &business_id) {
                            if cb != bb {
                                self.fail(
                                    "R1",
                                    idr,
                                    format!("Booking {bk} cites a call with a different business."),
                                );
                            }
                        }
                        if ended {
                            self.fail(
                                "R1",
                                idr,
                                format!(
                                    "Booking {bk} was confirmed after call {} had ended; call confirmations happen mid-call through the tools.",
                                    short(Some(&call_name))
                                ),
                            );
                        }
                    }
                }
                let tools_booked = slot_agreed;
                if !tools_booked {
                    self.fail("R1", idr, format!("Booking {bk} was confirmed on a call, but no booking.slot_agreed shows it was booked through the tools."));
                }
                if !held {
                    self.fail("R1", idr, format!("Booking {bk} was confirmed on a call, but no hold.placed was ever recorded for it."));
                }
                if b_exists && findings > 0 && !(tools_booked && held) {
                    self.fail(
                        "R8",
                        idr,
                        format!("Booking {bk} was confirmed from the call transcript alone: it has transcript findings but was never booked through the tools."),
                    );
                }
            }
            Some("text") => {
                if !actor_is("owner") {
                    self.fail("R1", idr, format!("Booking {bk} has text evidence but was confirmed by actor \"{}\", not the owner.", js_string(actor)));
                }
                let mid = str_of(field(evidence, "messageId"));
                let msg = mid
                    .as_deref()
                    .and_then(|m| self.received.get(m))
                    .map(|m| (m.business_id.clone(), m.booking_id.clone()));
                match msg {
                    None => self.fail("R1", idr, format!("Booking {bk} cites message {}, but no message.received with that id came before.", short(mid.as_deref()))),
                    Some((msg_biz, about)) => {
                        let mid = mid.unwrap();
                        if let (Some(mb), Some(bb)) = (&msg_biz, &business_id) {
                            if mb != bb {
                                self.fail("R1", idr, format!("Booking {bk} was confirmed by a text from a different business."));
                            }
                        }
                        let cls = self.reply_class.get(&mid).cloned();
                        if cls.as_deref() != Some("accept") {
                            let c = cls.map_or("nothing yet".to_string(), |c| format!("\"{c}\""));
                            self.fail("R1", idr, format!("Booking {bk} was confirmed by a text classified {c}, not accept."));
                        }
                        if let (Some(about), Some(target)) = (&about, &target) {
                            if about != target {
                                self.fail("R1", idr, format!("Booking {bk} was confirmed by the owner's reply about booking {}.", short(Some(about))));
                            }
                        }
                        if let (Some(earlier), Some(target)) = (self.used_yes.get(&mid).cloned(), &target) {
                            if &earlier != target {
                                self.fail(
                                    "R1",
                                    idr,
                                    format!("Booking {bk} was confirmed by the same yes that already confirmed booking {}; one yes confirms one booking.", short(Some(&earlier))),
                                );
                            }
                        }
                        if let Some(target) = target {
                            self.used_yes.insert(mid, target);
                        }
                    }
                }
            }
            Some("rule") => {
                if !actor_is("autopilot") {
                    self.fail("R1", idr, format!("Booking {bk} has rule evidence but was confirmed by actor \"{}\", not autopilot.", js_string(actor)));
                }
                if str_of(field(evidence, "ruleId")).is_none() {
                    self.fail(
                        "R1",
                        idr,
                        format!("Booking {bk} cites rule evidence without a rule id."),
                    );
                }
            }
            _ => {
                self.fail(
                    "R1",
                    idr,
                    format!("Booking {bk} was confirmed with evidence of kind \"{}\"; only call, text and rule are accepted.", js_string(kind)),
                );
            }
        }
        illegal
    }
}

impl Auditor<'_> {
    fn finish(mut self) -> AuditResult {
        // ---- R2, judged at the end: the disclosure check events follow the transcript
        let mut found: Vec<(Severity, Option<String>, String)> = Vec::new();
        let mut r2_checked = 0;
        for c in &self.calls.items {
            let Some(t) = &c.transcript else {
                if c.flagged_missing {
                    found.push((
                        Severity::Warning,
                        None,
                        format!(
                            "Call {} was flagged call.disclosure_missing.",
                            short(Some(&c.id))
                        ),
                    ));
                }
                continue;
            };
            r2_checked += 1;
            if t.ok {
                continue;
            }
            let said = t
                .opening
                .as_ref()
                .map_or("no agent turn at all".to_string(), |o| format!("\"{o}\""));
            let name = short(Some(&c.id));
            match c.verified_event.as_deref() {
                Some(v) if !v.is_empty() => {
                    found.push((Severity::Error, Some(v.to_string()), format!("Call {name} was marked disclosure_verified, but the agent opened with {said}.")))
                }
                _ if c.flagged_missing => found.push((
                    Severity::Warning,
                    Some(t.event_id.clone()),
                    format!("Call {name} opened without the disclosure ({said}); it was flagged call.disclosure_missing."),
                )),
                _ => found.push((Severity::Error, Some(t.event_id.clone()), format!("Call {name} opened with {said} instead of the disclosure, and nothing flagged it."))),
            }
        }
        self.checked[rule_index("R2")] += r2_checked;
        for (sev, ev, msg) in found {
            self.fail_as("R2", ev.as_deref(), msg, sev);
        }

        // ---- Stats
        let s = &mut self.stats;
        s.bookings_total = self.bookings.len() as u64;
        for b in &self.bookings.items {
            s.bookings_by_status.inc(&b.status);
            s.bookings_by_route
                .inc(b.route.as_deref().unwrap_or("unrouted"));
            if let Some(by) = &b.confirmed_by {
                s.bookings_confirmed_by.inc(by);
            }
        }
        s.calls_live_at_end = self.calls.items.iter().filter(|c| c.live).count() as u64;
        s.holds_active_at_end = self
            .holds
            .items
            .iter()
            .filter(|h| h.status == HoldStatus::Active)
            .count() as u64;
        s.consents_active_at_end = self.consents.items.iter().filter(|c| c.active).count() as u64;
        s.owner_reply_samples = self.reply_seconds.len() as u64;
        s.owner_reply_median = median(&self.reply_seconds);

        let rules = RULES
            .iter()
            .enumerate()
            .map(|(i, (id, title, _))| RuleSummary {
                id,
                title,
                checked: self.checked[i],
                errors: self
                    .violations
                    .iter()
                    .filter(|v| v.rule == *id && v.severity == Severity::Error)
                    .count() as u64,
                warnings: self
                    .violations
                    .iter()
                    .filter(|v| v.rule == *id && v.severity == Severity::Warning)
                    .count() as u64,
            })
            .collect();
        let ok = !self
            .violations
            .iter()
            .any(|v| v.severity == Severity::Error);
        AuditResult {
            ok,
            violations: self.violations,
            rules,
            stats: self.stats,
        }
    }
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = sorted.len() / 2;
    Some(if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    })
}

/// Replays the log and checks R1 to R8. Never panics on a malformed event.
pub fn audit_event_log(events: &[Value], opts: &Options) -> AuditResult {
    let mut a = Auditor {
        opts,
        violations: Vec::new(),
        checked: [0; 8],
        bookings: Ordered::new(),
        holds: Ordered::new(),
        calls: Ordered::new(),
        calls_by_dial_id: HashMap::new(),
        live_call_by_business: HashMap::new(),
        unresolved_placement: HashMap::new(),
        do_not_call: HashMap::new(),
        consents: Ordered::new(),
        revoked_businesses: HashSet::new(),
        received: HashMap::new(),
        reply_class: HashMap::new(),
        used_yes: HashMap::new(),
        stats: Stats {
            events: events.len() as u64,
            ..Stats::default()
        },
        last_sent_at: HashMap::new(),
        reply_seconds: Vec::new(),
        previous_id: None,
        seen_ids: HashSet::new(),
    };
    for e in events {
        a.event(e);
    }
    a.finish()
}

/// `parseJsonl`: one JSON value per non-blank line.
pub fn parse_jsonl(text: &str) -> Result<Vec<Value>, String> {
    text.split('\n')
        .map(js::trim)
        .enumerate()
        .filter(|(_, l)| !l.is_empty())
        .map(|(i, l)| serde_json::from_str::<Value>(l).map_err(|e| format!("line {}: {e}", i + 1)))
        .collect()
}
