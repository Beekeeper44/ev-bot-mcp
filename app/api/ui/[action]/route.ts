// JSON API for the EV Bot screen. Everything except sign-in/setup/invites needs a signed-in account.
import { config } from "@/lib/config";
import { type CardFilters, type PostFilters } from "@/lib/metabase";
import { runSelection, undoRun, listRuns, getRunItems, submitTasks, approvalQueue, approveQueued, withdrawQueued, recentSubmissions, type SubmitItem } from "@/lib/runs";
import { listTasks, filterTasks } from "@/lib/tasks";
import { findCopies } from "@/lib/copies";
import { listPrompts, addPrompt, renamePrompt, deletePrompt } from "@/lib/ui";
import { smartSearch } from "@/lib/search";
import { readTarget } from "@/lib/target";
import { parsePasted, searchPasted } from "@/lib/paste";
import { readTags, hasTag } from "@/lib/tagfilter";
import { titleSearch, looksLikeTcg } from "@/lib/title";
import { readEvRange } from "@/lib/evrange";
import { lookupCardLadder } from "@/lib/cardladder";
import { queryCards } from "@/lib/metabase";
import { probeEv, openAdminSession, liveEv, type LiveEv } from "@/lib/admin";
import {
  can, actorOf, currentUser, sessionCookie, clearCookie, signIn, needsSetup, setupFirstAdmin, inviteInfo, acceptInvite,
  changePassword, listUsers, addUser, updateUser, relinkAdmin, testAdminLink, resetInvite, newMcpKey, revokeMcpKey, type User, type Role,
} from "@/lib/users";

export const maxDuration = 300;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (e: unknown, status = 400) => json({ error: e instanceof Error ? e.message : String(e) }, status);
const origin = (req: Request) => new URL(req.url).origin;
const forbid = (u: User, role: Role) => (can(u, role) ? null : json({ error: `This needs ${role} access. You're a ${u.role}.` }, 403));

type Ctx = { params: Promise<{ action: string }> };

function me(u: User, req: Request) {
  let shared = !u.admin_user_id;
  try { shared = actorOf(u).attribution === "shared"; } catch { /* not linked, no fallback */ }
  return {
    user: u.name, email: u.email, role: u.role, id: u.id,
    can_write: can(u, "editor") && (!shared || config.sharedSessionFallback()),
    can_approve: can(u, "approver"),
    tasks_configured: config.evTasksCardId() > 0,
    is_admin: can(u, "admin"),
    admin_link: shared ? (config.sharedSessionFallback() ? "shared" : "missing") : "own",
    has_mcp_key: u.has_mcp_key,
    mcp_base: `${origin(req)}/api/mcp?key=`,
    dry_run: config.dryRun(), max_items_per_run: config.maxItemsPerRun(), full_access: config.fullAccess(), big_change_pct: config.bigChangePct(),
    min_ev: config.minEv(), max_ev: config.maxEv(), default_note: config.defaultNote(), approve: true, approve_note: config.evApproveNote(),
  };
}

