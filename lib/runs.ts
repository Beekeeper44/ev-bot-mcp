// EV Bot runs. Two separate steps, like admin:
//   SUBMIT  — writes each card's estimate (value, last comp, URL, note). It shows as "done" in admin
//             and lands in the Approve queue here. Sources: the Estimate tasks queue, a search, or Claude.
//   APPROVE — approves queued cards in bulk (note "mcp approved"), which makes the values live.
// Every card's previous value is saved before writing, so an approved run can be undone exactly.
import { randomBytes } from "crypto";
import { config, validateEv, validateExtras, sameEv, pctChange, type EvExtras } from "./config";
import { queryCards, queryCardsDetailed, type CardFilters, type CardRow, type PostFilters } from "./metabase";
import { openAdminSession, readEv, writeEv, approveEv, type EvSnapshot, type EstimateRecord } from "./admin";
import { can, type Actor } from "./users";
import { listTasks } from "./tasks";
import { findCopies } from "./copies";
import { q } from "./db";

function need(actor: Actor, role: "editor" | "approver", what: string) {
  if (!can(actor, role)) throw new Error(`${actor.name} is a ${actor.role}; ${what} needs ${role} access. Ask an EV Bot admin.`);
}

type Run = {
  id: string;
  status: string;
  action: "set" | "tasks" | "approve" | "undo" | "withdraw";
  target_ev: string | null;
  filters: CardFilters;
  post_filters: PostFilters;
  queries: CardFilters[] | null;
  requested_by: string;
  requested_by_id: string | null;
  preview_count: number;
  dry_run: boolean | null;
  undo_of: string | null;
  note: string | null;
  last_comp: string | null;
  comp_url: string | null;
  expires_at: string;
};

export type SubmitItem = { item_id: string; ev: number; last_comp?: number | null; url?: string | null; note: string; label?: string; img?: string | null; warehouse_ev?: number | null };

const newId = () => "ev_" + randomBytes(5).toString("hex");
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const r2 = (n: number) => Math.round(n * 100) / 100;
const label = (r: CardRow) => [r.ac_number, r.set_name, r.player_name, r.set_number ? "#" + r.set_number : "", r.parallel_name, (r.grade || "").toUpperCase()].filter(Boolean).join(" · ");
// every matched card counts, even if it's already at the value (a fresh estimate is still recorded)
const needsChange = (rows: CardRow[], _target: number) => rows;

function cleanExtras(x: Partial<EvExtras>): EvExtras {
  const err = validateExtras(x);
  if (err) throw new Error(err);
  return { note: String(x.note).trim(), last_comp: x.last_comp == null || (x.last_comp as unknown) === "" ? null : r2(Number(x.last_comp)), url: x.url ? String(x.url).trim() : null };
}
function cleanItem(it: SubmitItem): SubmitItem {
  const e = validateEv(it.ev);
  if (e) throw new Error(`${it.label || it.item_id}: ${e}`);
  try {
    return { ...it, ev: r2(Number(it.ev)), ...cleanExtras(it) };
  } catch (err) {
    throw new Error(`${it.label || it.item_id}: ${(err as Error).message}`);
  }
}

async function loadRun(id: string): Promise<Run> {
  const [run] = await q<Run>(`SELECT * FROM ev_runs WHERE id = $1`, [id]);
  if (!run) throw new Error(`No run ${id}`);
  return run;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, size) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

async function insertItems(runId: string, items: SubmitItem[]) {
  await q(
    `INSERT INTO ev_run_items (run_id, item_id, warehouse_ev, previous_ev, prev_source, new_ev, label, img, last_comp, comp_url, note)
     SELECT $1, t.item_id, t.wev, t.wev, 'warehouse', t.ev, t.label, t.img, t.lc, t.url, t.note
     FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::text[])
       AS t(item_id, wev, ev, label, img, lc, url, note)`,
    [runId, items.map((i) => i.item_id), items.map((i) => i.warehouse_ev ?? null), items.map((i) => i.ev), items.map((i) => i.label ?? null),
     items.map((i) => i.img ?? null), items.map((i) => i.last_comp ?? null), items.map((i) => i.url ?? null), items.map((i) => i.note)]
  );
}
const fromRow = (r: CardRow, ev: number, x: EvExtras): SubmitItem => ({ item_id: r.item_id, ev, ...x, label: label(r), img: r.front_slab_picture_url, warehouse_ev: r.estimated_value });

