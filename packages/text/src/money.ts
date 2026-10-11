/**
 * Prices in owner replies, to integer cents: "$300", "300 bucks", "300 dollars",
 * "$1,310.50", "1.2k", "$1.2k". Spelled-out amounts ("eighty nine") are left to
 * the model layer; a bare number is never a price here because "3" is far more
 * often a time.
 */
export interface MoneyMatch {
  cents: number;
  /** The matched text, as written. */
  text: string;
  index: number;
}

const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const MONEY = new RegExp(
  String.raw`(?:\$\s?(${AMOUNT})(?:\s?(k)\b)?|\b(${AMOUNT})\s?(k)\b|\b(${AMOUNT})\s?(bucks|dollars|dollar|usd)\b)`,
  "gi",
);

function toCents(amount: string, thousands: boolean): number | null {
  const value = Number(amount.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * (thousands ? 1000 : 1) * 100);
  return cents >= 0 && cents <= 100_000_000 ? cents : null;
}

export function findMoney(text: string): MoneyMatch[] {
  const out: MoneyMatch[] = [];
  for (const m of text.matchAll(MONEY)) {
    const amount = m[1] ?? m[3] ?? m[5];
    if (!amount) continue;
    const cents = toCents(amount, Boolean(m[2] ?? m[4]));
    if (cents !== null) out.push({ cents, text: m[0], index: m.index ?? 0 });
  }
  return out;
}

/** The single price in a message, or null when there is none or more than one. */
export function parseMoney(text: string): MoneyMatch | null {
  const all = findMoney(text);
  return all.length === 1 ? all[0]! : null;
}

/** "$1,310.50" for display; whole dollars drop the cents ("$300"). */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
