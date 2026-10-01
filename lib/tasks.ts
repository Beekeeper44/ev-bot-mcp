// Estimate tasks: every card waiting for an estimated value, from Metabase question EV_TASKS_CARD_ID.
import { config } from "./config";
import { runQuestion, toRow, type CardRow } from "./metabase";
import { q } from "./db";
import { extractIds } from "./parse";

export type Task = CardRow & { last_comp: number | null; requested_at: string | null; task_extra: Record<string, unknown>; pending?: { run_id: string; ev: number; by: string; at: string } };

const KNOWN = new Set(["ITEM_ID","CERT_NUMBER","8AC_NUMBER","SPORT","SET_NAME","INSERT","PLAYER_NAME","PARALLEL_NAME","GRADING_COMPANY","GRADE","ESTIMATED_VALUE","TAG","ITEM_STATUS","FRONT_SLAB_PICTURE_URL","CARD_URL","PARALLEL_TOTAL","ESTIMATED_VALUE_DATE","EV_AGE_DAYS","NUMBER","TIMES_SOLD_BACK","STORAGE_BIN_ID","STORAGE_BIN_SLOT","PURCHASE_COST","PURCHASE_LOCATION","PO_NUMBER","SET_NUMBER","CARD_NUMBER","LAST_COMP","LAST_COMP_VALUE","LAST_COMP_PRICE"]);
const norm = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export async function listTasks(): Promise<Task[]> {
  const id = config.evTasksCardId();
  if (!id) throw new Error("Set EV_TASKS_CARD_ID in Vercel to the Metabase question that lists cards waiting for an estimated value.");
  const raw = await runQuestion(id);
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const o of raw) {
    const row = toRow(o);
    if (!row.item_id || seen.has(row.item_id)) continue;
    seen.add(row.item_id);
    const extra: Record<string, unknown> = {};
    let requested: string | null = null;
    let lastComp: number | null = null;
    for (const [k, v] of Object.entries(o)) {
      const n = norm(k);
      if (/^(REQUESTED_AT|TASK_CREATED_AT|CREATED_AT|REQUEST_DATE|TASK_DATE)$/.test(n) && v && !requested) requested = String(v);
      else if (/^LAST_COMP(_VALUE|_PRICE)?$/.test(n)) lastComp = v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
      else if (!KNOWN.has(n) && v !== null && v !== "") extra[k] = v;
    }
    tasks.push({ ...row, last_comp: lastComp, requested_at: requested, task_extra: extra });
  }
  // cards already submitted through EV Bot and waiting for approval
  if (tasks.length) {
    const pend = await q<{ item_id: string; run_id: string; new_ev: string; requested_by: string; updated_at: string }>(
      `SELECT DISTINCT ON (i.item_id) i.item_id, i.run_id, i.new_ev, r.requested_by, i.updated_at
       FROM ev_run_items i JOIN ev_runs r ON r.id = i.run_id
       WHERE i.status IN ('submitted','approve_failed') AND i.item_id = ANY($1::text[])
       ORDER BY i.item_id, i.updated_at DESC`,
      [tasks.map((t) => t.item_id)]
    );
    const m = new Map(pend.map((p) => [p.item_id, p]));
    for (const t of tasks) {
      const p = m.get(t.item_id);
      if (p) t.pending = { run_id: p.run_id, ev: Number(p.new_ev), by: p.requested_by, at: p.updated_at };
    }
  }
  tasks.sort((a, b) => String(a.requested_at ?? "").localeCompare(String(b.requested_at ?? "")));
  return tasks;
}

// ---------- type-in search over the task list (same words you'd type in the Tag Bot) ----------
const TSTOP = new Set(("tag tags all the a an and or of for to with in on cards card set sets ev lc value values estimate estimated estimates " +
  "last comp note url waiting task tasks queue request requests please each every these those them it my new show find get list").split(" "));
const norm2 = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9#.\-/ ]+/g, " ");
export function filterTasks(all: Task[], text: string) {
  const ids = extractIds(text);
  let rest = " " + ids.rest.toLowerCase().replace(/[’']/g, "'") + " ";
  const display: Record<string, unknown> = {};
  // graders + grades: "psa 10", "bgs 9.5", "arena club 10", "10s"
  const grades: [string, string | null][] = [];
  rest = rest.replace(/\b(psa|bgs|beckett|sgc|cgc|arena[ _]?club)\s*(10|[1-9](?:\.5)?)?s?\b/g, (_m, c: string, g: string | undefined) => {
    grades.push([c.replace(/beckett/, "bgs").replace(/arena[ _]?club/, "arena_club"), g ?? null]);
    return " ";
  });
  // a grade on its own: "10", "9.5s"
  rest = rest.replace(/(^|\s)(10|[1-9](?:\.5)?)s?(?=\s)/g, (_m, pre: string, g: string) => (grades.push(["", g]), pre + " "));
  // card numbers: "#us189", "op16-098", "st21-014", "p-101"
  const nums: string[] = [];
  rest = rest.replace(/(?:^|\s)#?([a-z]{0,6}\d{0,3}-?\d{1,4}[a-z]?)(?=\s)/g, (m, n: string) => (/[a-z]/.test(n) || m.includes("#") ? (nums.push(n.replace(/^#/, "")), " ") : m));
  const base = /\bbase\b/.test(rest);
  rest = rest.replace(/\bbase\b/g, " ");
  const words = rest.split(/\s+/).map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, "")).filter((w) => w.length >= 2 && !TSTOP.has(w));
  const gradeOf = (t: Task) => {
    const g = String(t.grade ?? "").toLowerCase();
    const company = String(t.grading_company ?? g.split(" ")[0] ?? "").toLowerCase().replace("beckett", "bgs");
    const num = g.split(/\s+/).pop() ?? "";
    return { company, num };
  };
  const hay = (t: Task) => norm2([t.player_name, t.set_name, t.parallel_name, t.insert, t.set_number, t.sport, t.grading_company].join(" "));
  const missing = words.filter((w) => !all.some((t) => hay(t).includes(w)));
  const rows = all.filter((t) => {
    if (ids.ac.length && !ids.ac.includes(String(t.ac_number))) return false;
    if (ids.cert.length && !ids.cert.includes(String(t.cert_number))) return false;
    if (nums.length && !nums.some((n) => norm2(t.set_number).replace(/[#\s]/g, "") === n || norm2(t.set_number).replace(/[#\s]/g, "").endsWith(n))) return false;
    if (base && t.parallel_name) return false;
    if (grades.length) {
      const g = gradeOf(t);
      if (!grades.some(([c, n]) => (!c || g.company === c || g.company.replace("_", "").startsWith(c.replace("_", ""))) && (!n || g.num === n))) return false;
    }
    const h = hay(t);
    return words.filter((w) => !missing.includes(w)).every((w) => h.includes(w));
  });
  if (words.length) display.contains = words.join(" ");
  if (nums.length) display.set_number = nums.length === 1 ? nums[0].toUpperCase() : nums.map((n) => n.toUpperCase());
  if (grades.length) display.grade = grades.map(([c, n]) => [c || "any", n].filter(Boolean).join(" ")).join(" or ");
  if (ids.ac.length) display.ac_number = ids.ac.length === 1 ? ids.ac[0] : ids.ac;
  if (ids.cert.length) display.cert_number = ids.cert.length === 1 ? ids.cert[0] : ids.cert;
  return { rows: missing.length && missing.length === words.length && words.length ? [] : rows, missing, display, base };
}