// ============ SUBMIT ============
/** Writes the frozen items of a run as estimates (no approve). Items land in the Approve queue. */
async function submitRun(runId: string, actor: Actor) {
  const items = await q<{ item_id: string; new_ev: string; last_comp: string | null; comp_url: string | null; note: string }>(
    `SELECT item_id, new_ev, last_comp, comp_url, note FROM ev_run_items WHERE run_id=$1 AND status='pending'`, [runId]
  );
  const session = await openAdminSession(actor.session_user_id);
  const startedAt = new Date().toISOString();
  let results;
  try {
    results = await pool(items, config.writeConcurrency(), async (it) => {
      // save what admin has right now (value, last comp, URL, note) so an approved change can be undone exactly
      const prev: EvSnapshot | undefined = await readEv(session, it.item_id);
      // last comp is required on the first pass; a card that already has one keeps it
      const lc = it.last_comp != null ? Number(it.last_comp) : prev?.last_comp ?? null;
      if (lc == null) {
        return { ok: false, status: 0, error: prev === undefined ? "Last comp required (couldn't confirm the card already has one)" : "Last comp required: this card has none yet", prev, returnedEv: undefined, submitId: undefined, record: undefined };
      }
      const w = await writeEv(session, it.item_id, Number(it.new_ev), { note: it.note + actor.note_suffix, last_comp: lc, url: it.comp_url }, startedAt);
      return { ...w, prev, lc };
    });
  } finally {
    await session.revoke();
  }
  const statuses = results.map((r, i) => (!r.ok ? "failed" : r.returnedEv !== undefined && !sameEv(r.returnedEv, Number(items[i].new_ev)) ? "mismatch" : "submitted"));
  await q(
    `UPDATE ev_run_items AS i SET status=t.status, http_status=t.http, returned_ev=t.ret, error=t.err, estimate_id=t.sid,
       previous_ev = CASE WHEN t.has_prev THEN t.prev ELSE i.previous_ev END,
       prev_source = CASE WHEN t.has_prev THEN 'admin' ELSE i.prev_source END,
       prev_fields = CASE WHEN t.has_prev THEN t.pf::jsonb ELSE i.prev_fields END,
       submit_record = t.rec::jsonb, last_comp = COALESCE(i.last_comp, t.lc),
       submitted_by=$10, submitted_at=now(), updated_at=now()
     FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::text[], $7::text[], $8::bool[], $9::numeric[], $11::text[], $12::text[], $13::numeric[])
       AS t(item_id, status, http, ret, err, sid, has_prev, prev, pf, rec, lc)
     WHERE i.run_id=$1 AND i.item_id=t.item_id`,
    [runId, items.map((x) => x.item_id), statuses, results.map((r) => r.status), results.map((r) => r.returnedEv ?? null), results.map((r) => r.error ?? null),
     results.map((r) => r.submitId ?? null), results.map((r) => r.prev !== undefined), results.map((r) => r.prev?.ev ?? null), actor.name,
     results.map((r) => (r.prev === undefined ? null : JSON.stringify(r.prev))),
     results.map((r) => (r.record ? JSON.stringify(r.record) : null)), results.map((r) => ("lc" in r ? r.lc : null) ?? null)]
  );
  // a newer submit replaces an older one still waiting in the Approve queue
  const ok = items.filter((_, i) => statuses[i] === "submitted").map((x) => x.item_id);
  if (ok.length) {
    await q(`UPDATE ev_run_items SET status='superseded', updated_at=now() WHERE run_id<>$1 AND item_id = ANY($2::text[]) AND status IN ('submitted','approve_failed')`, [runId, ok]);
  }
  const tally = (s: string) => statuses.filter((x) => x === s).length;
  const res = {
    submitted_ids: ok,
    submitted: tally("submitted"),
    failed: tally("failed"),
    mismatch: tally("mismatch"),
    failures: results.map((r, i) => ({ item_id: items[i].item_id, status: r.status, error: r.error, returned_ev: r.returnedEv })).filter((_, i) => statuses[i] !== "submitted").slice(0, 30),
  };
  const status = res.failed || res.mismatch ? "partial" : "submitted";
  await q(`UPDATE ev_runs SET status=$2, finished_at=now(), result=$3 WHERE id=$1`, [runId, status, JSON.stringify(res)]);
  return { run_id: runId, status, ...res, next_step: res.submitted ? "These cards are now in the Approve queue." : undefined };
}

