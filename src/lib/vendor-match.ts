export function normalizeVendor(desc: string): string {
  return desc.toUpperCase().trim()
    .replace(/\*\s*[A-Z0-9-]+$/, '')
    .replace(/\s+#?\d{4,}$/, '')
    .replace(/\s+[A-Z]{2}$/, '')
    .replace(/\s+[A-Z0-9]{8,}$/, '')
    .trim();
}

/** A bill's vendor_alias may list alternatives separated by `|` ("GOOGLE ONE|GOOGLE *G1"). */
export function aliasParts(alias: string): string[] {
  return alias.split('|').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Does a card description belong to this bill alias?
 *
 * Matches against the raw description, not normalizeVendor(): normalization strips
 * trailing "*SUFFIX" segments, and for processor-prefixed descriptors the suffix IS
 * the vendor ("HLU*HULUPLUS" → "HLU"). Normalized text is a prefix of the raw text,
 * so raw matching only ever adds hits.
 */
export function matchesAlias(description: string, alias: string): boolean {
  const desc = description.toUpperCase();
  return aliasParts(alias).some(a => desc.includes(a));
}

export interface SubCandidate {
  date:        string;
  description: string;
  amount:      number; // Plaid convention: positive = charge, negative = refund
}

export interface SubMatch {
  date:        string;
  description: string;
  amount:      number;
  count:       number; // charges folded into `amount` (>1 when the cycle's net total won)
}

/** Relative distance from target a pick may sit when the cycle has several candidates. */
const MULTI_MATCH_TOLERANCE = 0.25;

/**
 * Choose the cycle's charge for a subscription, anchored on its configured monthly
 * target — never on a previously recorded amount, which would let one bad pick
 * steer every later one toward the same wrong charge.
 *
 * - One charge: taken as-is, whatever its amount (utilities swing month to month).
 * - Several: the closest single charge competes with the cycle's net total (charges
 *   minus refunds), so split billing (Google One's 1.37 + 2.12 + 2.12) sums while a
 *   shared alias (APPLE.COM/BILL, TESLA superchargers) still picks one. If the winner
 *   is not within tolerance of the target, the match is ambiguous and returns null.
 */
export function pickSubCharge(candidates: SubCandidate[], target: number): SubMatch | null {
  const charges = candidates.filter(c => c.amount > 0);
  if (!charges.length) return null;
  const round = (n: number) => Number(n.toFixed(2));

  if (charges.length === 1) {
    const c = charges[0]!;
    return { date: c.date, description: c.description, amount: round(c.amount), count: 1 };
  }

  const best = charges.reduce((a, b) =>
    Math.abs(a.amount - target) <= Math.abs(b.amount - target) ? a : b
  );
  const net = candidates.reduce((s, c) => s + c.amount, 0);
  const useNet = Math.abs(net - target) < Math.abs(best.amount - target);
  const amount = useNet ? net : best.amount;

  if (Math.abs(amount - target) > Math.max(target * MULTI_MATCH_TOLERANCE, 1)) return null;

  if (!useNet) return { date: best.date, description: best.description, amount: round(amount), count: 1 };
  const latest = charges.reduce((a, b) => (a.date >= b.date ? a : b));
  return { date: latest.date, description: latest.description, amount: round(amount), count: charges.length };
}
