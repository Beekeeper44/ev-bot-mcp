import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { config } from "@/lib/config";
import { queryCards } from "@/lib/metabase";
import { probeEv } from "@/lib/admin";
import { previewRun, stageRun, goLive, undoRun, verifyRun, getRun, listRuns, summarizeEv, submitTasks, approvalQueue, approveQueued, withdrawQueued } from "@/lib/runs";
import { listTasks } from "@/lib/tasks";
import { userByMcpKey, actorOf, can, type User } from "@/lib/users";

export const maxDuration = 300;

const list = z.union([z.string(), z.array(z.string())]);
const filters = z
  .object({
    sport: z.string().optional(),
    set_name: list.optional().describe("Contains-match. A list matches any of them."),
    player_name: list.optional().describe("Player or Pokémon. Several → pass a list; a card matches ANY."),
    parallel_name: list.optional(),
    grading_company: z.string().optional().describe("e.g. psa, bgs, sgc"),
    grade: list.optional().describe("'company grade', e.g. 'psa 10'"),
    set_number: list.optional().describe("Card number printed on the card, e.g. 'US189'. Exact match."),
    min_estimated_value: z.number().optional().describe("Filter on CURRENT value, dollars"),
    max_estimated_value: z.number().optional().describe("Filter on CURRENT value, dollars"),
    tag: z.string().optional().describe("Contains-match on the card's current tag"),
    cert_number: list.optional(),
    ac_number: list.optional(),
    min_ev_age_days: z.number().optional(),
    max_ev_age_days: z.number().optional(),
    min_times_sold_back: z.number().optional(),
  })
  .describe("Filters passed to Metabase question 4131 (warehouse cards). For a recomp, narrow to ONE exact card: set, player, card number, parallel, grading company and grade.");
const postFilters = z
  .object({
    only_base: z.boolean().optional().describe("Only cards with no parallel"),
    only_untagged: z.boolean().optional(),
    current_tag_exact: z.string().optional(),
  })
  .optional();

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
const safe =
  <A,>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return text(await fn(a));
    } catch (e) {
      return { ...text({ error: e instanceof Error ? e.message : String(e) }), isError: true };
    }
  };