export async function GET(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  try {
    if (action === "config") return json({ needs_setup: await needsSetup() });
    const u = await currentUser(req);
    if (!u) return json({ error: "signed_out" }, 401);
    switch (action) {
      case "me":
        return json(me(u, req), 200, { "Set-Cookie": sessionCookie(u.id) }); // refresh: stays signed in while used
      case "runs":
        return json(await listRuns(25));
      case "prompts":
        return json(await listPrompts());
      case "run-items":
        return json(await getRunItems(new URL(req.url).searchParams.get("id") || ""));
      case "tasks": {
        const tasks = await listTasks();
        return json({
          pulled_at: new Date().toISOString(),
          tasks: tasks.map((r) => ({
            item_id: r.item_id, ac: r.ac_number ?? "", cert: r.cert_number ?? "", set_name: r.set_name ?? "", player_name: r.player_name ?? "(no player)",
            parallel_name: r.parallel_name, set_number: r.set_number, insert: r.insert, grade: (r.grade ?? "").toLowerCase(), sport: (r.sport ?? "").toLowerCase(),
            ev: r.estimated_value, last_comp: r.last_comp, ev_date: r.ev_date, img: r.front_slab_picture_url, card_url: r.card_url, status: r.item_status,
            requested_at: r.requested_at, extra: r.task_extra, pending: r.pending ?? null,
          })),
        });
      }
      case "approvals":
        return json(await approvalQueue());
      case "users":
        return forbid(u, "admin") ?? json(await listUsers());
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return fail(e, 500);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const str = (k: string) => String(body[k] ?? "");

  // ---- no sign-in needed ----
  try {
    switch (action) {
      case "setup": {
        const u = await setupFirstAdmin({ email: str("email"), name: str("name"), password: str("password"), code: str("code") });
        return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
      }
      case "login": {
        const u = await signIn(str("email"), str("password"));
        return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
      }
      case "logout":
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
      case "invite-info":
        return json(await inviteInfo(str("token")));
      case "invite-accept": {
        const u = await acceptInvite(str("token"), str("password"));
        return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
      }
    }
  } catch (e) {
    return fail(e, action === "login" ? 401 : 400);
  }

  const u = await currentUser(req).catch(() => null);
  if (!u) return json({ error: "signed_out" }, 401);

  try {
    switch (action) {
      case "find": {
        // EV range: typed ("5000 or more ev", "$5k+", "under $100") and/or the range tab picked on screen
        const rng = readEvRange(str("text"));
        const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
        // a range typed in the request wins; otherwise the range tab picked on screen
        const typed = rng.min != null || rng.max != null;
        const mins = [typed ? rng.min : num(body.min_ev)].filter((x): x is number => x != null);
        const maxs = [typed ? rng.max : num(body.max_ev)].filter((x): x is number => x != null);
        const evMin = mins.length ? Math.max(...mins) : null, evMax = maxs.length ? Math.min(...maxs) : null;
        const rangeF = { ...(evMin != null ? { min_estimated_value: evMin } : {}), ...(evMax != null ? { max_estimated_value: evMax } : {}) };
        const { target, rest } = readTarget(rng.rest);
        if (body.scope === "tasks") {
          // cards waiting for an estimate, narrowed by whatever was typed (blank = all of them)
          const t0 = Date.now();
          const all = await listTasks();
          const f = filterTasks(all, rest);
          return json({
            scope: "tasks", target_ev: target, task_total: all.length,
            parsed: { filters: f.display, post_filters: f.base ? { only_base: true } : {} },
            has_filter: true, queries: [], ms: Date.now() - t0, total: f.rows.length, missing: f.missing,
            cards: f.rows.map((r) => ({
              item_id: r.item_id, ac: r.ac_number ?? "", cert: r.cert_number ?? "", sport: (r.sport ?? "").toLowerCase(),
              set_name: r.set_name ?? "", player_name: r.player_name ?? "(no player)", parallel_name: r.parallel_name, set_number: r.set_number,
              grading_company: (r.grading_company ?? "").toLowerCase(), grade: (r.grade ?? "").toLowerCase(), ev: r.estimated_value ?? 0,
              last_comp: r.last_comp, img: r.front_slab_picture_url, card_url: r.card_url, insert: r.insert, parallel_total: r.parallel_total,
              status: r.item_status, ev_date: r.ev_date, ev_age_days: r.ev_age_days, ev_source: r.ev_source, bin: r.storage_bin_id, slot: r.storage_bin_slot,
              requested_at: r.requested_at, pending: r.pending ?? null,
            })),
          });
        }
        // pasted card rows (set · insert · player + # · parallel · grade) search exactly; anything else is a typed request
        const pasted = parsePasted(rest);
        const tg = pasted ? { tags: [], untagged: false, rest } : readTags(rest);
        // tag only ("tag sd_wemby_grail"): pull the cards with that tag straight from 4131
        const tagOnly = !pasted && (tg.tags.length > 0) && !tg.rest;
        // a range on its own (a tab picked, nothing typed): every warehouse card in that range
        const rangeOnly = !pasted && !tg.tags.length && !tg.untagged && !tg.rest.trim() && Object.keys(rangeF).length > 0;
        const r0 = rangeOnly
          ? await (async () => { const t0 = Date.now(); const rows = await queryCards(rangeF);
              return { parsed: { filters: {}, post_filters: {} }, has_filter: true, queries: [rangeF], ms: Date.now() - t0, rows, missing: [] as string[] }; })()
          : tagOnly
          ? await (async () => { const t0 = Date.now(); const rows = (await Promise.all(tg.tags.map((t) => queryCards({ tag: t, ...rangeF })))).flat();
              return { parsed: { filters: {}, post_filters: {} }, has_filter: true, queries: tg.tags.map((t) => ({ tag: t })), ms: Date.now() - t0, rows: [...new Map(rows.map((x) => [x.item_id, x])).values()], missing: [] as string[] }; })()
          : pasted
          ? await (async () => { const t0 = Date.now(); const p = await searchPasted(pasted);
              return { parsed: { filters: p.display, post_filters: {} }, has_filter: true, queries: p.queries, ms: Date.now() - t0, rows: p.rows, missing: p.missing }; })()
          : await (async () => {
              // Pokémon / One Piece titles: title search first; anything else: the Tag Bot search, with title search as the fallback
              const asTitle = async () => { const x = await titleSearch(tg.rest); return x && x.rows.length ? { parsed: { filters: x.display, post_filters: {} }, has_filter: true, queries: x.queries, ms: x.ms, rows: x.rows, missing: x.missing } : null; };
              if (looksLikeTcg(tg.rest)) { const x = await asTitle(); if (x) return x; }
              const r1 = await smartSearch(tg.rest, rangeF).catch(() => null);
              if (r1 && r1.rows.length) return r1;
              return (await asTitle()) ?? r1 ?? (await smartSearch(tg.rest, rangeF));
            })();
        // tag filter on top of whatever else was typed
        const tagRows = r0.rows.filter((x) => hasTag(x.tag, tg.tags) && (!tg.untagged || !x.tag)
          && (evMin == null || (x.estimated_value ?? 0) >= evMin) && (evMax == null || (x.estimated_value ?? 0) <= evMax)
          // a year on its own ("2020 basketball") holds results to sets from that year
          && (!rng.year || pasted != null || String(x.set_name ?? "").includes(rng.year)));
        const r = { ...r0, rows: tagRows, queries: r0.queries,
          parsed: { ...r0.parsed, filters: { ...(r0.parsed?.filters ?? {}), ...rangeF, ...(rng.year && !pasted ? { year: rng.year } : {}), ...(tg.tags.length ? { tag: tg.tags.join(" or ") } : {}), ...(tg.untagged ? { tag: "none (untagged)" } : {}) } },
          has_filter: r0.has_filter || tg.tags.length > 0 || tg.untagged };
        const LIMIT = 6000; // the screen pages through these 200 at a time
        // submitted through ev-bot in the last 7 days (any teammate) — marked in the versions list
        const recent = await recentSubmissions(r.rows.slice(0, LIMIT).map((x) => x.item_id)).catch(() => new Map());
        return json({
          target_ev: target,
          ev_range: { min: evMin, max: evMax, typed },
          parsed: r.parsed,
          has_filter: r.has_filter,
          queries: r.queries,
          ms: r.ms,
          total: r.rows.length,
          missing: r.missing,
          cards: r.rows.slice(0, LIMIT).map((r) => ({
            item_id: r.item_id, ac: r.ac_number ?? "", cert: r.cert_number ?? "", sport: (r.sport ?? "").toLowerCase(),
            set_name: r.set_name ?? "", player_name: r.player_name ?? "(no player)", parallel_name: r.parallel_name,
            grading_company: (r.grading_company ?? "").toLowerCase(), grade: (r.grade ?? "").toLowerCase(),
            ev: r.estimated_value ?? 0, tag: r.tag, img: r.front_slab_picture_url, card_url: r.card_url,
            insert: r.insert, parallel_total: r.parallel_total, status: r.item_status,
            ev_date: r.ev_date, ev_age_days: r.ev_age_days, ev_source: r.ev_source, order_number: r.order_number,
            times_sold_back: r.times_sold_back, bin: r.storage_bin_id, slot: r.storage_bin_slot,
            purchase_cost: r.purchase_cost, purchase_location: r.purchase_location, po_number: r.po_number, set_number: r.set_number,
            last_comp: r.last_comp,
            recent: recent.get(r.item_id) ?? null,
          })),
        });
      }
      case "apply":
        return (
          forbid(u, "editor") ??
          json(
            await runSelection({
              filters: (body.filters ?? {}) as CardFilters,
              post_filters: (body.post_filters ?? {}) as PostFilters,
              target_ev: body.target_ev === null || body.target_ev === undefined || body.target_ev === "" ? null : Number(body.target_ev),
              values: (body.values ?? undefined) as Record<string, { ev?: number | null; last_comp?: number | null }> | undefined,
              note: str("note"),
              last_comp: body.last_comp === null || body.last_comp === undefined || body.last_comp === "" ? null : Number(body.last_comp),
              url: body.url ? String(body.url) : null,
              item_ids: Array.isArray(body.item_ids) ? (body.item_ids as string[]) : [],
              queries: Array.isArray(body.queries) ? (body.queries as CardFilters[]) : undefined,
              dry_run: body.dry_run === true,
              actor: actorOf(u),
            })
          )
        );
      case "submit-tasks":
        return forbid(u, "editor") ?? json(await submitTasks({ items: (Array.isArray(body.items) ? body.items : []) as SubmitItem[], actor: actorOf(u), dry_run: body.dry_run === true, include_copies: body.include_copies === true }));
      case "copies": {
        // preview: identical warehouse copies of the given task cards
        const ids = new Set((body.item_ids as string[]) ?? []);
        const tasks = (await listTasks()).filter((t) => ids.has(t.item_id));
        const m = await findCopies(tasks);
        return json(Object.fromEntries([...m].map(([k, rows]) => [k, rows.map((r) => ({ item_id: r.item_id, ac: r.ac_number, ev: r.estimated_value, grade: r.grade, img: r.front_slab_picture_url, number_checked: (r as { number_checked?: boolean }).number_checked !== false }))])));
      }
      case "approve":
        return forbid(u, "approver") ?? json(await approveQueued({ item_ids: body.all === true ? "all" : ((body.item_ids as string[]) ?? []), note: str("note") || undefined, actor: actorOf(u), dry_run: body.dry_run === true }));
      case "withdraw":
        return forbid(u, "editor") ?? json(await withdrawQueued({ item_ids: (body.item_ids as string[]) ?? [], actor: actorOf(u) }));
      case "undo":
        return forbid(u, "editor") ?? json(await undoRun({ run_id: str("run_id"), confirm: true, actor: actorOf(u) }));
      case "cl-value":
        // Card Ladder value for a cert (placeholder until the real API is wired)
        return json(await lookupCardLadder({ cert: str("cert"), grader: str("grader") }));
      case "ev-live": {
        // live EV history from admin for the cards on screen (Snowflake can lag): newest approved / recomp + anything waiting
        const ids = [...new Set(((body.item_ids as string[]) ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 100);
        if (!ids.length) return json({});
        const session = await openAdminSession(actorOf(u).session_user_id);
        try {
          const out: Record<string, LiveEv | null> = {};
          let i = 0;
          await Promise.all(Array.from({ length: 8 }, async () => {
            while (i < ids.length) { const id = ids[i++]; out[id] = (await liveEv(session, id)) ?? null; }
          }));
          return json(out);
        } finally {
          await session.revoke();
        }
      }
      case "probe":
        // setup check, run as the signed-in admin's own admin account
        return forbid(u, "admin") ?? json(await probeEv(str("item_id"), actorOf(u).session_user_id));
      case "password":
        await changePassword(u.id, str("current"), str("next"));
        return json({ ok: true });
      case "mcp-key":
        return json({ url: `${origin(req)}/api/mcp?key=${await newMcpKey(u.id)}` });
      case "mcp-key-revoke":
        await revokeMcpKey(u.id);
        return json({ ok: true });
      case "prompts":
        return json(await addPrompt(str("text"), u.name, body.name as string | undefined));
      case "prompts-rename":
        await renamePrompt(str("id"), str("name"));
        return json({ ok: true });
      case "prompts-delete":
        await deletePrompt(str("id"));
        return json({ ok: true });

      // ---- user management (admins) ----
      case "users-add": {
        const f = forbid(u, "admin");
        if (f) return f;
        const r = await addUser({ email: str("email"), name: str("name"), role: str("role") as Role, admin_user_id: str("admin_user_id") || null }, u);
        return json({ ...r, invite_url: `${origin(req)}/?invite=${r.invite_token}` });
      }
      case "users-update": {
        const f = forbid(u, "admin");
        if (f) return f;
        await updateUser(str("id"), {
          role: (body.role as Role) || undefined,
          active: typeof body.active === "boolean" ? body.active : undefined,
          admin_user_id: body.admin_user_id === undefined ? undefined : String(body.admin_user_id ?? ""),
        }, u);
        return json({ ok: true });
      }
      case "users-relink":
        return forbid(u, "admin") ?? json(await relinkAdmin(str("id"), str("email") || undefined));
      case "users-test":
        return forbid(u, "admin") ?? json(await testAdminLink(str("id")));
      case "users-invite": {
        const f = forbid(u, "admin");
        if (f) return f;
        const r = await resetInvite(str("id"));
        return json({ invite_url: `${origin(req)}/?invite=${r.invite_token}` });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return fail(e);
  }
}
