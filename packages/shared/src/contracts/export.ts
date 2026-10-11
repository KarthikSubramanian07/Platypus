import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contractJsonSchemas } from "./json-schema";

export const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../schemas");

mkdirSync(SCHEMAS_DIR, { recursive: true });
for (const [file, schema] of Object.entries(contractJsonSchemas())) {
  writeFileSync(join(SCHEMAS_DIR, file), JSON.stringify(schema, null, 2) + "\n");
  console.log(`wrote schemas/${file}`);
}
