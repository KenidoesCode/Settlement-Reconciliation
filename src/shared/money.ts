/**
 * Money is integer minor units, everywhere, with no exceptions.
 *
 * A reconciliation system that holds amounts as floats will eventually decide
 * that 1234.56 and 1234.5599999999999 are different payments, and the person who
 * has to explain that to a controller will not enjoy it.
 */
export function inr(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return sign + "₹" + Math.trunc(abs / 100).toLocaleString("en-IN") + "." + String(abs % 100).padStart(2, "0");
}

export function inrCompact(minor: number): string {
  const abs = Math.abs(Math.trunc(minor / 100));
  const sign = minor < 0 ? "-" : "";
  if (abs >= 10_000_000) return sign + "₹" + (abs / 10_000_000).toFixed(2) + " Cr";
  if (abs >= 100_000) return sign + "₹" + (abs / 100_000).toFixed(2) + " L";
  if (abs >= 1_000) return sign + "₹" + (abs / 1_000).toFixed(1) + "k";
  return sign + "₹" + abs.toString();
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}
