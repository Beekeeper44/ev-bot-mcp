// Duplicates: every identical copy of a card in the warehouse (question 4131).
// Identical = same set, player, card number, parallel (or base), grading company and grade.
import { queryCards, type CardRow } from "./metabase";

export type CardIdentity = { item_id: string; set_name: string | null; player_name: string | null; set_number: string | null; parallel_name: string | null; grade: string | null; grading_company?: string | null };

const n = (v: unknown) => String(v ?? "").toLowerCase().replace(/[#\s]+/g, " ").trim();
const gradeKey = (g: unknown, c?: unknown) => {
  const s = n(g);
  const num = s.split(" ").pop() ?? "";
  const company = (n(c) || s.split(" ")[0] || "").replace("beckett", "bgs");
  return `${company}|${num}`;
};
export const identityKey = (r: CardIdentity) => [n(r.set_name), n(r.player_name), n(r.set_number).replace(/\s/g, ""), n(r.parallel_name), gradeKey(r.grade, r.grading_company)].join("¦");

/** For each source card, the other warehouse cards that are identical to it. */
export async function findCopies(src: CardIdentity[]): Promise<Map<string, CardRow[]>> {
  const out = new Map<string, CardRow[]>();
  const groups = new Map<string, CardIdentity[]>();
  for (const s of src) {
    if (!s.player_name || !s.set_name) { out.set(s.item_id, []); continue; }
    const k = identityKey(s);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const keys = [...groups.keys()].slice(0, 50); // one 4131 search per distinct card
  const results = await Promise.all(keys.map(async (k) => {
    const s = groups.get(k)![0];
    // 4131 may not carry SET_NUMBER yet: search by player + set, then compare. When a row has no card number,
    // match on everything else and flag it, so the screen can say the card # wasn't checked.
    const rows = await queryCards({ player_name: s.player_name!, set_name: s.set_name! });
    const kNoNum = identityKey({ ...s, set_number: null });
    return rows
      .filter((r) => (r.set_number ? identityKey({ ...r, grading_company: r.grading_company }) === k : identityKey({ ...r, set_number: null, grading_company: r.grading_company }) === kNoNum))
      .map((r) => Object.assign(r, { number_checked: !!r.set_number || !s.set_number }));
  }));
  keys.forEach((k, i) => {
    const members = groups.get(k)!;
    const mine = new Set(members.map((m) => m.item_id));
    for (const m of members) out.set(m.item_id, results[i].filter((r) => !mine.has(r.item_id)));
  });
  for (const s of src) if (!out.has(s.item_id)) out.set(s.item_id, []);
  return out;
}
