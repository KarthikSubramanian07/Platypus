//! One passing and at least one failing log per rule, built the way audit.test.ts builds them.

use platypus_audit::{AuditResult, DISCLOSURE, Options, Severity, audit_event_log, parse_jsonl};
use serde_json::{Value, json};

const BIZ: &str = "biz_SAL";
const BIZ2: &str = "biz_MIRA";

fn slot() -> Value {
    json!({ "slot_start": "2026-10-13T21:00:00.000Z", "slot_end": "2026-10-13T21:45:00.000Z" })
}
fn later() -> Value {
    json!({ "slot_start": "2026-10-13T23:00:00.000Z", "slot_end": "2026-10-13T23:45:00.000Z" })
}
fn good_turns() -> Value {
    json!([
        { "speaker": "user", "text": "Sal's Auto?" },
        { "speaker": "agent", "text": format!("{DISCLOSURE} Is this Sal's Auto?") },
        { "speaker": "user", "text": "Yep." },
    ])
}

#[derive(Default)]
struct Log {
    events: Vec<Value>,
}

impl Log {
    fn add(&mut self, ty: &str, actor: &str, refs: Value, payload: Value) -> &mut Value {
        let n = self.events.len() + 1;
        self.events.push(json!({
            "id": format!("evt_{n:06}"),
            "type": ty,
            "actor": actor,
            "refs": refs,
            "payload": payload,
            "reason": format!("{ty} happened"),
            "confidence": 1,
            "created_at": format!("2026-10-12T02:{:02}:{:02}.000Z", n / 60, n % 60),
        }));
        self.events.last_mut().unwrap()
    }
    fn audit(&self) -> AuditResult {
        audit_event_log(&self.events, &Options::default())
    }
}

fn call_booking(l: &mut Log, booking: &str, call: &str, hold: &str, end: bool) {
    let r = |extra: Value| {
        let mut base = json!({ "booking_id": booking, "business_id": BIZ });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    };
    l.add(
        "booking.pending",
        "agent",
        r(json!({})),
        json!({ "route": "call" }),
    );
    l.add(
        "call.placed",
        "system",
        r(json!({ "call_id": call })),
        json!({ "dial_call_id": format!("dial_{call}") }),
    );
    l.add(
        "hold.placed",
        "voice",
        r(json!({ "hold_id": hold })),
        slot(),
    );
    l.add(
        "booking.slot_agreed",
        "voice",
        r(json!({ "hold_id": hold })),
        slot(),
    );
    l.add(
        "hold.converted",
        "voice",
        r(json!({ "hold_id": hold })),
        json!({}),
    );
    l.add(
        "booking.confirmed",
        "voice",
        r(json!({})),
        json!({ "from": "pending", "to": "confirmed", "evidence": { "kind": "call", "callId": call, "quotedSentence": "Yep, booked." } }),
    );
    l.add(
        "consent.recorded",
        "voice",
        json!({ "business_id": BIZ, "call_id": call, "consent_id": format!("cns_{call}") }),
        json!({}),
    );
    if end {
        l.add(
            "call.ended",
            "system",
            r(json!({ "call_id": call })),
            json!({}),
        );
        l.add(
            "call.transcribed",
            "system",
            r(json!({ "call_id": call })),
            json!({ "turns": good_turns() }),
        );
    }
}

fn text_booking(l: &mut Log, booking: &str, msg: &str, cls: &str) {
    let r = |extra: Value| {
        let mut base = json!({ "booking_id": booking, "business_id": BIZ });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    };
    l.add(
        "booking.pending",
        "agent",
        r(json!({})),
        json!({ "route": "text" }),
    );
    l.add(
        "hold.placed",
        "system",
        r(json!({ "hold_id": format!("hld_{booking}") })),
        later(),
    );
    l.add(
        "message.sent",
        "system",
        r(json!({})),
        json!({ "channel": "imessage", "kind": "booking_request" }),
    );
    l.add(
        "message.received",
        "owner",
        r(json!({ "message_id": msg })),
        json!({ "body": "Y" }),
    );
    l.add(
        "reply.classified",
        "system",
        r(json!({ "message_id": msg })),
        json!({ "class": cls }),
    );
    l.add(
        "booking.confirmed",
        "owner",
        r(json!({})),
        json!({ "from": "pending", "evidence": { "kind": "text", "messageId": msg } }),
    );
}

