//! The few JavaScript semantics the TypeScript auditor leans on, reproduced exactly
//! enough that both readings agree: whitespace trimming, string ordering, number
//! coercion for `>=`, and `Date.parse` for the timestamps the log carries.

use serde_json::Value;
use std::cmp::Ordering;

/// `String.prototype.trim`'s whitespace: WhiteSpace plus LineTerminator. Unlike
/// `char::is_whitespace` it includes U+FEFF and excludes U+0085.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// JavaScript compares strings by UTF-16 code units, not by UTF-8 bytes.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `x.slice(0, n)` on a string: the first n UTF-16 code units.
pub fn slice_utf16(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `Number(s)` for a string (StringToNumber).
pub fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return rest.chars().fold(0.0, |acc, c| {
                acc * radix as f64 + c.to_digit(radix).unwrap() as f64
            });
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrDecimalLiteral: digits [. digits] | . digits, then an optional exponent.
    let b = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - f;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    let text = if body.starts_with('.') {
        format!("0{body}")
    } else {
        body.to_string()
    };
    let text = text.replace(".e", ".0e").replace(".E", ".0E");
    sign * text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `(v ?? 0)` coerced to a number, as `>=` against a number does.
pub fn to_number_or_zero(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => 0.0,
        Some(v) => to_number(v),
    }
}

fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        // ToPrimitive on an array joins its elements with commas.
        Value::Array(a) => match a.as_slice() {
            [] => 0.0,
            [one] => match one {
                Value::Null => 0.0,
                Value::Object(_) => f64::NAN,
                other => to_number(other),
            },
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    // Howard Hinnant's algorithm, with the day allowed to run past the month end
    // (V8's legacy fallback rolls 2026-02-30 over to March 2).
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (d - 1)
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cursor<'_> {
    fn digits(&mut self, n: usize) -> Option<i64> {
        if self.i + n > self.b.len() {
            return None;
        }
        let mut v = 0i64;
        for k in 0..n {
            let c = self.b[self.i + k];
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + i64::from(c - b'0');
        }
        self.i += n;
        Some(v)
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn done(&self) -> bool {
        self.i == self.b.len()
    }
}

/// `Date.parse` for the ISO 8601 shapes V8 accepts (the only shapes Platypus
/// writes): `YYYY[-MM[-DD]]`, then optionally `T` or a space, `HH:mm[:ss[.fff]]`,
/// then `Z` or `+HH:mm` / `+HHmm`. A date-time with no offset is local time in
/// JavaScript; this reads it as UTC, so run the TypeScript side with TZ=UTC to compare.
/// Anything else (V8's free-form legacy formats) is treated as unparseable.
pub fn parse_date(s: &str) -> Option<f64> {
    let mut c = Cursor {
        b: s.as_bytes(),
        i: 0,
    };
    let year = match c.peek()? {
        sign @ (b'+' | b'-') => {
            c.i += 1;
            let y = c.digits(6)?;
            if sign == b'-' {
                if y == 0 {
                    return None;
                }
                -y
            } else {
                y
            }
        }
        _ => c.digits(4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if c.eat(b'-') {
        month = c.digits(2)?;
        if c.eat(b'-') {
            day = c.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut msec) = (0, 0, 0, 0);
    let mut offset_min = 0i64;
    if c.done() {
        // date only: UTC
    } else if matches!(c.peek(), Some(b'Z' | b'z')) {
        c.i += 1;
    } else {
        if !(c.eat(b'T') || c.eat(b't') || c.eat(b' ')) {
            return None;
        }
        h = c.digits(2)?;
        if !c.eat(b':') {
            return None;
        }
        mi = c.digits(2)?;
        if c.eat(b':') {
            sec = c.digits(2)?;
            if c.eat(b'.') {
                let start = c.i;
                while matches!(c.peek(), Some(b'0'..=b'9')) {
                    c.i += 1;
                }
                let frac = &s[start..c.i];
                if frac.is_empty() {
                    return None;
                }
                let three: String = frac.chars().chain("000".chars()).take(3).collect();
                msec = three.parse::<i64>().ok()?;
            }
        }
        match c.peek() {
            None => {}
            Some(b'Z' | b'z') => c.i += 1,
            Some(sign @ (b'+' | b'-')) => {
                c.i += 1;
                let oh = c.digits(2)?;
                c.eat(b':');
                let om = c.digits(2)?;
                if oh > 23 || om > 59 {
                    return None;
                }
                offset_min = (oh * 60 + om) * if sign == b'+' { 1 } else { -1 };
            }
            _ => return None,
        }
        if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi > 0 || sec > 0 || msec > 0)) {
            return None;
        }
    }
    if !c.done() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let t = ((days * 24 + h) * 60 + mi - offset_min) * 60_000 + sec * 1000 + msec;
    let t = t as f64;
    if t.abs() > 8.64e15 { None } else { Some(t) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_dates_v8_parses() {
        // Each expected value is what Node's Date.parse returned (TZ=UTC).
        let cases: &[(&str, Option<f64>)] = &[
            ("2026-02-30T00:00:00Z", Some(1772409600000.0)),
            ("2026-02-32T00:00:00Z", None),
            ("2026-13-01T00:00:00Z", None),
            ("2026-10-12T24:00:00Z", Some(1791849600000.0)),
            ("2026-10-12T24:00:01Z", None),
            ("2026-10-12T23:60:00Z", None),
            ("2026-10-12 02:00:00Z", Some(1791770400000.0)),
            ("2026-10-12T02:00Z", Some(1791770400000.0)),
            ("2026-10-12T02Z", None),
            ("2026-10-12T02:00:00.1234567Z", Some(1791770400123.0)),
            ("2026-10-12T02:00:00.Z", None),
            ("2026-10-12T02:00:00+05:30", Some(1791750600000.0)),
            ("2026-10-12T02:00:00+0530", Some(1791750600000.0)),
            ("2026-10-12Z", Some(1791763200000.0)),
            ("2026", Some(1767225600000.0)),
            ("2026-10", Some(1790812800000.0)),
            ("+002026-10-12T00:00:00Z", Some(1791763200000.0)),
            ("-000000-01-01T00:00:00Z", None),
            ("2026-10-12T02:00:00", Some(1791770400000.0)),
            ("2026-10-12t02:00:00z", Some(1791770400000.0)),
            ("not-a-date", None),
            ("", None),
            ("2026-1-12T00:00:00Z", None),
            ("20261012", None),
            ("2026-10-12T02:00:00.000ZZ", None),
            (" 2026-10-12T02:00:00Z", None),
        ];
        for (s, want) in cases {
            assert_eq!(parse_date(s), *want, "{s}");
        }
    }

    #[test]
    fn coerces_like_javascript() {
        assert_eq!(string_to_number(" 0.95 "), 0.95);
        assert_eq!(string_to_number(""), 0.0);
        assert!(string_to_number("inf").is_nan());
        assert_eq!(string_to_number("0x10"), 16.0);
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert_eq!(to_number_or_zero(Some(&Value::Bool(true))), 1.0);
        assert_eq!(to_number_or_zero(None), 0.0);
        assert_eq!(cmp_utf16("\u{FFFF}", "\u{10000}"), Ordering::Greater);
        assert_eq!(trim("\u{FEFF} x \u{85}"), "x \u{85}");
    }
}