async function createRun(action: Run["action"], actor: Actor, items: SubmitItem[], extra: { filters?: unknown; post?: unknown; queries?: unknown; target?: number | null; note?: string; dry?: boolean; undo_of?: string } = {}) {
  const id = newId();
  await q(
    `INSERT INTO ev_runs (id, status, action, target_ev, filters, post_filters, queries, requested_by, requested_by_id, preview_count, staged_by, staged_at, staged_count, approved_by, live_at, dry_run, note, undo_of, admin_as, expires_at)
     VALUES ($1,'executing',$2,$3,$4,$5,$6,$7,$8,$9,$7,now(),$9,$7,now(),$10,$11,$12,$13,now() + interval '1 hour')`,
    [id, action, extra.target ?? null, JSON.stringify(extra.filters ?? {}), JSON.stringify(extra.post ?? {}), JSON.stringify(extra.queries ?? null), actor.name, actor.id,
     items.length, !!extra.dry, extra.note ?? null, extra.undo_of ?? null, actor.attribution === "own" ? actor.email : `shared · ${actor.name}`]
  );
  await insertItems(id, items);
  return id;
}
async function finishDry(id: string, n: number) {
  await q(`UPDATE ev_run_items SET status='would_submit', updated_at=now() WHERE run_id=$1`, [id]);
  const result = { dry_run: true, would_submit: n };
  await q(`UPDATE ev_runs SET status='dry_run_completed', finished_at=now(), result=$2 WHERE id=$1`, [id, JSON.stringify(result)]);
  return { run_id: id, status: "dry_run_completed", ...result, submitted_ids: [] as string[], note: "Dry run: nothing was written to admin." };
}

/** Estimate tasks screen: each card with its own value, last comp, URL and note. */
export async function submitTasks(input: { items: SubmitItem[]; actor: Actor; dry_run?: boolean; include_copies?: boolean }) {
  need(input.actor, "editor", "submitting estimates");
  const wanted = new Map<string, SubmitItem>();
  for (const it of input.items) wanted.set(it.item_id, cleanItem(it));
  if (!wanted.size) throw new Error("No cards to submit.");
  if (wanted.size > config.maxItemsPerRun()) throw new Error(`${wanted.size} cards is over the ${config.maxItemsPerRun()}-card limit.`);
  // only cards still in the task queue right now
  const live = new Map((await listTasks()).map((t) => [t.item_id, t]));
  const items: SubmitItem[] = [];
  const gone: string[] = [];
  for (const [id, it] of wanted) {
    const t = live.get(id);
    if (!t) { gone.push(id); continue; }
    items.push({ ...it, last_comp: it.last_comp ?? t.last_comp, label: label(t), img: t.front_slab_picture_url, warehouse_ev: t.estimated_value });
  }
  const noLc = items.filter((it) => it.last_comp == null);
  if (noLc.length) {
    throw new Error(`Last comp is required for cards that don't have one yet: ${noLc.slice(0, 5).map((i) => i.label).join("; ")}${noLc.length > 5 ? ` and ${noLc.length - 5} more` : ""}.`);
  }
  if (!items.length) throw new Error("None of these cards are in the task queue anymore. Refresh.");
  // duplicates: every identical copy in the warehouse gets the same value, last comp, note and URL
  // (a copy that already has an EV gets it replaced)
  let copiesAdded = 0;
  if (input.include_copies) {
    const copies = await findCopies(items.map((it) => live.get(it.item_id)!));
    const have = new Set(items.map((i) => i.item_id));
    for (const it of [...items]) {
      for (const c of copies.get(it.item_id) ?? []) {
        if (have.has(c.item_id)) continue;
        have.add(c.item_id);
        items.push({ ...it, item_id: c.item_id, label: label(c) + " (copy)", img: c.front_slab_picture_url, warehouse_ev: c.estimated_value });
        copiesAdded++;
      }
    }
    if (items.length > config.maxItemsPerRun()) throw new Error(`With copies that's ${items.length} cards, over the ${config.maxItemsPerRun()}-card limit. Select fewer cards.`);
  }
  const id = await createRun("tasks", input.actor, items, { dry: config.dryRun() || input.dry_run });
  const res = config.dryRun() || input.dry_run ? await finishDry(id, items.length) : await submitRun(id, input.actor);
  return { ...res, skipped_not_in_queue: gone, copies_added: copiesAdded };
}

