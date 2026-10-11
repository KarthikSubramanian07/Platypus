//! `platypus-audit <file.jsonl | -> [--json] [--no-color]`
//!
//! Exit 0 when every rule holds, 1 on any violation, 2 when the log cannot be read.
//! `--print-constants` dumps the constants copied from the TypeScript sources, so the
//! differential harness can check they have not drifted.

use platypus_audit::{
    Options, audit_event_log, constants_json, parse_jsonl, report::format_report,
};
use std::io::{IsTerminal, Read};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--print-constants") {
        println!(
            "{}",
            serde_json::to_string_pretty(&constants_json()).expect("constants serialize")
        );
        return ExitCode::SUCCESS;
    }
    let json = args.iter().any(|a| a == "--json");
    let color = !args.iter().any(|a| a == "--no-color")
        && std::io::stdout().is_terminal()
        && std::env::var_os("NO_COLOR").is_none();
    let Some(source) = args.iter().find(|a| *a == "-" || !a.starts_with("--")) else {
        eprintln!("usage: platypus-audit <file.jsonl | -> [--json] [--no-color]");
        return ExitCode::from(2);
    };

    let text = if source == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map(|_| s)
    } else {
        std::fs::read_to_string(source)
    };
    let text = match text {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Could not read the event log from {source}: {e}");
            return ExitCode::from(2);
        }
    };
    let events = match parse_jsonl(&text) {
        Ok(ev) => ev,
        Err(e) => {
            eprintln!("{source} is not valid JSONL: {e}");
            return ExitCode::from(2);
        }
    };

    let result = audit_event_log(&events, &Options::default());
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&result.to_json()).expect("result serializes")
        );
    } else {
        println!("{}", format_report(&result, Some(source), color, 10));
    }
    if result.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
