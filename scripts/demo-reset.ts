/**
 * `pnpm demo:reset`: a clean slate for a take. Replaces the database file (the event log is
 * append-only, so it is never edited), re-runs migrations and the seed, and leaves Sal's Auto
 * PHONE-ONLY with its real number from ALLOWED_NUMBERS[0].
 */
import { existsSync, rmSync } from "node:fs";
import { parseAllowedNumbers } from "../packages/shared/src/config";
import { describeSeed, openDb, seed } from "../packages/shared/src/db/index";
import { emitSeedEvents } from "../packages/shared/src/events/seed-events";

if (existsSync(".env")) process.loadEnvFile(".env");
const mode = process.env.DEMO_MODE ?? "fakes";
const dbPath = process.env.PLATYPUS_DB ?? (mode === "fakes" ? "data/dev-fakes.db" : "data/platypus.db");
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
const db = openDb(dbPath);
const allowedNumbers = parseAllowedNumbers(process.env.ALLOWED_NUMBERS);
const businesses = seed(db, { allowedNumbers, onSeeded: emitSeedEvents(db) });
db.close();
console.log(`Reset ${dbPath} (DEMO_MODE=${mode}).\n${describeSeed(businesses)}`);
if (!allowedNumbers.length) console.warn("ALLOWED_NUMBERS is empty: Sal's Auto has a fictional number and cannot be called.");