/** Search screen: one value for every selected card. */
export async function runSelection(input: {
  filters: CardFilters; post_filters?: PostFilters; target_ev: number | null; note: string; last_comp?: number | null; url?: string | null;
  values?: Record<string, { ev?: number | null; last_comp?: number | null }>; // per-card overrides typed on the tiles
  item_ids: string[]; queries?: CardFilters[]; dry_run?: boolean; actor: Actor;
}) {
  need(input.actor, "editor", "submitting estimates");
  const x = cleanExtras(input);
  const vals = input.values ?? {};
  const evFor = (id: string) => (vals[id]?.ev != null ? r2(Number(vals[id]!.ev)) : input.target_ev != null ? r2(Number(input.target_ev)) : null);
  for (const id of input.item_ids) {
    const v = evFor(id);
    const e = v == null ? "Enter a value for every selected card." : validateEv(v);
    if (e) throw new Error(e);
    const lc = vals[id]?.last_comp;
    if (lc != null && !(Number.isFinite(Number(lc)) && Number(lc) >= 0)) throw new Error("Last comp must be a dollar amount.");
  }
  const target = input.target_ev != null ? r2(Number(input.target_ev)) : null;
  const wanted = [...new Set(input.item_ids)];
  if (!wanted.length) throw new Error("No cards selected.");
  if (wanted.length > config.maxItemsPerRun()) throw new Error(`${wanted.length} cards is over the ${config.maxItemsPerRun()}-card limit.`);
  const fresh = input.queries?.length
    ? (await Promise.all(input.queries.slice(0, 60).map((f) => queryCards(f, input.post_filters ?? {})))).flat()
    : await queryCards(input.filters, input.post_filters ?? {});
  // every selected card is submitted, including ones already at this value (a fresh estimate is still recorded)
  const byId = new Map(fresh.map((r) => [r.item_id, r]));
  const chosen = wanted.map((id) => byId.get(id)).filter((r): r is CardRow => !!r);
  if (!chosen.length) throw new Error("None of the selected cards are in the warehouse anymore. Search again.");
  const dry = config.dryRun() || input.dry_run;
  const items = chosen.map((r) => {
    const lc = vals[r.item_id]?.last_comp;
    return fromRow(r, evFor(r.item_id)!, { ...x, last_comp: lc != null ? r2(Number(lc)) : x.last_comp });
  });
  const id = await createRun("set", input.actor, items, { filters: input.filters, post: input.post_filters, queries: input.queries, target, note: x.note, dry });
  const res = dry ? await finishDry(id, chosen.length) : await submitRun(id, input.actor);
  return { ...res, skipped_no_longer_matching: wanted.length - chosen.length };
}