fn errors(r: &AuditResult, rule: &str) -> usize {
    r.violations
        .iter()
        .filter(|v| v.rule == rule && v.severity == Severity::Error)
        .count()
}
fn warnings(r: &AuditResult, rule: &str) -> usize {
    r.violations
        .iter()
        .filter(|v| v.rule == rule && v.severity == Severity::Warning)
        .count()
}

#[test]
fn golden_path_fixture_passes_every_rule() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/testing/fixtures/golden-path.jsonl"
    );
    let events = parse_jsonl(&std::fs::read_to_string(path).unwrap()).unwrap();
    let r = audit_event_log(&events, &Options::default());
    assert!(r.ok, "{:?}", r.violations);
    assert!(r.violations.is_empty());
    assert_eq!(r.stats.bookings_total, 2);
    assert_eq!(r.stats.owner_reply_samples, 1);
}

#[test]
fn journey_passes_and_empty_log_passes() {
    let mut l = Log::default();
    call_booking(&mut l, "bkg_1", "call_1", "hld_1", true);
    text_booking(&mut l, "bkg_2", "msg_1", "accept");
    let r = l.audit();
    assert!(r.ok, "{:?}", r.violations);
    assert!(audit_event_log(&[], &Options::default()).ok);
    // Malformed events never panic.
    let junk = vec![json!(null), json!(5), json!("x"), json!([]), json!({})];
    assert!(!audit_event_log(&junk, &Options::default()).ok);
}

#[test]
fn r1_owner_yes() {
    let mut l = Log::default();
    l.add(
        "booking.pending",
        "agent",
        json!({ "booking_id": "b1", "business_id": BIZ }),
        json!({}),
    );
    l.add(
        "booking.confirmed",
        "voice",
        json!({ "booking_id": "b1", "business_id": BIZ }),
        json!({ "from": "pending" }),
    );
    assert_eq!(errors(&l.audit(), "R1"), 1);

    let mut l = Log::default();
    text_booking(&mut l, "b1", "m1", "decline");
    let r = l.audit();
    assert_eq!(errors(&r, "R1"), 1);
    let r1 = r.violations.iter().find(|v| v.rule == "R1").unwrap();
    assert_eq!(r1.event_id.as_deref(), Some("evt_000006"));

    let mut l = Log::default();
    call_booking(&mut l, "b1", "c1", "h1", false);
    l.add(
        "booking.rescheduled",
        "agent",
        json!({ "booking_id": "b1", "business_id": BIZ }),
        json!({ "from": "confirmed" }),
    );
    l.add(
        "booking.confirmed",
        "voice",
        json!({ "booking_id": "b1", "business_id": BIZ }),
        json!({ "from": "rescheduled", "evidence": { "kind": "call", "callId": "dial_c1", "quotedSentence": "yes" } }),
    );
    assert!(l.audit().ok, "{:?}", l.audit().violations);
}

#[test]
fn r2_disclosure() {
    let mut l = Log::default();
    l.add(
        "call.transcribed",
        "system",
        json!({ "call_id": "c1", "business_id": BIZ }),
        json!({ "turns": good_turns() }),
    );
    assert_eq!(l.audit().rules[1].checked, 1);
    assert!(l.audit().ok);

    let bad = json!({ "turns": [{ "speaker": "agent", "text": "Hey there" }] });
    let mut l = Log::default();
    l.add(
        "call.transcribed",
        "system",
        json!({ "call_id": "c1" }),
        bad.clone(),
    );
    assert_eq!(errors(&l.audit(), "R2"), 1);
    l.add(
        "call.disclosure_missing",
        "system",
        json!({ "call_id": "c1" }),
        json!({}),
    );
    let r = l.audit();
    assert!(r.ok);
    assert_eq!(warnings(&r, "R2"), 1);
    l.add(
        "call.disclosure_verified",
        "system",
        json!({ "call_id": "c1" }),
        json!({}),
    );
    let r = l.audit();
    assert_eq!(errors(&r, "R2"), 1);
    assert_eq!(r.violations[0].event_id.as_deref(), Some("evt_000003"));

    // A first attempt clipped by crosstalk still counts.
    let mut l = Log::default();
    l.add(
        "call.transcribed",
        "system",
        json!({ "call_id": "c1" }),
        json!({ "turns": [{ "speaker": "agent", "text": "Hi, this" }, { "speaker": "user", "text": "Hello?" }, { "speaker": "agent", "text": DISCLOSURE }] }),
    );
    assert!(l.audit().ok);
}

