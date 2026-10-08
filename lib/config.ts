// All settings come from Vercel env vars. Nothing secret is hard-coded.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Gate for the MCP endpoint itself: connector URL is /api/mcp?key=<MCP_ACCESS_KEY>
  mcpAccessKey: () => req("MCP_ACCESS_KEY"),

  // Metabase (reads) — question 4131 "Warehouse Cards"
  metabaseHost: () => req("METABASE_HOST").replace(/\/+$/, ""),
  metabaseApiKey: () => req("METABASE_API_KEY"),
  metabaseCardId: () => num("METABASE_CARD_ID", 4131),

  // Admin (writes)
  adminApiUrl: () => (process.env.ADMIN_API_URL || "https://admin-api.arenaclub.com").replace(/\/+$/, ""),
  adminOrigin: () => process.env.ADMIN_ORIGIN || "https://admin.arenaclub.com",

  // Estimated value, as admin does it (captured from the Approve click):
  //   POST {ADMIN_API_URL}/admin/estimate-value
  //   { cardId, cardTypeId, parallelId, grade, gradingCompany, estimatedValueCents, lastCompValueCents,
  //     gradingTaskStatus: "done" | "approved", note, url, startedAt, finishedAt }
  // Each click creates a new estimate record: Submit = "done", Approve = "approved".
  evPath: () => process.env.EV_PATH || "/admin/estimate-value",
  evSubmitStatus: () => process.env.EV_SUBMIT_STATUS || "done",
  evApproveStatus: () => process.env.EV_APPROVE_STATUS || "approved",
  // statuses that mean "this value is live": an approval, or a recomp saved with skip-verify
  evLiveStatuses: () => (process.env.EV_LIVE_STATUSES || "approved,done_skip_verify").split(",").map((x) => x.trim()).filter(Boolean),
  // Where the card's cardTypeId / parallelId / grade / gradingCompany come from on the first submit
  // (captured: GET /admin/v1/cards/{id}; grade is "overall" there)
  evCardPath: () => process.env.EV_CARD_PATH || "/admin/v1/cards/{id}",
  // A card's estimate records, newest first (captured: POST /admin/estimate-value/search
  // { where: { cardId: { equals } }, limit, offset, orderBy: "finishedAt", orderDirection: "DESC" }).
  // Read right before writing, so undo restores exactly what was live and last comp is known.
  evHistoryPath: () => process.env.EV_HISTORY_PATH ?? "/admin/estimate-value/search",
  // Estimate tasks: the Metabase question that lists cards waiting for an estimated value (must include ITEM_ID)
  evTasksCardId: () => num("EV_TASKS_CARD_ID", 0),
  evApproveNote: () => process.env.EV_APPROVE_NOTE ?? "mcp approved",
  defaultNote: () => process.env.EV_DEFAULT_NOTE || "mcp done",

  // SuperTokens — the server mints its own short-lived session for this user
  supertokensUri: () => req("SUPERTOKENS_CONNECTION_URI"),
  supertokensApiKey: () => req("SUPERTOKENS_API_KEY"),
  sessionUserId: () => req("ADMIN_SESSION_USER_ID"),
  sessionUserIdOrNull: () => process.env.ADMIN_SESSION_USER_ID || null,
  // People not linked to their own admin account write through ADMIN_SESSION_USER_ID, with "· by <name>" on the note.
  // Set to false to require every person to be linked.
  sharedSessionFallback: () => (process.env.SHARED_SESSION_FALLBACK ?? "true").toLowerCase() !== "false",
  sessionTenantId: () => process.env.ADMIN_SESSION_TENANT_ID || "public",
  sessionMfaDone: () => (process.env.ADMIN_SESSION_MFA_DONE ?? "false").toLowerCase() === "true",
  sessionMfaFactors: () => (process.env.ADMIN_SESSION_MFA_FACTORS || "emailpassword,thirdparty,totp,otp-email,otp-phone,link-email,link-phone").split(",").map((x) => x.trim()).filter(Boolean),
  sessionExtraPayload: (): Record<string, unknown> | undefined => {
    const raw = process.env.ADMIN_SESSION_EXTRA_PAYLOAD;
    if (!raw) return undefined;
    return JSON.parse(raw);
  },

  // Neon — run registry + audit log (tables are prefixed ev_, so the Tag Bot's Neon DB can be shared)
  databaseUrl: () => req("DATABASE_URL"),

  // Safety
  dryRun: () => (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
  // cards per request; the screen splits bigger jobs into batches of this size automatically, so there's no limit for people
  maxItemsPerRun: () => num("MAX_ITEMS_PER_RUN", 250),
  // true = everyone signed in can search, submit, approve and undo (only managing users stays admin-only)
  fullAccess: () => (process.env.FULL_ACCESS ?? "true").toLowerCase() !== "false",
  writeConcurrency: () => num("WRITE_CONCURRENCY", 5),
  runExpiryHours: () => num("RUN_EXPIRY_HOURS", 24),
  minEv: () => num("MIN_EV", 0.01),
  maxEv: () => num("MAX_EV", 250000),
  // Cards whose value moves more than this % need the count typed to confirm (screen) and are listed in previews
  bigChangePct: () => num("BIG_CHANGE_PCT", 50),
};

export function validateEv(v: unknown): string | null {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return "Enter a new estimated value in dollars.";
  if (Math.round(n * 100) / 100 !== n) return "Use at most two decimal places.";
  if (n < config.minEv()) return `Value must be at least $${config.minEv()}.`;
  if (n > config.maxEv()) return `Value is over the $${config.maxEv().toLocaleString()} limit (MAX_EV).`;
  return null;
}

export type EvExtras = { note: string; last_comp?: number | null; url?: string | null };

export function validateExtras(x: Partial<EvExtras>): string | null {
  if (!String(x.note ?? "").trim()) return "Enter a note (admin requires one on every estimated-value change).";
  if (String(x.note).length > 500) return "Note is over 500 characters.";
  if (x.last_comp != null && (!Number.isFinite(Number(x.last_comp)) || Number(x.last_comp) < 0)) return "Last comp must be a dollar amount.";
  if (x.url && !/^https?:\/\/\S+$/i.test(String(x.url))) return "URL must start with http:// or https://";
  return null;
}

export const sameEv = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;

export const pctChange = (from: number | null | undefined, to: number) =>
  from && from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null;