// ---- Claude: preview -> stage -> go live (go live = submit) ----
export async function previewRun(input: { filters: CardFilters; post_filters?: PostFilters; target_ev: number; note: string; last_comp?: number | null; url?: string | null; actor: Actor }) {
  need(input.actor, "editor", "submitting estimates");
  const err = validateEv(input.target_ev);
  if (err) throw new Error(err);
  const x = cleanExtras(input);
  if (!Object.values(input.filters).some((v) => v !== undefined && v !== "")) throw new Error("At least one filter is required.");
  const target = r2(Number(input.target_ev));
  const post = input.post_filters ?? {};
  const { rows: matched, missing } = await queryCardsDetailed(input.filters, post);
  const rows = needsChange(matched, target);
  const summary = summarizeEv(rows, target);
  const id = newId();
  await q(
    `INSERT INTO ev_runs (id, status, action, target_ev, filters, post_filters, requested_by, requested_by_id, preview, preview_count, expires_at, note, last_comp, comp_url)
     VALUES ($1,'draft','set',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, target, JSON.stringify(input.filters), JSON.stringify(post), input.actor.name, input.actor.id, JSON.stringify(summary), rows.length, hoursFromNow(config.runExpiryHours()), x.note, x.last_comp, x.url]
  );
  return {
    run_id: id, status: "draft", note: x.note, last_comp: x.last_comp, url: x.url,
    matched_before_exclusions: matched.length, already_at_target: matched.length - rows.length,
    no_cards_found_for: missing.map((m) => `${m.key}: ${m.value}`),
    ...summary, cap: config.maxItemsPerRun(), over_cap: rows.length > config.maxItemsPerRun(), dry_run: config.dryRun(),
    warning: [
      missing.length ? `No cards matched ${missing.map((m) => m.value).join(", ")}. Tell the user before staging.` : "",
      summary.big_changes ? `${summary.big_changes} cards move more than ${config.bigChangePct()}% (or have no value). Call this out.` : "",
      new Set(summary.by_card.map((b) => b.value)).size > 1 ? "These are not all the same card; every one gets the same value. Confirm that's intended." : "",
    ].filter(Boolean).join(" ") || undefined,
    next_step: rows.length ? `Show the readback. To freeze this list, call stage_ev_run with run_id=${id} and confirm_count=${rows.length}.` : "Nothing to change.",
  };
}

export async function stageRun(input: { run_id: string; confirm_count: number; actor: Actor }) {
  need(input.actor, "editor", "staging a run");
  const run = await loadRun(input.run_id);
  if (run.status !== "draft") throw new Error(`Run is ${run.status}, not draft.`);
  if (new Date(run.expires_at) < new Date()) throw new Error("Draft expired. Run a new preview.");
  if (input.confirm_count !== run.preview_count) throw new Error(`confirm_count ${input.confirm_count} does not match the preview count ${run.preview_count}.`);
  if (run.preview_count > config.maxItemsPerRun()) throw new Error(`Preview has ${run.preview_count} cards; cap is ${config.maxItemsPerRun()}.`);
  const target = Number(run.target_ev);
  const rows = needsChange(await queryCards(run.filters, run.post_filters), target);
  if (rows.length !== run.preview_count) {
    await q(`UPDATE ev_runs SET status='cancelled' WHERE id=$1`, [run.id]);
    throw new Error(`Matches changed from ${run.preview_count} to ${rows.length} since preview. Draft cancelled; run a new preview.`);
  }
  const x: EvExtras = { note: run.note ?? config.defaultNote(), last_comp: run.last_comp == null ? null : Number(run.last_comp), url: run.comp_url };
  await insertItems(run.id, rows.map((r) => fromRow(r, target, x)));
  await q(`UPDATE ev_runs SET status='staged', staged_by=$2, staged_at=now(), staged_count=$3, expires_at=$4 WHERE id=$1`, [run.id, input.actor.name, rows.length, hoursFromNow(config.runExpiryHours())]);
  return { run_id: run.id, status: "staged", frozen_cards: rows.length, target_ev: target, next_step: `To submit to admin, call submit_ev_run with run_id=${run.id} and confirm=true.` };
}

export async function goLive(input: { run_id: string; confirm: boolean; actor: Actor; dry_run?: boolean }) {
  if (input.confirm !== true) throw new Error("confirm must be true.");
  need(input.actor, "editor", "submitting estimates");
  const run = await loadRun(input.run_id);
  if (new Date(run.expires_at) < new Date()) throw new Error("Staged run expired. Run a new preview.");
  const dry = config.dryRun() || input.dry_run === true;
  const [claimed] = await q(`UPDATE ev_runs SET status='executing', approved_by=$2, live_at=now(), dry_run=$3 WHERE id=$1 AND status='staged' RETURNING id`, [run.id, input.actor.name, dry]);
  if (!claimed) throw new Error(`Run is ${run.status}; only a staged run can be submitted, and only once.`);
  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ev_run_items WHERE run_id=$1`, [run.id]);
  return dry ? finishDry(run.id, n) : submitRun(run.id, input.actor);
}

// ============ APPROVE ============
export async function approvalQueue(limit = 2000) {
  return q(
    `SELECT i.run_id, i.item_id, i.label, i.img, i.new_ev, i.last_comp, i.comp_url, i.note, i.previous_ev, i.estimate_id,
            i.status, i.approve_error, coalesce(i.submitted_by, r.requested_by) AS submitted_by, coalesce(i.submitted_at, i.updated_at) AS submitted_at
     FROM ev_run_items i JOIN ev_runs r ON r.id=i.run_id
     WHERE i.status IN ('submitted','approve_failed') AND r.action IN ('set','tasks')
     ORDER BY coalesce(i.submitted_at, i.updated_at) LIMIT $1`,
    [limit]
  );
}

