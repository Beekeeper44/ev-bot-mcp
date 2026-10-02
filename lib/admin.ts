// Writes estimated values to admin exactly the way the admin "Estimate value" page does:
//   POST /admin/estimate-value  { cardId, cardTypeId, parallelId, grade, gradingCompany,
//     estimatedValueCents, lastCompValueCents, gradingTaskStatus, note, url, startedAt, finishedAt }
// Submit sends gradingTaskStatus "done"; Approve sends "approved" with the submitted record's fields.
// Auth: a short-lived SuperTokens session minted server-side for the person doing the run.
import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import { config, type EvExtras } from "./config";

let initialized = false;
export function initSupertokens() {
  init();
}
function init() {
  if (initialized) return;
  supertokens.init({
    framework: "custom",
    supertokens: { connectionURI: config.supertokensUri(), apiKey: config.supertokensApiKey() },
    appInfo: {
      appName: "ev-bot",
      apiDomain: "https://api.arenaclub.com", // matches the "iss" on admin sessions
      apiBasePath: "/st/auth",
      websiteDomain: config.adminOrigin(),
    },
    recipeList: [Session.init()],
  });
  initialized = true;
}

export type AdminSession = { accessToken: string; revoke: () => Promise<void> };

/** Mints a short-lived admin session for this admin user (the person doing the run). */
export async function openAdminSession(adminUserId: string = config.sessionUserId()): Promise<AdminSession> {
  init();
  const session = await Session.createNewSessionWithoutRequestResponse(
    config.sessionTenantId(),
    supertokens.convertToRecipeUserId(adminUserId),
    config.sessionExtraPayload() ?? {},
    {},
    true
  );
  const { accessToken } = session.getAllSessionTokensDangerously();
  return {
    accessToken,
    revoke: async () => {
      try {
        await session.revokeSession();
      } catch {
        /* best effort */
      }
    },
  };
}

function headers(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Cookie: `sAccessToken=${accessToken}`,
    rid: "anti-csrf",
    "st-auth-mode": "cookie",
    Origin: config.adminOrigin(),
    Referer: `${config.adminOrigin()}/`,
  };
}

const ID_RE = /^[0-9a-f-]{36}$/i;
const url = (template: string, id = "") => `${config.adminApiUrl()}${template.replace("{id}", id)}`;
const cents = (dollars: number) => Math.round(dollars * 100);
const dollars = (c: unknown): number | null => (c === null || c === undefined || c === "" || !Number.isFinite(Number(c)) ? null : Number(c) / 100);
const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

/** What admin holds right now (dollars), saved before writing so undo can put it back. */
export type EvSnapshot = { ev: number | null; last_comp: number | null; url: string | null; note: string | null };
/** The card fields every estimate record carries. */
export type CardContext = { cardTypeId: string; parallelId: string | null; grade: unknown; gradingCompany: string };
/** An estimate record as admin returns it. */
export type EstimateRecord = Record<string, unknown> & { id?: string; cardId?: string };

export type WriteResult = {
  ok: boolean;
  status: number;
  returnedEv?: number | null;
  error?: string;
  submitId?: string | null;
  record?: EstimateRecord;
};

const CTX_KEYS = ["cardTypeId", "parallelId", "grade", "gradingCompany"] as const;

/** Finds a key anywhere in a JSON object (first match, breadth-first, a few levels deep). */
function findKey(obj: unknown, key: string): unknown {
  const queue: [unknown, number][] = [[obj, 0]];
  while (queue.length) {
    const [o, d] = queue.shift()!;
    if (!o || typeof o !== "object" || d > 4) continue;
    if (!Array.isArray(o) && key in (o as Record<string, unknown>)) return (o as Record<string, unknown>)[key];
    for (const v of Object.values(o as Record<string, unknown>)) if (v && typeof v === "object") queue.push([v, d + 1]);
  }
  return undefined;
}