#[test]
fn r3_consent() {
    let mut l = Log::default();
    l.add(
        "message.sent",
        "system",
        json!({ "business_id": BIZ }),
        json!({ "channel": "imessage" }),
    );
    assert_eq!(errors(&l.audit(), "R3"), 1);

    let mut l = Log::default();
    l.add(
        "consent.recorded",
        "owner",
        json!({ "business_id": BIZ }),
        json!({}),
    );
    l.add(
        "message.sent",
        "system",
        json!({ "business_id": BIZ }),
        json!({ "channel": "imessage" }),
    );
    assert!(l.audit().ok);
    l.add(
        "consent.revoked",
        "owner",
        json!({ "business_id": BIZ }),
        json!({}),
    );
    l.add(
        "message.sent",
        "system",
        json!({ "business_id": BIZ }),
        json!({ "channel": "imessage", "kind": "stop_confirmation" }),
    );
    assert!(l.audit().ok);
    l.add(
        "message.sent",
        "system",
        json!({ "business_id": BIZ }),
        json!({ "channel": "imessage" }),
    );
    assert_eq!(errors(&l.audit(), "R3"), 1);
    l.add(
        "message.sent",
        "system",
        json!({ "business_id": BIZ2 }),
        json!({ "channel": "imessage" }),
    );
    assert_eq!(errors(&l.audit(), "R3"), 2);
}

#[test]
fn r4_one_live_call() {
    let mut l = Log::default();
    l.add(
        "call.placed",
        "system",
        json!({ "business_id": BIZ, "call_id": "c1" }),
        json!({}),
    );
    l.add(
        "call.ended",
        "system",
        json!({ "business_id": BIZ, "call_id": "c1" }),
        json!({}),
    );
    l.add(
        "call.placed",
        "system",
        json!({ "business_id": BIZ, "call_id": "c2" }),
        json!({}),
    );
    assert!(l.audit().ok);
    l.add(
        "call.placed",
        "system",
        json!({ "business_id": BIZ, "call_id": "c3" }),
        json!({}),
    );
    assert_eq!(errors(&l.audit(), "R4"), 1);

    let mut l = Log::default();
    l.add(
        "call.do_not_call",
        "voice",
        json!({ "business_id": BIZ }),
        json!({}),
    )["confidence"] = json!(0.5);
    l.add(
        "call.placed",
        "system",
        json!({ "business_id": BIZ, "call_id": "c1" }),
        json!({}),
    );
    assert!(l.audit().ok);
    l.add(
        "call.do_not_call",
        "voice",
        json!({ "business_id": BIZ }),
        json!({}),
    )["confidence"] = json!(0.9);
    l.add(
        "call.ended",
        "system",
        json!({ "business_id": BIZ, "call_id": "c1" }),
        json!({}),
    );
    l.add(
        "call.placed",
        "system",
        json!({ "business_id": BIZ, "call_id": "c2" }),
        json!({}),
    );
    assert_eq!(errors(&l.audit(), "R4"), 1);

    let mut l = Log::default();
    l.add(
        "call.placement_unknown",
        "system",
        json!({ "business_id": BIZ, "call_id": "c1" }),
        json!({}),
    );
    l.add(
        "call.placing",
        "system",
        json!({ "business_id": BIZ, "call_id": "c2" }),
        json!({}),
    );
    assert_eq!(errors(&l.audit(), "R4"), 1);
}

#[test]
fn r5_well_formed() {
    let mut l = Log::default();
    l.add("note.added", "system", json!({}), json!({}));
    assert!(l.audit().ok);
    l.add("note.added", "robot", json!({}), json!({}))["confidence"] = json!(1.5);
    l.add("hold.placed", "system", json!({}), json!({}))["reason"] = json!("  ");
    l.add("note.added", "system", json!({}), json!({}))["created_at"] = json!("yesterday");
    l.events.push(l.events[0].clone());
    let r = l.audit();
    assert_eq!(errors(&r, "R5"), 5);
    assert_eq!(r.rules[4].checked, 5);

    let mut l = Log::default();
    l.add(
        "booking.pending",
        "agent",
        json!({ "booking_id": "b1" }),
        json!({}),
    );
    l.add(
        "booking.completed",
        "agent",
        json!({ "booking_id": "b1" }),
        json!({ "from": "pending" }),
    );
    assert_eq!(errors(&l.audit(), "R5"), 1);
}