/** Approves queued cards (all, or the ones given). Each approve uses the value/last comp/URL that was submitted. */
export async function approveQueued(input: { item_ids?: string[] | "all"; note?: string; actor: Actor; dry_run?: boolean }) {
  need(input.actor, "approver", "approving estimates");
  const note = (input.note || config.evApproveNote()).trim();
  type QI = { run_id: string; item_id: string; label: string | null; img: string | null; new_ev: string; last_comp: string | null; comp_url: string | null; estimate_id: string | null; previous_ev: string | null; prev_fields: EvSnapshot | null; submit_record: EstimateRecord | null };
  let rows = await q<QI>(
    `SELECT i.run_id, i.item_id, i.label, i.img, i.new_ev, i.last_comp, i.comp_url, i.estimate_id, i.previous_ev, i.prev_fields, i.submit_record
     FROM ev_run_items i JOIN ev_runs r ON r.id=i.run_id
     WHERE i.status IN ('submitted','approve_failed') AND r.action IN ('set','tasks') ORDER BY i.submitted_at`
  );
  if (input.item_ids !== "all") {
    const want = new Set(input.item_ids ?? []);
    rows = rows.filter((r) => want.has(r.item_id));
  }
  if (!rows.length) throw new Error("Nothing in the Approve queue matches. Refresh.");
  if (rows.length > config.maxItemsPerRun()) throw new Error(`${rows.length} cards is over the ${config.maxItemsPerRun()}-card limit. Approve in smaller batches.`);
  const dry = config.dryRun() || input.dry_run === true;
  const id = newId();
  await q(
    `INSERT INTO ev_runs (id, status, action, filters, post_filters, requested_by, requested_by_id, preview_count, staged_by, staged_at, staged_count, approved_by, live_at, dry_run, note, admin_as, expires_at)
     VALUES ($1,'executing','approve','{}','{}',$2,$3,$4,$2,now(),$4,$2,now(),$5,$6,$7,now() + interval '1 hour')`,
    [id, input.actor.name, input.actor.id, rows.length, dry, note, input.actor.attribution === "own" ? input.actor.email : `shared · ${input.actor.name}`]
  );
  // approve-run items point back at the submit they approve (source_run) and carry its "before" values for undo
  await q(
    `INSERT INTO ev_run_items (run_id, item_id, source_run, label, img, new_ev, last_comp, comp_url, note, estimate_id, previous_ev, prev_fields, prev_source)
     SELECT $1, i.item_id, i.run_id, i.label, i.img, i.new_ev, i.last_comp, i.comp_url, $2, i.estimate_id, i.previous_ev, i.prev_fields, i.prev_source
     FROM ev_run_items i WHERE (i.run_id, i.item_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
    [id, note, rows.map((r) => r.run_id), rows.map((r) => r.item_id)]
  );
  if (dry) {
    await q(`UPDATE ev_run_items SET status='would_approve' WHERE run_id=$1`, [id]);
    await q(`UPDATE ev_runs SET status='dry_run_completed', finished_at=now(), result=$2 WHERE id=$1`, [id, JSON.stringify({ dry_run: true, would_approve: rows.length })]);
    return { run_id: id, status: "dry_run_completed", would_approve: rows.length, approved_ids: [] as string[] };
  }
  const session = await openAdminSession(input.actor.session_user_id);
  const startedAt = new Date().toISOString();
  let results;
  try {
    results = await pool(rows, config.writeConcurrency(), (r) =>
      approveEv(session, r.item_id, r.submit_record, Number(r.new_ev), { note: note + input.actor.note_suffix, last_comp: r.last_comp == null ? null : Number(r.last_comp), url: r.comp_url }, startedAt)
    );
  } finally {
    await session.revoke();
  }
  const st = results.map((r) => (r.ok ? "approved" : "approve_failed"));
  await q(
    `UPDATE ev_run_items AS i SET status=t.st, approve_http=t.http, approve_error=t.err, updated_at=now()
     FROM unnest($2::text[], $3::text[], $4::int[], $5::text[]) AS t(item_id, st, http, err) WHERE i.run_id=$1 AND i.item_id=t.item_id`,
    [id, rows.map((r) => r.item_id), st, results.map((r) => r.status), results.map((r) => r.error ?? null)]
  );
  // the submits they came from: approved ones leave the queue; failures stay with the error shown
  await q(
    `UPDATE ev_run_items AS i SET status=t.st, approve_http=t.http, approve_error=t.err, approved_by=$1, approved_at=CASE WHEN t.st='approved' THEN now() END, updated_at=now()
     FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[]) AS t(run_id, item_id, st, http, err) WHERE i.run_id=t.run_id AND i.item_id=t.item_id`,
    [input.actor.name, rows.map((r) => r.run_id), rows.map((r) => r.item_id), st, results.map((r) => r.status), results.map((r) => r.error ?? null)]
  );
  const approved = rows.filter((_, i) => st[i] === "approved").map((r) => r.item_id);
  const res = {
    approved_ids: approved, approved: approved.length, failed: st.length - approved.length,
    failures: results.map((r, i) => ({ item_id: rows[i].item_id, label: rows[i].label, status: r.status, error: r.error })).filter((_, i) => st[i] !== "approved").slice(0, 30),
  };
  const status = res.failed ? "partial" : "completed";
  await q(`UPDATE ev_runs SET status=$2, finished_at=now(), result=$3 WHERE id=$1`, [id, status, JSON.stringify(res)]);
  return { run_id: id, status, ...res, next_step: approved.length ? `Values are live. Undo with undo_ev_run run_id=${id}.` : undefined };
}

/** Takes cards out of the Approve queue without approving (the submitted estimate stays "done" in admin, never goes live). */
export async function withdrawQueued(input: { item_ids: string[]; actor: Actor }) {
  need(input.actor, "editor", "withdrawing");
  const ids = [...new Set(input.item_ids)];
  const where = can(input.actor, "approver") ? "" : `AND i.run_id IN (SELECT id FROM ev_runs WHERE requested_by_id=$3)`;
  const rows = await q<{ item_id: string }>(
    `UPDATE ev_run_items i SET status='withdrawn', approved_by=$2, updated_at=now()
     WHERE i.item_id = ANY($1::text[]) AND i.status IN ('submitted','approve_failed') ${where} RETURNING i.item_id`,
    can(input.actor, "approver") ? [ids, input.actor.name] : [ids, input.actor.name, input.actor.id]
  );
  return { withdrawn: rows.length, note: can(input.actor, "approver") ? undefined : "Editors can only withdraw their own submits." };
}

// ============ UNDO (approved runs) ============
/** Puts every card an approve run made live back to the value it had before: submits the old value, then approves it. */
export async function undoRun(input: { run_id: string; confirm: boolean; actor: Actor }) {
  if (input.confirm !== true) throw new Error("confirm must be true.");
  need(input.actor, "approver", "undo");
  const run = await loadRun(input.run_id);
  if (run.action !== "approve") throw new Error("Only approve runs change live values, so only they can be undone. To drop submitted cards, withdraw them from the Approve queue.");
  if (!["completed", "partial"].includes(run.status)) throw new Error(`Run is ${run.status}; only completed or partial approve runs can be undone.`);
  if (config.dryRun()) throw new Error("DRY_RUN is on; undo would not write.");
  const all = await q<{ item_id: string; previous_ev: string | null; label: string | null; img: string | null; prev_fields: EvSnapshot | null }>(
    `SELECT item_id, previous_ev, label, img, prev_fields FROM ev_run_items WHERE run_id=$1 AND status='approved'`, [run.id]
  );
  const items = all.filter((i) => i.previous_ev != null && Number(i.previous_ev) > 0);
  const skipped = all.filter((i) => !items.includes(i)).map((i) => i.item_id);
  if (!items.length) throw new Error("No cards with a known previous value to restore.");
  const undoNote = `EV Bot: undo of ${run.id} by ${input.actor.name}`;
  const id = await createRun("undo", input.actor, items.map((i) => ({
    item_id: i.item_id, ev: Number(i.previous_ev), label: i.label ?? undefined, img: i.img,
    note: i.prev_fields?.note || undoNote, last_comp: i.prev_fields?.last_comp ?? null, url: i.prev_fields?.url ?? null,
  })), { undo_of: run.id, note: undoNote });
  const sub = await submitRun(id, input.actor);
  // approve the restoring estimates right away
  const session = await openAdminSession(input.actor.session_user_id);
  const back = await q<{ item_id: string; new_ev: string; last_comp: string | null; comp_url: string | null; submit_record: EstimateRecord | null }>(
    `SELECT item_id, new_ev, last_comp, comp_url, submit_record FROM ev_run_items WHERE run_id=$1 AND status='submitted'`, [id]
  );
  let ar;
  try {
    ar = await pool(back, config.writeConcurrency(), (b) => approveEv(session, b.item_id, b.submit_record, Number(b.new_ev), { note: undoNote + input.actor.note_suffix, last_comp: b.last_comp == null ? null : Number(b.last_comp), url: b.comp_url }));
  } finally {
    await session.revoke();
  }
  await q(
    `UPDATE ev_run_items AS i SET status=t.st, approve_http=t.http, approve_error=t.err, approved_by=$2, approved_at=now(), updated_at=now()
     FROM unnest($3::text[], $4::text[], $5::int[], $6::text[]) AS t(item_id, st, http, err) WHERE i.run_id=$1 AND i.item_id=t.item_id`,
    [id, input.actor.name, back.map((b) => b.item_id), ar.map((r) => (r.ok ? "restored" : "approve_failed")), ar.map((r) => r.status), ar.map((r) => r.error ?? null)]
  );
  const restored = back.filter((_, i) => ar[i].ok).map((b) => b.item_id);
  const status = restored.length === all.length ? "completed" : "partial";
  await q(`UPDATE ev_runs SET status=$2, result=$3 WHERE id=$1`, [id, status, JSON.stringify({ restored: restored.length, submit_failed: sub.failed, approve_failed: back.length - restored.length, skipped_no_previous_value: skipped })]);
  if (status === "completed") await q(`UPDATE ev_runs SET status='undone' WHERE id=$1`, [run.id]);
  return { undo_run_id: id, undid: run.id, status, restored_ids: restored, restored: restored.length, failed: all.length - restored.length - skipped.length, skipped_no_previous_value: skipped };
}

// ============ read-only ============
export async function verifyRun(runId: string) {
  const run = await loadRun(runId);
  const items = await q<{ item_id: string; new_ev: string }>(`SELECT item_id, new_ev FROM ev_run_items WHERE run_id=$1 AND status IN ('approved','restored')`, [runId]);
  if (!items.length) return { run_id: runId, checked: 0, note: run.action === "approve" ? "No approved items." : "Only approved values show in the warehouse. Verify the approve run." };
  // look the cards back up in 4131 by AC number (the first part of each label)
  const acs = (await q<{ label: string | null; item_id: string }>(`SELECT label, item_id FROM ev_run_items WHERE run_id=$1`, [runId]))
    .map((r) => ({ item_id: r.item_id, ac: (r.label || "").split(" · ")[0] })).filter((r) => /^\d{5,12}$/.test(r.ac));
  const found = acs.length ? await queryCards({ ac_number: acs.map((a) => a.ac) }) : [];
  const now = new Map(found.map((r) => [r.item_id, r.estimated_value]));
  const notYet = items.filter((i) => !sameEv(now.get(i.item_id), Number(i.new_ev)));
  return {
    run_id: runId, checked: items.length, confirmed_in_warehouse: items.length - notYet.length, not_yet_visible: notYet.length,
    sample: notYet.slice(0, 20).map((i) => ({ item_id: i.item_id, expected: Number(i.new_ev), warehouse_now: now.get(i.item_id) ?? "not found" })),
    note: notYet.length ? "Snowflake may not have synced yet, or the card left warehouse scope. Re-check later." : "Every approved card shows the new value in the warehouse.",
  };
}

export async function getRun(runId: string) {
  const run = await loadRun(runId);
  const counts = await q(`SELECT status, count(*)::int AS n FROM ev_run_items WHERE run_id=$1 GROUP BY status`, [runId]);
  return { ...run, item_counts: counts };
}
export const getRunItems = (runId: string) =>
  q(`SELECT item_id, label, previous_ev, prev_source, new_ev, last_comp, note, status, http_status, error, estimate_id, approve_http, approve_error FROM ev_run_items WHERE run_id=$1 ORDER BY label`, [runId]);
export const listRuns = (limit = 20) =>
  q(`SELECT id, status, action, target_ev, note, requested_by, approved_by, admin_as, preview_count, staged_count, dry_run, undo_of, created_at, finished_at,
       (SELECT count(*)::int FROM ev_run_items i WHERE i.run_id=r.id) AS items
     FROM ev_runs r WHERE status <> 'draft' ORDER BY created_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)]);