function contextFrom(src: unknown): Partial<CardContext> {
  const out: Record<string, unknown> = {};
  const top = src && typeof src === "object" ? (src as Record<string, unknown>) : {};
  for (const k of CTX_KEYS) {
    // prefer the record's own top-level field; the card record calls the grade "overall"
    const v = k in top ? top[k] : k === "grade" && "overall" in top ? top.overall : findKey(src, k);
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<CardContext>;
}

/** cardTypeId / parallelId / grade / gradingCompany for a card, from admin's card record. */
export async function cardContext(session: AdminSession, itemId: string): Promise<CardContext> {
  const res = await fetch(url(config.evCardPath(), itemId), { method: "GET", headers: headers(session.accessToken) });
  if (!res.ok) throw new Error(`Couldn't load the card from admin (${res.status}).`);
  const ctx = contextFrom(await res.json());
  const missing = CTX_KEYS.filter((k) => k !== "parallelId" && (ctx as Record<string, unknown>)[k] === undefined);
  if (missing.length) throw new Error(`The card record has no ${missing.join(", ")}. Set EV_CARD_PATH to a call that returns them.`);
  return { cardTypeId: String(ctx.cardTypeId), parallelId: (ctx.parallelId as string) ?? null, grade: ctx.grade, gradingCompany: String(ctx.gradingCompany) };
}

/** The card's estimate records, newest first (same search admin's page runs). */
export async function estimateHistory(session: AdminSession, itemId: string): Promise<EstimateRecord[] | undefined> {
  if (!config.evHistoryPath() || !ID_RE.test(itemId)) return undefined;
  try {
    const res = await fetch(url(config.evHistoryPath(), itemId), {
      method: "POST",
      headers: headers(session.accessToken),
      body: JSON.stringify({ where: { cardId: { equals: itemId } }, limit: 20, offset: 0, orderBy: "finishedAt", orderDirection: "DESC" }),
    });
    if (!res.ok) return undefined;
    const j = await res.json();
    const list: EstimateRecord[] = Array.isArray(j) ? j : (["data", "items", "results", "rows", "records", "estimateValues"].map((k) => j?.[k]).find(Array.isArray) ?? []);
    return list.filter((r) => !r.cardId || r.cardId === itemId);
  } catch {
    return undefined;
  }
}

const recDate = (r: EstimateRecord) => String(r.finishedAt ?? r.createdAt ?? "");
const byNewest = (a: EstimateRecord, b: EstimateRecord) => recDate(b).localeCompare(recDate(a));

/** What's live for the card: its newest approved / skip-verify recomp estimate. undefined = couldn't read. */
export async function readEv(session: AdminSession, itemId: string): Promise<EvSnapshot | undefined> {
  const mine = await estimateHistory(session, itemId);
  if (!mine) return undefined;
  const live = mine.filter((r) => config.evLiveStatuses().includes(String(r.gradingTaskStatus))).sort(byNewest);
  const pick = live[0] ?? [...mine].sort(byNewest)[0];
  if (!pick) return { ev: null, last_comp: null, url: null, note: null };
  return { ev: dollars(pick.estimatedValueCents), last_comp: dollars(pick.lastCompValueCents), url: str(pick.url), note: str(pick.note) };
}

/** For the screen: the card's live estimate (newest approved / skip-verify recomp) and any newer one still waiting. */
export type LiveEv = {
  live: { ev: number | null; last_comp: number | null; at: string; status: string; note: string | null } | null;
  waiting: { ev: number | null; last_comp: number | null; at: string; status: string } | null;
};
export async function liveEv(session: AdminSession, itemId: string): Promise<LiveEv | undefined> {
  const mine = await estimateHistory(session, itemId);
  if (!mine) return undefined;
  const sorted = [...mine].sort(byNewest);
  const isLive = (r: EstimateRecord) => config.evLiveStatuses().includes(String(r.gradingTaskStatus));
  const l = sorted.find(isLive);
  const newer = sorted.find((r) => !isLive(r) && (!l || recDate(r) > recDate(l)));
  return {
    live: l ? { ev: dollars(l.estimatedValueCents), last_comp: dollars(l.lastCompValueCents), at: recDate(l), status: String(l.gradingTaskStatus), note: str(l.note) } : null,
    waiting: newer ? { ev: dollars(newer.estimatedValueCents), last_comp: dollars(newer.lastCompValueCents), at: recDate(newer), status: String(newer.gradingTaskStatus) } : null,
  };
}

/** The exact body admin's page sends. */
export function evBody(itemId: string, ctx: CardContext, d: number, x: Partial<EvExtras>, status: string, startedAt?: string) {
  return {
    cardId: itemId,
    cardTypeId: ctx.cardTypeId,
    parallelId: ctx.parallelId,
    grade: ctx.grade,
    gradingCompany: ctx.gradingCompany,
    estimatedValueCents: cents(d),
    lastCompValueCents: x.last_comp == null ? null : cents(Number(x.last_comp)),
    gradingTaskStatus: status,
    note: (x.note ?? "").trim(),
    url: (x.url ?? "").trim(),
    startedAt: startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

async function postEstimate(session: AdminSession, body: Record<string, unknown>): Promise<WriteResult> {
  const json = JSON.stringify(body);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url(config.evPath()), { method: "POST", headers: headers(session.accessToken), body: json });
      if (res.ok) {
        let record: EstimateRecord | undefined;
        try {
          record = await res.json();
        } catch {
          /* non-JSON is fine */
        }
        return { ok: true, status: res.status, record, submitId: str(record?.id), returnedEv: record && "estimatedValueCents" in record ? dollars(record.estimatedValueCents) : undefined };
      }
      // retry only rate limits and server errors (a POST that failed with 5xx did not create a record)
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
    } catch (e) {
      if (attempt === 3) return { ok: false, status: 0, error: String(e) };
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return { ok: false, status: 0, error: "exhausted retries" };
}

/** SUBMIT: creates a "done" estimate (what the Submit button does). */
export async function writeEv(session: AdminSession, itemId: string, d: number, x: Partial<EvExtras>, startedAt?: string): Promise<WriteResult> {
  if (!ID_RE.test(itemId)) return { ok: false, status: 0, error: "invalid item id" };
  let ctx: CardContext;
  try {
    ctx = await cardContext(session, itemId);
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
  return postEstimate(session, evBody(itemId, ctx, d, x, config.evSubmitStatus(), startedAt));
}

/** APPROVE: creates an "approved" estimate from the submitted one (what the Approve button does). */
export async function approveEv(session: AdminSession, itemId: string, submitted: EstimateRecord | null, d: number, x: Partial<EvExtras>, startedAt?: string) {
  if (!ID_RE.test(itemId)) return { ok: false, status: 0, error: "invalid item id" } as WriteResult;
  let ctx: CardContext;
  const fromRecord = submitted ? contextFrom(submitted) : {};
  if (fromRecord.cardTypeId && fromRecord.gradingCompany && fromRecord.grade !== undefined) {
    ctx = { cardTypeId: String(fromRecord.cardTypeId), parallelId: (fromRecord.parallelId as string) ?? null, grade: fromRecord.grade, gradingCompany: String(fromRecord.gradingCompany) };
  } else {
    try {
      ctx = await cardContext(session, itemId);
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message } as WriteResult;
    }
  }
  // same value / last comp / URL the submit carried, admin's approve note
  const lc = x.last_comp ?? dollars(submitted?.lastCompValueCents);
  const u = x.url ?? str(submitted?.url);
  return postEstimate(session, evBody(itemId, ctx, d, { note: x.note, last_comp: lc, url: u }, config.evApproveStatus(), startedAt));
}

/** Setup check (read-only): signs in, loads the card, shows the exact bodies Submit and Approve would send. */
export async function probeEv(itemId: string, adminUserId?: string) {
  const session = await openAdminSession(adminUserId);
  try {
    const res = await fetch(url(config.evCardPath(), itemId), { method: "GET", headers: headers(session.accessToken) });
    const text = await res.text();
    let card: unknown;
    try {
      card = JSON.parse(text);
    } catch {
      /* ignore */
    }
    const ctx = card ? contextFrom(card) : {};
    const ready = !!(ctx.cardTypeId && ctx.gradingCompany && ctx.grade !== undefined);
    const full = ready ? (ctx as CardContext) : ({ cardTypeId: "?", parallelId: null, grade: "?", gradingCompany: "?" } as CardContext);
    return {
      card_status: res.status,
      card_url: url(config.evCardPath(), itemId),
      card_fields_found: ctx,
      ready_to_write: ready,
      problem: ready ? undefined : `Card record is missing ${CTX_KEYS.filter((k) => k !== "parallelId" && (ctx as Record<string, unknown>)[k] === undefined).join(", ")}. Send the response of the card load so EV_CARD_PATH can be fixed.`,
      current_values: await readEv(session, itemId),
      history: config.evHistoryPath() ? { url: url(config.evHistoryPath()), records: (await estimateHistory(session, itemId))?.slice(0, 5) ?? "couldn't read" } : "(EV_HISTORY_PATH is off)",
      submit_would_send: { method: "POST", url: url(config.evPath()), body: evBody(itemId, full, 25, { note: config.defaultNote(), last_comp: 25, url: "" }, config.evSubmitStatus()) },
      approve_would_send: { method: "POST", url: url(config.evPath()), body: evBody(itemId, full, 25, { note: config.evApproveNote(), last_comp: 25, url: "" }, config.evApproveStatus()) },
      body_preview: res.ok ? undefined : text.slice(0, 300),
    };
  } finally {
    await session.revoke();
  }
}
