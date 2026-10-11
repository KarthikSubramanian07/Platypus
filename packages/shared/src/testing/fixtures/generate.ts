/**
 * `pnpm fixtures:golden-path`: runs the golden path against the fakes on a
 * manual clock (Sunday 7:00pm in San Francisco) and writes the event log to
 * golden-path.jsonl. Deterministic apart from ids and short codes.
 */
import { writeFileSync } from "node:fs";
import { manualClock } from "../../clock";
import { openDb } from "../../db/index";
import { EventBus } from "../../events/bus";
import { exportJsonl, listEvents } from "../../events/log";
import { GOLDEN_PATH_FIXTURE } from "../replay";
import { runGoldenPath } from "../scenario";

const db = openDb(":memory:");
const clock = manualClock("2026-10-12T02:00:00.000Z");
const result = await runGoldenPath({ db, clock, bus: new EventBus(), timeScale: 0 });
if (result.dial.toolErrors.length) throw new Error(`Tool errors: ${JSON.stringify(result.dial.toolErrors)}`);
const events = listEvents(db, { limit: 10_000 });
writeFileSync(GOLDEN_PATH_FIXTURE, exportJsonl(events));
console.log(`Wrote ${events.length} events. First booking ${result.first.short_code}: ${result.first.status}. Second ${result.second.short_code}: ${result.second.status}.`);
