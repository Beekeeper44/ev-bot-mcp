// Pasted card rows (from a sheet or admin), one card per line, columns split by tabs or wide gaps:
//   2026 Pokemon Mega Evolution   —   Mega Lucario ex 033   Ascended Heroes Premium Poster Collection - Mega Lucario   PSA 10
//   SET                           INSERT  PLAYER + CARD #      PARALLEL                                                  GRADE
// Each line becomes one exact search (set + player + parallel/base + grade, card # checked when 4131 has it).
import { queryCards, type CardFilters, type CardRow } from "./metabase";

const DASH = /^[—–\-−]+$/;
const GRADE_RE = /^(psa|bgs|beckett|sgc|cgc|csg|hga|isa|arena[ _]?club)\s*(10|[1-9](?:\.5)?)$/i;
const SET_RE = /^(19|20)\d\d(-\d\d)?\s+\S/;
const NUM_ONLY = /^#?[a-z]{0,6}\d{0,3}-?\d{1,4}[a-z]{0,3}$/i;
const NUM_TAIL = /^(.*?)\s+#?([a-z]{0,6}\d{0,3}-?\d{1,4}[a-z]{0,3})$/i;

export type PastedCard = { line: string; set_name: string; insert: string | null; player_name: string; set_number: string | null; parallel_name: string | null; company: string | null; grade: string | null };

const cols = (line: string) => line.split(/\t|\s{2,}|\s+[—–]\s+/).map((c) => c.trim());

/** Recognizes pasted card rows. Returns null when the text isn't in that shape (then normal search runs). */
export function parsePasted(text: string): PastedCard[] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const out: PastedCard[] = [];
  for (const line of lines) {
    const raw = cols(line);
    if (raw.filter((c) => c && !DASH.test(c)).length < 3) return null; // not a row
    const setIdx = raw.findIndex((c) => SET_RE.test(c));
    const gradeIdx = raw.findIndex((c) => GRADE_RE.test(c));
    if (setIdx < 0) return null;
    // dashes / blanks mean "none" but keep their position. Two layouts:
    //   SET | INSERT | PLAYER | CARD # | PARALLEL | GRADE     (card # in its own column)
    //   SET | INSERT | PLAYER + CARD # | PARALLEL | GRADE     (card # at the end of the player)
    const rest = raw.map((c, i) => ({ c, i })).filter(({ i }) => i !== setIdx && i !== gradeIdx).map(({ c }) => (c && !DASH.test(c) ? c : null));
    let insert: string | null = null, player = "", parallel: string | null = null, num: string | null = null;
    const numIdx = rest.findIndex((c) => !!c && NUM_ONLY.test(c) && /\d/.test(c));
    if (numIdx >= 1) {
      num = rest[numIdx]!.replace(/^#/, "");
      const before = rest.slice(0, numIdx).filter((c): c is string => !!c);
      player = before[before.length - 1] ?? "";
      insert = before.length > 1 ? before.slice(0, -1).join(" ") : null;
      parallel = rest.slice(numIdx + 1).filter((c): c is string => !!c).join(" ") || null;
    } else if (rest.length >= 3) {
      insert = rest[0];
      player = rest[1] ?? "";
      parallel = rest.slice(2).filter((c): c is string => !!c).join(" ") || null;
    } else {
      const named = rest.filter((c): c is string => !!c);
      player = named[0] ?? "";
      parallel = named[1] ?? null;
    }
    if (!player) return null;
    if (!num) {
      const m = player.match(NUM_TAIL);
      if (m && /\d/.test(m[2]) && m[1].trim()) { player = m[1].trim(); num = m[2]; }
    }
    const g = gradeIdx >= 0 ? raw[gradeIdx].match(GRADE_RE) : null;
    const company = g ? g[1].toLowerCase().replace(/\s+/g, "_").replace("beckett", "bgs").replace(/^arena_?club$/, "arena_club") : null;
    out.push({ line, set_name: raw[setIdx], insert, player_name: player, set_number: num, parallel_name: parallel, company, grade: g ? g[2] : null });
  }
  return out;
}

const n = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const num = (v: unknown) => String(v ?? "").toLowerCase().replace(/^#/, "").replace(/^0+(?=\d)/, "").replace(/\s+/g, "");
const companyOf = (r: CardRow) => n(r.grading_company || String(r.grade ?? "").split(" ")[0]).replace("beckett", "bgs").replace("arena club", "arena_club");

/** Runs one exact search per pasted line; returns the cards, plus the lines that found nothing. */
export async function searchPasted(cards: PastedCard[]) {
  const queries: CardFilters[] = [];
  const found = new Map<string, CardRow>();
  const missing: string[] = [];
  let numberUnchecked = false;
  const results = await Promise.all(cards.slice(0, 50).map(async (c) => {
    const f: CardFilters = { set_name: c.set_name, player_name: c.player_name, ...(c.parallel_name ? { parallel_name: c.parallel_name } : {}), ...(c.company ? { grading_company: c.company === "bgs" ? "b" : c.company.replace("_", " ") } : {}) };
    queries.push(f);
    let rows = await queryCards(f);
    // single space between set and insert ("2022-23 Panini Donruss Rated Rookie"): retry without the set,
    // then keep cards whose set + insert spell out what was pasted
    let insertFromSet = false;
    if (!rows.length && !c.insert) {
      insertFromSet = true;
      const { set_name: _s, ...noSet } = f;
      const want = n(c.set_name);
      rows = (await queryCards(noSet)).filter((r) => {
        const set = n(r.set_name);
        if (!want.startsWith(set)) return false;
        const extra = want.slice(set.length).trim();
        return !extra || extra === n(r.insert);
      });
    }
    return rows.filter((r) => {
      if (!c.parallel_name && r.parallel_name) return false; // "—" / blank parallel = base only
      if (c.parallel_name && n(r.parallel_name) !== n(c.parallel_name)) return false;
      if (n(r.player_name) !== n(c.player_name) && !n(r.player_name).startsWith(n(c.player_name))) return false;
      // insert must match too ("—" = no insert), so a Rated Rookie paste never pulls the plain base card or vice versa
      if (!insertFromSet && n(r.insert) !== n(c.insert)) return false;
      if (c.company && companyOf(r) !== c.company.replace("_", " ") && !(c.company === "arena_club" && companyOf(r).replace(" ", "_") === "arena_club")) return false;
      if (c.grade && String(r.grade ?? "").trim().split(/\s+/).pop() !== c.grade) return false;
      if (c.set_number) {
        if (r.set_number) { if (num(r.set_number) !== num(c.set_number)) return false; }
        else numberUnchecked = true;
      }
      return true;
    });
  }));
  results.forEach((rows, i) => {
    if (!rows.length) missing.push(cards[i].line.replace(/\s+/g, " "));
    for (const r of rows) found.set(r.item_id, r);
  });
  const display: Record<string, unknown> = cards.length === 1
    ? Object.fromEntries(Object.entries({
        set_name: cards[0].set_name, insert: cards[0].insert ?? undefined, player_name: cards[0].player_name, set_number: cards[0].set_number ?? undefined,
        parallel_name: cards[0].parallel_name ?? "base (no parallel)", grade: cards[0].company ? `${cards[0].company} ${cards[0].grade ?? ""}`.trim() : undefined,
      }).filter(([, v]) => v !== undefined))
    : { pasted: `${cards.length} card rows` };
  if (numberUnchecked) display.note = "card # not checked (4131 has no SET_NUMBER yet)";
  return { rows: [...found.values()], queries, missing, display };
}