// Each person has their own connector URL (?key=evk_…, made on the screen under "My account").
// The key decides who the run is by and which admin account writes; tool arguments can't change that.
const makeMcp = (user: User) => createMcpHandler(
  (server) => {
    const actor = () => actorOf(user);
    server.tool(
      "find_cards_ev",
      "Read-only. Searches warehouse cards (question 4131) and shows what setting them to target_ev would do: count, current low/median/high, total before/after, cards going up/down, big swings, and a sample.",
      { filters, post_filters: postFilters, target_ev: z.number().describe("New estimated value in dollars") },
      safe(async ({ filters, post_filters, target_ev }) => summarizeEv(await queryCards(filters, post_filters ?? {}), target_ev))
    );

    server.tool(
      "preview_ev_run",
      "Step 1 of 3. Drafts a bulk estimated-value update: every matched card gets target_ev, with the note (required) and optional last comp / URL written to admin's Estimate value form. Submitting puts the cards in the Approve queue; approving (approve_ev_queue) makes them live. Writes nothing now. Show the readback (count, current range, total change, big swings, any names with no match) and ask the user to confirm the count. If by_card shows more than one distinct card, point it out: all of them get the same value.",
      {
        filters,
        post_filters: postFilters,
        target_ev: z.number().describe("Dollars, e.g. 300 or 85.5"),
        note: z.string().optional().describe("Submit note (admin requires one). Defaults to EV_DEFAULT_NOTE ('mcp done')."),
        last_comp: z.number().optional().describe("Last comp sale price in dollars. Required for any card that has no last comp yet; those cards fail at submit without it. Ask the user."),
        url: z.string().optional().describe("Optional: comp link (admin's URL field)"),
      },
      safe((a) => previewRun({ ...a, note: a.note || config.defaultNote(), actor: actor() }))
    );

    server.tool(
      "stage_ev_run",
      "Step 2 of 3 (approval #1). Only after the user approves the preview and states the count. Re-checks matches and freezes the card list with each card's current value (for undo). Writes nothing.",
      { run_id: z.string(), confirm_count: z.number().int() },
      safe((a) => stageRun({ ...a, actor: actor() }))
    );

    server.tool(
      "submit_ev_run",
      "Step 3 of 3. WRITES TO ADMIN: submits the frozen cards as estimates (status 'done' in admin). They then wait in the Approve queue; use approve_ev_queue to make them live. Only after the user explicitly says submit on this run_id.",
      { run_id: z.string(), confirm: z.boolean() },
      safe((a) => goLive({ ...a, actor: actor() }))
    );

    server.tool(
      "undo_ev_run",
      "WRITES TO ADMIN (approver). Undoes an APPROVE run: puts every card back to the value it had before (submits + approves the old value). Only when the user explicitly asks.",
      { run_id: z.string(), confirm: z.boolean() },
      safe((a) => undoRun({ ...a, actor: actor() }))
    );

    server.tool(
      "list_ev_tasks",
      "Read-only. Every card waiting for an estimated value (the Estimate tasks queue), with current value and whether EV Bot already submitted it.",
      { search: z.string().optional().describe("Optional text to narrow by player / set / AC / cert"), limit: z.number().int().optional() },
      safe(async ({ search, limit }) => {
        let t = await listTasks();
        if (search) { const w = search.toLowerCase(); t = t.filter((r) => [r.player_name, r.set_name, r.parallel_name, r.ac_number, r.cert_number, r.set_number].some((v) => v && String(v).toLowerCase().includes(w))); }
        return { total: t.length, waiting_for_approval: t.filter((r) => r.pending).length, tasks: t.slice(0, limit ?? 100).map((r) => ({ item_id: r.item_id, ac: r.ac_number, card: [r.set_name, r.player_name, r.set_number ? "#" + r.set_number : "", r.parallel_name, r.grade].filter(Boolean).join(" · "), current_ev: r.estimated_value, current_last_comp: r.last_comp, last_comp_required: r.last_comp == null, requested_at: r.requested_at, submitted: r.pending ?? undefined })) };
      })
    );

    server.tool(
      "submit_ev_tasks",
      "WRITES TO ADMIN (submit only). Submits estimates for cards in the task queue, each with its own value. Only after the user confirms the list. They land in the Approve queue.",
      {
        items: z.array(z.object({
          item_id: z.string(),
          ev: z.number().describe("Dollars"),
          last_comp: z.number().optional().describe("Required when the card has no last comp yet (list_ev_tasks shows current_last_comp)"),
          url: z.string().optional(),
          note: z.string().optional().describe("Defaults to EV_DEFAULT_NOTE ('mcp done')"),
        })).min(1),
        include_copies: z.boolean().optional().describe("Also give every identical copy in the warehouse (same set, player, card #, parallel, grade) the same value; replaces their existing EV. Default true unless the user says otherwise."),
      },
      safe(({ items, include_copies }) => submitTasks({ items: items.map((i) => ({ ...i, note: i.note || config.defaultNote() })), actor: actor(), include_copies }))
    );

    server.tool("list_approval_queue", "Read-only. Cards submitted and waiting for approval: value, last comp, note, who submitted.", {}, safe(async () => {
      const rows = await approvalQueue();
      return { total: rows.length, cards: rows.slice(0, 200) };
    }));

    server.tool(
      "approve_ev_queue",
      "WRITES TO ADMIN (approver only). Approves submitted cards so their values go live, with note EV_APPROVE_NOTE ('mcp approved'). Pass all=true for the whole queue or item_ids. Only after the user explicitly says approve and has seen the count.",
      { all: z.boolean().optional(), item_ids: z.array(z.string()).optional(), note: z.string().optional() },
      safe(({ all, item_ids, note }) => approveQueued({ item_ids: all ? "all" : item_ids ?? [], note, actor: actor() }))
    );

    server.tool(
      "withdraw_from_queue",
      "Takes cards out of the Approve queue without approving (their submitted estimate never goes live).",
      { item_ids: z.array(z.string()).min(1) },
      safe(({ item_ids }) => withdrawQueued({ item_ids, actor: actor() }))
    );

    server.tool("verify_ev_run", "Read-only. Checks Snowflake (via 4131) shows the new value on every card a run wrote.", { run_id: z.string() }, safe(({ run_id }) => verifyRun(run_id)));
    server.tool("get_ev_run", "Read-only. One run's record and item counts.", { run_id: z.string() }, safe(({ run_id }) => getRun(run_id)));
    server.tool("list_ev_runs", "Read-only. Recent EV runs, newest first.", { limit: z.number().int().optional() }, safe(({ limit }) => listRuns(limit ?? 20)));

    server.tool(
      "check_ev_endpoint",
      "Read-only setup check. Mints a session, GETs one card from admin, lists the fields that look like the estimated value, and shows the exact write call that would be sent. Run this before turning DRY_RUN off.",
      { item_id: z.string().describe("An ITEM_ID from question 4131") },
      safe(async ({ item_id }) => {
        if (!can(user, "admin")) throw new Error("check_ev_endpoint is for EV Bot admins.");
        return probeEv(item_id, actor().session_user_id);
      })
    );

    server.tool(
      "get_settings",
      "Read-only. DRY_RUN, caps, value limits and the configured EV write call.",
      {},
      safe(async () => ({
        you: { name: user.name, role: user.role, writes_as: user.admin_user_id ? "your own admin account" : "shared admin account", approves: can(user, "approver") },
        dry_run: config.dryRun(),
        max_items_per_run: config.maxItemsPerRun(),
        write_concurrency: config.writeConcurrency(),
        min_ev: config.minEv(),
        max_ev: config.maxEv(),
        big_change_pct: config.bigChangePct(),
        estimate_call: { method: "POST", path: config.evPath(), submit_status: config.evSubmitStatus(), approve_status: config.evApproveStatus(), approve_note: config.evApproveNote(), card_path: config.evCardPath(), history_path: config.evHistoryPath() || null },
        default_note: config.defaultNote(),
        metabase_card_id: config.metabaseCardId(),
      }))
    );
  },
  { serverInfo: { name: "ev-bot", version: "0.1.0" } },
  { basePath: "/api", maxDuration: 300, disableSse: true }
);

async function handler(req: Request) {
  const user = await userByMcpKey(new URL(req.url).searchParams.get("key") || "").catch(() => null);
  if (!user) return new Response("Unauthorized", { status: 401 });
  return makeMcp(user)(req);
}

export { handler as GET, handler as POST, handler as DELETE };
