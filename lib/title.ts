// Title search for card names typed the way they're printed / listed, e.g.
//   "2023 pokemon swsh crown zenith leafeon vstar #gg35 psa 10"
//   "2025 one piece tony tony chopper p-101 store tournament vol.4 arena club 10"
// TCG titles mix set, product, character, rarity and number words, so instead of guessing which word is which:
//   1. find the character/player: probe 4131's player filter with 1–3 word windows (nearest the card # first)
//   2. keep the cards where every other typed word appears somewhere on the card (set, insert, player, parallel, #)
//      — a word that appears on none of that player's cards ("swsh", "vstar"…) is ignored and reported
//   3. year, grade and card # must match.
import { queryCards, type CardRow } from "./metabase";

const STOP = new Set("the a an of and or for with card cards all every graded grade slab slabs psa bgs beckett sgc cgc arena club tag".split(" "));
const TCG = /\b(pokemon|pokémon|one piece|yu-?gi-?oh|lorcana|magic|mtg|digimon|dragon ball|weiss|flesh and blood)\b/i;
const GRADE = /\b(psa|bgs|beckett|sgc|cgc|arena\s*club)\s*(10|[1-9](?:\.5)?)\b/gi;
const NUM = /(?:^|\s)(?:#\s*([a-z0-9]{1,8}(?:-[a-z0-9]{1,5})?)|((?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z]{1,6}\d{0,3}-?\d{1,4}[a-z]{0,2}))(?=\s|,|$)/i;

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/pokémon/g, "pokemon").replace(/[^a-z0-9]+/g, " ").trim();
const normNo = (v: unknown) => String(v ?? "").toLowerCase().replace(/^#/, "").replace(/\s+/g, " ").trim();
const hay = (r: CardRow) => " " + norm([r.set_name, r.insert, r.player_name, r.parallel_name, r.set_number, r.sport].join(" ")) + " ";

export const looksLikeTcg = (text: string) => TCG.test(text);

export async function titleSearch(text: string) {
  const t0 = Date.now();
  let t = " " + text.toLowerCase().replace(/pokémon/g, "pokemon") + " ";
  // grades
  const grades: [string, string][] = [];
  t = t.replace(GRADE, (_m, c: string, g: string) => (grades.push([c.replace("beckett", "bgs").replace(/arena\s*club/, "arena_club"), g]), " "));
  // card #
  let num: string | null = null;
  const nm = t.match(NUM);
  if (nm) { num = (nm[1] || nm[2]).toLowerCase(); t = t.replace(nm[0], " "); }
  // year
  const ym = t.match(/\b((?:19|20)\d\d)(?:-\d\d)?\b/);
  const year = ym ? ym[1] : null;
  if (ym) t = t.replace(ym[0], " ");
  const tokens = norm(t).split(" ").filter((w) => w && !STOP.has(w));
  if (!tokens.length) return null;

  // 1. player/character: windows of 1–3 words, longest first, nearest the end (names sit right before the #)
  const SPORT_WORDS = new Set(["pokemon", "one", "piece"]);
  const windows: string[] = [];
  for (let len = Math.min(3, tokens.length); len >= 1; len--) {
    for (let i = tokens.length - len; i >= 0; i--) {
      const w = tokens.slice(i, i + len);
      if (w.every((x) => SPORT_WORDS.has(x) || /^\d+$/.test(x)) || w.some((x) => x.length < 2)) continue;
      windows.push(w.join(" "));
    }
  }
  let anchor: CardRow[] = [], anchorWord = "";
  for (let i = 0; i < windows.length && !anchor.length; i += 6) {
    const batch = windows.slice(i, i + 6);
    const res = await Promise.all(batch.map((w) => queryCards({ player_name: w }).catch(() => [] as CardRow[])));
    // first (longest, nearest the #) window that finds cards wins
    const k = res.findIndex((r) => r.length > 0);
    if (k >= 0) { anchor = res[k]; anchorWord = batch[k]; }
  }
  if (!anchor.length) return { rows: [], missing: tokens, display: {}, queries: [], ms: Date.now() - t0, numberUnchecked: false };

  // 2. every other word must be on the card — unless it's on none of this player's cards (then ignore + report)
  const rest = tokens.filter((w) => !anchorWord.split(" ").includes(w));
  const required = rest.filter((w) => anchor.some((r) => hay(r).includes(" " + w + " ") || hay(r).includes(" " + w)));
  const ignored = rest.filter((w) => !required.includes(w));
  let numberUnchecked = false;
  const rows = anchor.filter((r) => {
    const h = hay(r);
    if (year && !norm(r.set_name).includes(year)) return false;
    if (!required.every((w) => h.includes(" " + w))) return false;
    if (grades.length) {
      const g = String(r.grade ?? "").toLowerCase().trim();
      const company = norm(r.grading_company || g.split(" ")[0]).replace("beckett", "bgs").replace("arena club", "arena_club");
      const gnum = g.split(/\s+/).pop();
      if (!grades.some(([c, n]) => (company === c || company.replace("_", " ") === c.replace("_", " ")) && gnum === n)) return false;
    }
    if (num) {
      if (r.set_number) {
        const have = normNo(r.set_number), want = num.replace(/^0+(?=\d)/, "");
        const haveCore = have.split(" ")[0].replace(/^0+(?=\d)/, ""); // "op16-098 sr" -> "op16-098"
        if (haveCore !== want && !haveCore.endsWith(want) && have !== num) return false;
      } else if (!h.includes(" " + num.replace(/[^a-z0-9]+/g, " "))) numberUnchecked = true;
    }
    return true;
  });
  const names = [...new Set(rows.map((r) => r.player_name).filter(Boolean))];
  const display: Record<string, unknown> = {
    player_name: names.length && names.length <= 2 ? names.join(" / ") : anchorWord,
    ...(year ? { year } : {}),
    ...(required.length ? { contains: required.join(" ") } : {}),
    ...(num ? { set_number: num.toUpperCase() } : {}),
    ...(grades.length ? { grade: grades.map(([c, n]) => `${c} ${n}`).join(" or ") } : {}),
    ...(ignored.length ? { ignored: ignored.join(" ") } : {}),
    ...(numberUnchecked ? { note: "card # not checked (4131 has no SET_NUMBER yet)" } : {}),
  };
  return { rows, missing: rows.length ? [] : required, display, queries: [{ player_name: anchorWord }], ms: Date.now() - t0, numberUnchecked };
}