#[test]
fn r6_no_sms() {
    let mut l = Log::default();
    l.add(
        "consent.recorded",
        "owner",
        json!({ "business_id": BIZ }),
        json!({}),
    );
    l.add(
        "message.sent",
        "system",
        json!({ "business_id": BIZ }),
        json!({ "channel": "sms", "dial_to_dial": true }),
    );
    assert!(l.audit().ok);
    l.add(
        "message.sent",
        "system",
        json!({ "business_id": BIZ }),
        json!({ "channel": "sms" }),
    );
    assert_eq!(errors(&l.audit(), "R6"), 1);
}

#[test]
fn r7_no_double_booking() {
    let mut l = Log::default();
    l.add(
        "hold.placed",
        "system",
        json!({ "business_id": BIZ, "hold_id": "h1" }),
        slot(),
    );
    l.add(
        "hold.placed",
        "system",
        json!({ "business_id": BIZ, "hold_id": "h2" }),
        later(),
    );
    assert!(l.audit().ok);
    l.add(
        "hold.placed",
        "system",
        json!({ "business_id": BIZ, "hold_id": "h3" }),
        slot(),
    );
    assert_eq!(errors(&l.audit(), "R7"), 1);
    l.add(
        "hold.released",
        "system",
        json!({ "business_id": BIZ, "hold_id": "h1" }),
        json!({}),
    );
    l.add(
        "hold.released",
        "system",
        json!({ "business_id": BIZ, "hold_id": "h1" }),
        json!({}),
    );
    assert_eq!(errors(&l.audit(), "R7"), 2);

    let mut l = Log::default();
    call_booking(&mut l, "b1", "c1", "h1", true);
    call_booking(&mut l, "b2", "c2", "h2", true);
    let r = l.audit();
    assert_eq!(errors(&r, "R7"), 2, "{:?}", r.violations);
}

#[test]
fn r8_transcript_is_not_a_confirmation() {
    let mut l = Log::default();
    call_booking(&mut l, "b1", "c1", "h1", true);
    l.add(
        "transcript.mined",
        "system",
        json!({ "call_id": "c1" }),
        json!({}),
    );
    assert!(l.audit().ok);

    let mut l = Log::default();
    l.add(
        "booking.pending",
        "agent",
        json!({ "booking_id": "b1", "business_id": BIZ }),
        json!({}),
    );
    l.add(
        "call.placed",
        "system",
        json!({ "booking_id": "b1", "business_id": BIZ, "call_id": "c1" }),
        json!({}),
    );
    l.add(
        "booking.transcript_candidate",
        "system",
        json!({ "booking_id": "b1" }),
        json!({}),
    );
    l.add(
        "booking.confirmed",
        "voice",
        json!({ "booking_id": "b1", "business_id": BIZ }),
        json!({ "from": "pending", "evidence": { "kind": "call", "callId": "c1", "quotedSentence": "sure" } }),
    );
    assert_eq!(errors(&l.audit(), "R8"), 1);

    let mut l = Log::default();
    l.add(
        "booking.pending",
        "agent",
        json!({ "booking_id": "b1", "business_id": BIZ }),
        json!({}),
    );
    l.add(
        "booking.confirmed",
        "voice",
        json!({ "booking_id": "b1" }),
        json!({ "from": "pending", "evidence": { "kind": "transcript" } }),
    );
    let r = l.audit();
    assert_eq!(errors(&r, "R8"), 1);
    assert_eq!(r.rules[7].checked, 1);
}

#[test]
fn json_output_has_the_typescript_shape() {
    let mut l = Log::default();
    l.add(
        "message.sent",
        "system",
        json!({}),
        json!({ "channel": "sms" }),
    );
    let j = l.audit().to_json();
    assert_eq!(j["ok"], json!(false));
    assert_eq!(j["violations"][0]["rule"], json!("R3"));
    assert_eq!(j["violations"][0]["severity"], json!("warning"));
    assert_eq!(j["rules"].as_array().unwrap().len(), 8);
    assert_eq!(j["stats"]["messages"]["by_channel"]["sms"], json!(1));
    assert_eq!(j["stats"]["owner_reply_seconds"]["median"], Value::Null);
}
