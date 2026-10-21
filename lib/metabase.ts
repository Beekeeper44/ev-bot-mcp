// Reads cards from Metabase question 4131 ("Warehouse Cards") using its own
// {{template-tag}} filters. The server never edits the question.
import { config } from "./config";

export type CardFilters = {
  sport?: string;
  set_name?: string | string[];
  player_name?: string | string[]; // one or more players / Pokémon; a card matches if it matches ANY
  parallel_name?: string | string[];
  grading_company?: string;
  grade?: string | string[];
  min_estimated_value?: number;
  max_estimated_value?: number;
  tag?: string; // contains-match on current tag (question's own filter)
  cert_number?: string | string[];
  ac_number?: string | string[];
  set_number?: string | string[]; // card number on the card, e.g. "US189" (needs SET_NUMBER in question 4131)
  min_ev_age_days?: number;
  max_ev_age_days?: number;
  min_times_sold_back?: number;
  order_number?: string; // the card's order # (4131 NUMBER) — exact
  po_number?: string; // purchase order # (4131 PO_NUMBER) — exact
};

export type PostFilters = {
  only_untagged?: boolean; // keep cards with no current tag
  current_tag_exact?: string; // keep cards whose current tag is exactly this
  only_base?: boolean; // keep cards with no parallel
  // several grading companies / grades in one request (e.g. "psa, beckett, sgc 10s")
  graders?: string[]; // any of these companies (any grade unless a pair or number says otherwise)
  grade_pairs?: [string, string][]; // exact company + grade, e.g. ["psa","10"]
  grade_nums?: string[]; // these grades for the listed companies (or any company if none listed)
  sports?: string[]; // several sports in one request ("basketball football baseball"): any of these
};

export type CardRow = {
  item_id: string;
  cert_number: string | null;
  ac_number: string | null;
  sport: string | null;
  set_name: string | null;
  insert: string | null;
  player_name: string | null;
  parallel_name: string | null;
  grading_company: string | null;
  grade: string | null;
  estimated_value: number | null;
  tag: string | null;
  item_status: string | null;
  front_slab_picture_url: string | null;
  card_url: string | null;
  parallel_total: string | null;
  ev_date: string | null;
  ev_age_days: number | null;
  ev_source?: "approved" | "task" | null; // what ESTIMATED_VALUE_DATE means (4131 EV_DATE_SOURCE)
  order_number: string | null;
  times_sold_back: number | null;
  storage_bin_id: string | null;
  storage_bin_slot: string | null;
  purchase_cost: number | null;
  purchase_location: string | null;
  po_number: string | null;
  set_number: string | null;
  last_comp?: number | null; // only when the question has a LAST_COMP column
  owner_email?: string | null; // order-cards question: who owns the card
};

type TemplateTag = { name: string; type: string; id?: string; ptype?: string };
let tagCache: { at: number; tags: Record<string, TemplateTag> } | null = null;
const tagCacheBy = new Map<number, { at: number; tags: Record<string, TemplateTag> }>();

