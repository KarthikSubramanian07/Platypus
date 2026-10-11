/**
 * `pnpm dial:owner-sim`: gives the demo owner's Dial number (DIAL_OWNER_LINE_ID) the Demo
 * Script's owner lines, so a rehearsal call is answered by Dial's voice agent playing Eddy at
 * Sal's Auto, briefly, with no people involved. It changes only that number's inbound
 * instruction; it places no call and sends no message. `--show` prints the current one.
 */
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const apiKey = process.env.DIAL_API_KEY?.trim();
const id = process.env.DIAL_OWNER_LINE_ID?.trim();
if (!apiKey || !id) {
  console.error("Needs DIAL_API_KEY and DIAL_OWNER_LINE_ID in .env");
  process.exit(2);
}

export const OWNER_INSTRUCTION = `You are Eddy, the owner of Sal's Auto, answering the shop phone between jobs. You are busy and friendly. Every reply is one short sentence, under six words. Never ask questions. Never give price ranges, never mention tax, and never ask for the customer's name, number or details.

When you pick up, say only: "Sal's Auto, this is Eddy."
If they ask "Is this Sal's Auto?": say "It is."
If they ask for an opening and the price: say "Two o'clock works. Eighty-nine bucks."
If they repeat a time and price back to you: say "Yep."
If they ask you to confirm the car, or ask to book it: say "Yep, booked."
If they ask whether they can text you instead of calling: say "Yeah, text me."
If they ask for the best cell to text: say "This one."
If they thank you or say goodbye: say "Thanks, bye."
If you did not catch something: say "Sorry, say again?"`;

const url = `https://api.getdial.ai/api/v1/numbers/${encodeURIComponent(id)}`;
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

if (process.argv.includes("--show")) {
  const res = await fetch(url, { headers });
  const body = (await res.json()) as { number?: { inboundInstruction?: string | null } };
  console.log(body.number?.inboundInstruction ?? `(no inbound instruction; HTTP ${res.status})`);
} else {
  const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ inboundInstruction: OWNER_INSTRUCTION, inboundLanguage: "en-US" }) });
  if (!res.ok) {
    console.error(`Dial answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`Updated the demo owner's inbound instruction (${OWNER_INSTRUCTION.length} characters).`);
}
