// EV age in a request — how long since the card's EV was last set — pulled out before anything else reads numbers:
//   "ev 14 days or higher", "ev 14 days or older", "14+ days", "older than 30 days", "ev age 14", "at least 14 days old"
//   "ev under 7 days", "newer than 7 days", "within 3 days"
const D = "(\\d+)\\s*\\+?\\s*(?:days?|d)\\b(?:\\s*old)?";
export function readEvAge(text: string): { minDays: number | null; maxDays: number | null; rest: string } {
  let t = " " + text + " ";
  let minDays: number | null = null, maxDays: number | null = null;
  const take = (re: RegExp, f: (m: RegExpMatchArray) => void) => { const m = t.match(re); if (m) { f(m); t = t.replace(m[0], " "); } };
  take(new RegExp(`\\b(?:ev\\s*(?:age\\s*)?)?(?:under|less than|newer than|younger than|within|max(?:imum)?|<=?)\\s*${D}`, "i"), (m) => { maxDays = Number(m[1]); });
  take(new RegExp(`\\b(?:ev\\s*(?:age\\s*)?)?(?:over|more than|older than|at least|min(?:imum)?|>=?)\\s*${D}`, "i"), (m) => { minDays = Number(m[1]); });
  if (minDays == null) take(new RegExp(`\\b(?:ev\\s*(?:age\\s*)?(?:is\\s*)?)?${D}(?:\\s*(?:or|and)\\s*(?:older|more|higher|longer|over|up|above|greater))?`, "i"), (m) => { minDays = Number(m[1]); });
  if (minDays == null && maxDays == null) take(/\bev\s*age\s*(\d+)\b/i, (m) => { minDays = Number(m[1]); });
  return { minDays, maxDays, rest: t.replace(/^ | $/g, "").trim() };
}