async function mb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${config.metabaseHost()}${path}`, {
    ...init,
    headers: { "x-api-key": config.metabaseApiKey(), ...(init.headers || {}) },
  });
  return res;
}

// Which {{filters}} does the saved question have? Metabase reports them in different places depending on
// version, so read all of them: native template-tags, per-stage template-tags, and the card's parameters.
async function getTemplateTags(cardId: number = config.metabaseCardId()): Promise<Record<string, TemplateTag>> {
  const cached = cardId === config.metabaseCardId() ? tagCache : tagCacheBy.get(cardId) ?? null;
  if (cached && Date.now() - cached.at < 60 * 1000) return cached.tags;
  const res = await mb(`/api/card/${cardId}`);
  if (!res.ok) throw new Error(`Metabase card fetch failed: ${res.status} ${await res.text()}`);
  const card = await res.json();
  const tags: Record<string, TemplateTag> = {};
  const addTags = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj as Record<string, { name?: string; type?: string; id?: string }>)) {
      const name = v?.name || k;
      tags[name] = { ...(tags[name] || {}), name, type: v?.type === "number" ? "number" : "text", id: tags[name]?.id || v?.id };
    }
  };
  addTags(card?.dataset_query?.native?.["template-tags"]);
  for (const st of card?.dataset_query?.stages ?? []) addTags(st?.["template-tags"]);
  // the card's own parameters carry the id Metabase expects on each query parameter
  for (const p of card?.parameters ?? []) {
    const t = p?.target;
    const name = Array.isArray(t) && Array.isArray(t[1]) && t[1][0] === "template-tag" ? t[1][1] : null;
    if (!name) continue;
    const prev = tags[name];
    tags[name] = {
      name,
      type: prev?.type ?? (String(p?.type || "").startsWith("number") ? "number" : "text"),
      id: p?.id || prev?.id,
      ptype: p?.type,
    };
  }
  if (cardId === config.metabaseCardId()) tagCache = { at: Date.now(), tags };
  else tagCacheBy.set(cardId, { at: Date.now(), tags });
  return tags;
}

// Filters the question has are sent to Metabase; any it doesn't have are applied here to the returned cards.
function buildParameters(filters: CardFilters, tags: Record<string, TemplateTag>) {
  const params: unknown[] = [];
  const local: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(filters)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const tt = tags[key];
    // no such filter, or Metabase didn't give us its id: filter these cards here instead
    if (!tt || !tt.id) { local[key] = raw; continue; }
    const isNumber = tt.type === "number";
    params.push({
      id: tt.id,
      type: tt.ptype || (isNumber ? "number/=" : "category"),
      target: ["variable", ["template-tag", key]],
      value: isNumber ? [Number(raw)] : [String(raw)],
    });
  }
  return { params, local };
}

const likeText = (v: unknown, q: unknown) => {
  if (v === null || v === undefined) return false;
  const s = String(v).toLowerCase();
  let i = 0;
  for (const part of String(q).toLowerCase().split("%")) { const j = s.indexOf(part, i); if (j < 0) return false; i = j + part.length; }
  return true;
};
function applyLocal(rows: CardRow[], local: Record<string, unknown>): CardRow[] {
  const n = (v: unknown) => Number(v);
  const text: Record<string, keyof CardRow> = {
    sport: "sport", tag: "tag", set_name: "set_name", player_name: "player_name", parallel_name: "parallel_name",
    grading_company: "grading_company", grade: "grade", cert_number: "cert_number", ac_number: "ac_number",
  };
  return rows.filter((r) =>
    Object.entries(local).every(([k, v]) => {
      if (k === "min_estimated_value") return (r.estimated_value ?? 0) >= n(v);
      if (k === "max_estimated_value") return (r.estimated_value ?? 0) <= n(v);
      if (k === "min_ev_age_days") return r.ev_age_days != null && r.ev_age_days >= n(v);
      if (k === "max_ev_age_days") return r.ev_age_days != null && r.ev_age_days <= n(v);
      if (k === "min_times_sold_back") return (r.times_sold_back ?? 0) >= n(v);
      const bare = (x: unknown) => String(x ?? "").replace(/^#/, "").trim().toLowerCase();
      if (k === "order_number") return bare(r.order_number) === bare(v);
      if (k === "po_number") return bare(r.po_number) === bare(v);
      const field = text[k];
      return field ? likeText(r[field], v) : true;
    })
  );
}

function normKey(k: string) {
  return k.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function toRow(obj: Record<string, unknown>): CardRow {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) o[normKey(k)] = v;
  const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    item_id: String(o.ITEM_ID ?? o.CARD_ID ?? ""),
    cert_number: s(o.CERT_NUMBER),
    ac_number: s(o["8AC_NUMBER"]),
    sport: s(o.SPORT),
    set_name: s(o.SET_NAME),
    insert: s(o.INSERT),
    player_name: s(o.PLAYER_NAME),
    parallel_name: s(o.PARALLEL_NAME),
    grading_company: s(o.GRADING_COMPANY),
    grade: s(o.GRADE),
    estimated_value: n(o.ESTIMATED_VALUE),
    tag: s(o.TAG),
    item_status: s(o.ITEM_STATUS),
    front_slab_picture_url: s(o.FRONT_SLAB_PICTURE_URL),
    card_url: s(o.CARD_URL),
    parallel_total: s(o.PARALLEL_TOTAL),
    ev_date: s(o.ESTIMATED_VALUE_DATE),
    ev_age_days: n(o.EV_AGE_DAYS),
    ...("EV_DATE_SOURCE" in o ? { ev_source: (s(o.EV_DATE_SOURCE) as "approved" | "task" | null) } : {}),
    order_number: s(o.ORDER_NUMBER ?? o.NUMBER),
    ...("OWNER_EMAIL" in o ? { owner_email: s(o.OWNER_EMAIL) } : {}),
    times_sold_back: n(o.TIMES_SOLD_BACK),
    storage_bin_id: s(o.STORAGE_BIN_ID),
    storage_bin_slot: s(o.STORAGE_BIN_SLOT),
    purchase_cost: n(o.PURCHASE_COST),
    purchase_location: s(o.PURCHASE_LOCATION),
    po_number: s(o.PO_NUMBER),
    set_number: s(o.SET_NUMBER ?? o.CARD_NUMBER),
    ...("LAST_COMP" in o ? { last_comp: n(o.LAST_COMP) } : {}),
  };
}

// Question 4131 takes one value per filter. For lists (e.g. several players) the server
// runs one query per combination and merges the results by ITEM_ID.
const LIST_KEYS = ["player_name", "set_name", "parallel_name", "grade", "ac_number", "cert_number", "set_number"] as const;
const MAX_QUERIES = 50; // e.g. 25 names × 2 sets

type SingleFilters = { [K in keyof CardFilters]: CardFilters[K] extends string | string[] | undefined ? string : CardFilters[K] };

function expand(filters: CardFilters): SingleFilters[] {
  let combos: Record<string, unknown>[] = [{ ...filters }];
  for (const key of LIST_KEYS) {
    const v = filters[key];
    if (!Array.isArray(v)) continue;
    const values = [...new Set(v.map((x) => x.trim()).filter(Boolean))];
    if (!values.length) {
      combos = combos.map((c) => { const n = { ...c }; delete n[key]; return n; });
      continue;
    }
    combos = combos.flatMap((c) => values.map((val) => ({ ...c, [key]: val })));
  }
  if (combos.length > MAX_QUERIES) {
    throw new Error(`That request needs ${combos.length} separate searches; the limit is ${MAX_QUERIES}. Use fewer names or sets per run.`);
  }
  return combos as SingleFilters[];
}

export type QueryResult = { rows: CardRow[]; missing: { key: string; value: string }[] };

/** Runs any saved question with no filters and returns its raw rows (keys as Metabase names them). */
export async function runQuestion(cardId: number): Promise<Record<string, unknown>[]> {
  const path = `/api/card/${cardId}/query/json`;
  let res = await mb(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parameters: [], format_rows: false }) });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    res = await mb(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ parameters: "[]", format_rows: "false" }).toString() });
  }
  if (!res.ok) throw new Error(`Metabase question ${cardId} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected Metabase response for question ${cardId}`);
  return data;
}

export async function queryCardsDetailed(filters: CardFilters, post: PostFilters = {}): Promise<QueryResult> {
  const combos = expand(filters);
  const results = await Promise.all(combos.map((c) => queryOnce(c as CardFilters, post)));
  const byId = new Map<string, CardRow>();
  for (const rows of results) for (const r of rows) byId.set(r.item_id, r);

  // Which listed values found nothing at all (e.g. a misspelled or absent player)?
  const missing: { key: string; value: string }[] = [];
  for (const key of LIST_KEYS) {
    const v = filters[key];
    if (!Array.isArray(v)) continue;
    for (const val of new Set(v)) {
      const hit = combos.some((c, i) => (c as Record<string, unknown>)[key] === val && results[i].length > 0);
      if (!hit) missing.push({ key, value: val });
    }
  }
  return { rows: [...byId.values()], missing };
}

export async function queryCards(filters: CardFilters, post: PostFilters = {}): Promise<CardRow[]> {
  return (await queryCardsDetailed(filters, post)).rows;
}

// One call to question 4131. Uses the JSON export endpoint so results are not capped at 2,000 rows.
async function queryOnce(filters: CardFilters, post: PostFilters = {}): Promise<CardRow[]> {
  const tags = await getTemplateTags();
  const { params: parameters, local } = buildParameters(filters, tags);
  const path = `/api/card/${config.metabaseCardId()}/query/json`;

  // Newer Metabase takes a JSON body; older versions take form fields. Try JSON, then form.
  let res = await mb(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parameters, format_rows: false }),
  });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    const form = new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: "false" });
    res = await mb(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }
  if (!res.ok) throw new Error(`Metabase query failed: ${res.status} ${(await res.text()).slice(0, 500)}`);

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected Metabase response: ${JSON.stringify(data).slice(0, 500)}`);
  }
  // 4131 without a SET_NUMBER column: don't fail — match on everything else (the screen says the card # wasn't checked)
  const noNumberColumn = !!filters.set_number && data.length > 0 && !data.some((o: Record<string, unknown>) => Object.keys(o).some((k) => /^(set_number|card_number)$/i.test(k)));
  let rows = applyLocal(data.map(toRow).filter((r) => r.item_id), local);
  // card numbers are exact: "US189" never matches "US1890"; "#" and spaces ignored
  if (typeof filters.set_number === "string" && !noNumberColumn) {
    const want = normNo(filters.set_number);
    // "US189" must match exactly; digits alone ("189") match any prefix (US189, 189)
    rows = rows.filter((r) => {
      const have = normNo(r.set_number);
      return /^\d+[a-z]?$/.test(want) ? have === want || have.replace(/^[a-z]+-?/, "") === want : have === want;
    });
  }

  if (post.only_untagged) rows = rows.filter((r) => !r.tag);
  if (post.only_base) rows = rows.filter((r) => !r.parallel_name);
  if (post.sports?.length) rows = rows.filter((r) => post.sports!.some((sp) => (r.sport ?? "").toLowerCase().includes(sp)));
  if (post.graders?.length || post.grade_pairs?.length || post.grade_nums?.length) rows = rows.filter((r) => gradeMatches(r, post));
  // 4131's number filters are "contains"; keep exact matches only
  if (typeof filters.ac_number === "string") rows = rows.filter((r) => r.ac_number === filters.ac_number);
  if (typeof filters.cert_number === "string") rows = rows.filter((r) => r.cert_number === filters.cert_number);
  if (post.current_tag_exact) rows = rows.filter((r) => r.tag === post.current_tag_exact);
  return rows;
}

