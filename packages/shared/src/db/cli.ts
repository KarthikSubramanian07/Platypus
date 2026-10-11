/**
 * `pnpm db:migrate` and `pnpm db:seed`. Reads ALLOWED_NUMBERS from .env so the
 * demo shop's real number never has to be typed into a file in the repo.
 */
import { existsSync } from "node:fs";
import { parseAllowedNumbers } from "../config";
import { describeSeed, migrate, openDb, seed } from "./index";

if (existsSync(".env")) process.loadEnvFile(".env");

const command = process.argv[2];
const db = openDb();

if (command === "migrate") {
  const ran = migrate(db);
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
} else if (command === "seed") {
  const allowedNumbers = parseAllowedNumbers(process.env.ALLOWED_NUMBERS);
  if (allowedNumbers.length === 0) {
    console.warn("ALLOWED_NUMBERS is empty: Sal's Auto gets a fictional 555 number and cannot be called.");
  }
  const businesses = seed(db, { allowedNumbers });
  console.log(describeSeed(businesses));
} else {
  console.error("Usage: tsx packages/shared/src/db/cli.ts <migrate|seed>");
  process.exit(1);
}
db.close();
