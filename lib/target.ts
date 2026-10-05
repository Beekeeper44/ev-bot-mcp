// Pulls the new estimated value out of a typed request so the rest can be searched:
//   "ohtani #US189 base psa 10 to $300"      -> 300
//   "set ev 1.2k for wemby ruby wave psa 10" -> 1200
//   "wemby psa 10 over $200 ev = $450"       -> 450 (the "over $200" stays a search filter)
const NUM = "\\$?\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*(k)?";
const RANGE = new RegExp("between\\s*\\$?\\s*[\\d,.]+\\s*k?\\s*(?:and|to|-|–)\\s*\\$?\\s*[\\d,.]+\\s*k?|\\$\\s*[\\d,.]+\\s*k?\\s*(?:-|–|to)\\s*\\$\\s*[\\d,.]+\\s*k?", "gi");
const TARGET = new RegExp(
  "(?:\\b(?:set|change|update|move|make)\\s+(?:the\\s+)?(?:ev|estimated value|estimate(?:d)?|value|them|it|all)?\\s*(?:to|=|at)\\s*|\\b(?:ev|estimated value|new value|value)\\s*(?:to|=|:|of|at)?\\s*|\\s(?:to|=|@|→|->)\\s*)" + NUM + "(?![\\d,.]*\\s*(?:k\\s*)?(?:\\+|-|–|or more|or greater|or higher|or above|and up|and above|plus\\b))",
  "gi"
);

export function readTarget(text: string): { target: number | null; rest: string } {
  const masked = text.replace(RANGE, (m) => " ".repeat(m.length)); // never read a price range as the target
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  TARGET.lastIndex = 0;
  while ((m = TARGET.exec(masked))) last = m;
  if (!last) return { target: null, rest: text };
  const n = Number(last[1].replace(/,/g, "")) * (last[2] ? 1000 : 1);
  // keep tabs / wide gaps: pasted card rows use them as column breaks
  const rest = (text.slice(0, last.index) + " " + text.slice(last.index + last[0].length)).trim();
  return { target: Number.isFinite(n) ? Math.round(n * 100) / 100 : null, rest };
}