export function summarize(rows: CardRow[], newTag?: string | null) {
  const count = (key: (r: CardRow) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r) ?? "(blank)";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, n]) => ({ value, count: n }));
  };
  const totalEv = rows.reduce((s, r) => s + (r.estimated_value ?? 0), 0);
  const alreadyThisTag = newTag ? rows.filter((r) => r.tag === newTag).length : 0;
  const overwrites = rows.filter((r) => r.tag && r.tag !== newTag).length;
  return {
    matched: rows.length,
    total_estimated_value: Math.round(totalEv * 100) / 100,
    already_has_this_tag: alreadyThisTag,
    would_overwrite_other_tag: overwrites,
    untagged: rows.filter((r) => !r.tag).length,
    by_set: count((r) => r.set_name),
    by_player: count((r) => r.player_name),
    by_parallel: count((r) => r.parallel_name),
    by_grade: count((r) => r.grade),
    by_current_tag: count((r) => r.tag),
    sample: rows.slice(0, 10).map((r) => ({
      item_id: r.item_id,
      ac_number: r.ac_number,
      cert: r.cert_number,
      card: [r.set_name, r.player_name, r.parallel_name].filter(Boolean).join(" · "),
      grade: r.grade,
      ev: r.estimated_value,
      current_tag: r.tag,
      image: r.front_slab_picture_url,
    })),
  };
}

