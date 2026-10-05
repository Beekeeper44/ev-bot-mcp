// EV range typed in a request, in any of the usual ways — pulled out before searching:
//   "5000 or more ev", "$5k+", "ev 5000+", "over $5,000", "at least 5000", "5000 and up"
//   "under $100", "less than 250", "between $1,000 and $5,000", "$500-$999", "1k to 5k ev"
// Also a lone 4-digit year ("2020 basketball") — returned so results can be held to that year.
const N = "\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k)?";
const V = (n: string, k?: string) => Number(n.replace(/,/g, "")) * (k ? 1000 : 1);
const EVW = "(?:\\s*(?:ev|value|estimated value|estimate)s?)?";

export function readEvRange(text: string): { min: number | null; max: number | null; year: string | null; rest: string } {
  let t = " " + text + " ";
  let min: number | null = null, max: number | null = null;
  const take = (re: RegExp, f: (m: RegExpMatchArray) => void) => { const m = t.match(re); if (m) { f(m); t = t.replace(m[0], " "); } };
  take(new RegExp(`\\b(?:ev\\s*|value\\s*)?between\\s*${N}\\s*(?:and|to|-|–)\\s*${N}${EVW}`, "i"), (m) => { min = V(m[1], m[2]); max = V(m[3], m[4]); });
  if (min == null) take(new RegExp(`(?:^|\\s)(?:ev\\s*|value\\s*)?\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k)?\\s*(?:-|–|to)\\s*\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k)?${EVW}`, "i"), (m) => { min = V(m[1], m[2]); max = V(m[3], m[4]); });
  if (min == null) take(new RegExp(`(?:^|\\s)${N}\\s*(?:to|-|–)\\s*${N}\\s*(?:ev|value)s?(?=\\s|$)`, "i"), (m) => { min = V(m[1], m[2]); max = V(m[3], m[4]); });
  if (min == null) take(new RegExp(`(?:^|\\s)(?:ev\\s*|value\\s*)?${N}\\s*(?:\\+|or more|or greater|or higher|or above|and up|and above|plus)${EVW}(?=\\s|$)`, "i"), (m) => { min = V(m[1], m[2]); });
  if (min == null) take(new RegExp(`\\b(?:ev\\s*|value\\s*)?(?:over|above|more than|greater than|at least|min(?:imum)?|>=?)\\s*${N}${EVW}`, "i"), (m) => { min = V(m[1], m[2]); });
  if (max == null) take(new RegExp(`\\b(?:ev\\s*|value\\s*)?(?:under|below|less than|at most|max(?:imum)?|up to|<=?)\\s*${N}${EVW}`, "i"), (m) => { max = V(m[1], m[2]); });
  const y = t.match(/(?:^|\s)((?:19|20)\d\d)(?=\s|$)/);
  return { min, max, year: y ? y[1] : null, rest: t.replace(/^ | $/g, "").trim() };
}