export function summarizeEv(rows: CardRow[], target: number) {
  const before = rows.reduce((s, r) => s + (r.estimated_value ?? 0), 0);
  const after = rows.length * target;
  const big = rows.filter((r) => {
    const p = pctChange(r.estimated_value, target);
    return r.estimated_value == null || r.estimated_value <= 0 || (p != null && Math.abs(p) > config.bigChangePct());
  });
  const vals = rows.map((r) => r.estimated_value ?? 0).sort((a, b) => a - b);
  const count = (key: (r: CardRow) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r) ?? "(blank)", (m.get(key(r) ?? "(blank)") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, n]) => ({ value, count: n }));
  };
  return {
    matched: rows.length,
    target_ev: target,
    current_ev_low: vals[0] ?? null,
    current_ev_median: vals.length ? vals[Math.floor(vals.length / 2)] : null,
    current_ev_high: vals[vals.length - 1] ?? null,
    total_ev_before: r2(before),
    total_ev_after: r2(after),
    total_change: r2(after - before),
    going_up: rows.filter((r) => (r.estimated_value ?? 0) < target).length,
    going_down: rows.filter((r) => (r.estimated_value ?? 0) > target).length,
    big_changes: big.length,
    big_change_pct: config.bigChangePct(),
    by_card: count((r) => [r.set_name, r.player_name, r.parallel_name, r.grade].filter(Boolean).join(" · ")),
    sample: rows.slice(0, 10).map((r) => ({
      item_id: r.item_id,
      ac_number: r.ac_number,
      card: label(r),
      current_ev: r.estimated_value,
      new_ev: target,
      change_pct: pctChange(r.estimated_value, target),
      ev_age_days: r.ev_age_days,
    })),
  };
}