// "psa 10" -> company "psa", grade "10"
export function gradeMatches(r: CardRow, post: PostFilters): boolean {
  const gc = (r.grading_company || "").toLowerCase().replace(/\s+/g, "_");
  const num = String(r.grade || "").trim().split(/\s+/).pop() || "";
  const pairs = post.grade_pairs ?? [];
  const graders = post.graders ?? [];
  const nums = post.grade_nums ?? [];
  if (pairs.some(([c, n]) => c === gc && n === num)) return true;
  const pairCompanies = new Set(pairs.map(([c]) => c));
  // companies named without their own grade
  const loose = graders.filter((c) => !pairCompanies.has(c));
  if (loose.includes(gc)) return nums.length ? nums.includes(num) : true;
  // only grade numbers given ("10s"): any company
  if (!graders.length && !pairs.length && nums.length) return nums.includes(num);
  return false;
}

export const normNo = (v: unknown) => String(v ?? "").toLowerCase().replace(/^#|\s+|^no\.?/g, "").trim();

/** Every card in an order — customers' too — from the orders question (EV_ORDERS_CARD_ID, default 44123).
 *  Uses the question's order filter if it has one ({{order_number}}, {{number}}, {{order}}…); otherwise filters here. */
export async function queryOrderCards(orderNumber: string): Promise<CardRow[]> {
  const cardId = config.ordersCardId();
  const want = String(orderNumber).replace(/^#/, "").trim().toLowerCase();
  const tags = await getTemplateTags(cardId);
  const tagName = ["order_number", "number", "order", "order_no", "order_num", "category_order_number"].find((k) => tags[k]?.id)
    ?? Object.keys(tags).find((k) => /order/i.test(k) && tags[k]?.id);
  const tt = tagName ? tags[tagName] : null;
  const parameters = tt ? [{ id: tt.id, type: tt.ptype || (tt.type === "number" ? "number/=" : "category"), target: ["variable", ["template-tag", tagName]], value: tt.type === "number" ? [Number(want)] : [want] }] : [];
  const path = `/api/card/${cardId}/query/json`;
  let res = await mb(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parameters, format_rows: false }) });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    res = await mb(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ parameters: JSON.stringify(parameters), format_rows: "false" }).toString() });
  }
  if (!res.ok) throw new Error(`Orders question ${cardId} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected response from orders question ${cardId}`);
  if (data.length && !data.some((o: Record<string, unknown>) => Object.keys(o).some((k) => /^(item_id|card_id)$/i.test(k)))) {
    throw new Error(`Orders question ${cardId} has no ITEM_ID column, so its cards can't be updated. Save sql/order-cards.sql as a question and set EV_ORDERS_CARD_ID to it.`);
  }
  const orderOf = (o: Record<string, unknown>) => {
    const k = Object.keys(o).find((x) => /^(order_number|number|order|order_no|category_order_number)$/i.test(x));
    return k ? String(o[k] ?? "").replace(/^#/, "").trim().toLowerCase() : null;
  };
  const rows = data.filter((o: Record<string, unknown>) => { const n = orderOf(o); return n === null ? !!tt : n === want; });
  const seen = new Set<string>();
  return rows.map(toRow).filter((r) => r.item_id && !seen.has(r.item_id) && seen.add(r.item_id)).map((r) => ({ ...r, order_number: r.order_number ?? orderNumber }));
}
