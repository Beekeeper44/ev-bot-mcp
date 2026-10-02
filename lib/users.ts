// Team accounts. Each person signs in with their own email + password, gets a role, and their
// admin writes go out under their OWN admin account, so admin shows who changed each value.
//
// roles:  viewer   — search only
//         editor   — submit estimates (they sit at "done" for an approver)
//         approver — submit + approve (value goes live), undo
//         admin    — approver + manage users
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import supertokens from "supertokens-node";
import { config } from "./config";
import { q } from "./db";
import { initSupertokens } from "./admin";

export type Role = "viewer" | "editor" | "approver" | "admin";
export const ROLES: Role[] = ["viewer", "editor", "approver", "admin"];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, approver: 2, admin: 3 };
export const can = (u: { role: Role }, need: Role) => (need !== "admin" && config.fullAccess()) || RANK[u.role] >= RANK[need];

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  admin_user_id: string | null;
  active: boolean;
  has_password: boolean;
  has_mcp_key: boolean;
  created_by: string | null;
  created_at: string;
  last_login_at: string | null;
};

/** Who an admin write goes out as: their own admin account, or the shared one (with their name in the note). */
export type Actor = User & { session_user_id: string; attribution: "own" | "shared"; note_suffix: string };

export function actorOf(u: User): Actor {
  if (u.admin_user_id) return { ...u, session_user_id: u.admin_user_id, attribution: "own", note_suffix: "" };
  // the person who set ev-bot up owns ADMIN_SESSION_USER_ID — treat it as their own login (no "· by" suffix)
  if (u.created_by === "setup" && config.sessionUserIdOrNull()) return { ...u, admin_user_id: config.sessionUserIdOrNull(), session_user_id: config.sessionUserId(), attribution: "own", note_suffix: "" };
  if (!config.sharedSessionFallback()) throw new Error(`${u.name} isn't linked to an admin account yet. Ask an EV Bot admin to link them in Users.`);
  return { ...u, session_user_id: config.sessionUserId(), attribution: "shared", note_suffix: ` · by ${u.name}` };
}

const COLS = `id, email, name, role, admin_user_id, active, (pw_hash IS NOT NULL) AS has_password,
  (mcp_key_hash IS NOT NULL) AS has_mcp_key, created_by, created_at, last_login_at`;
const norm = (e: string) => String(e || "").trim().toLowerCase();
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

// ---------- passwords ----------
function hashPw(pw: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
function checkPw(pw: string, stored: string | null) {
  if (!stored) return false;
  const [, salt, hex] = stored.split("$");
  const a = scryptSync(pw, salt, 64), b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
export function pwProblem(pw: string) {
  if (!pw || pw.length < 10) return "Use at least 10 characters.";
  return null;
}

// ---------- session cookie: user id + issue time, HMAC-signed; user re-checked in the DB every request ----------
const COOKIE = "evb_session";
const secret = () => process.env.SESSION_SECRET || config.mcpAccessKey();
const mac = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");
const DAYS = 365; // stay signed in; every request still re-checks the account is on

export function sessionCookie(userId: string) {
  const v = Buffer.from(`${userId}|${Date.now()}`).toString("base64url");
  return `${COOKIE}=${v}.${mac(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * DAYS}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function currentUser(req: Request): Promise<User | null> {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [v, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!v || !sig) return null;
  const good = mac(v);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const [id, at] = Buffer.from(v, "base64url").toString().split("|");
  if (!id || Date.now() - Number(at) > DAYS * 86400_000) return null;
  const [u] = await q<User>(`SELECT ${COLS} FROM ev_users WHERE id=$1 AND active`, [id]);
  return u ?? null;
}

// ---------- sign-in ----------
const attempts = new Map<string, { n: number; at: number }>();
export async function signIn(email: string, pw: string): Promise<User> {
  const e = norm(email);
  const a = attempts.get(e);
  if (a && a.n >= 8 && Date.now() - a.at < 15 * 60_000) throw new Error("Too many tries. Wait 15 minutes.");
  const [row] = await q<User & { pw_hash: string | null }>(`SELECT ${COLS}, pw_hash FROM ev_users WHERE email=$1`, [e]);
  if (!row || !row.active || !checkPw(pw, row.pw_hash)) {
    attempts.set(e, { n: (a && Date.now() - a.at < 15 * 60_000 ? a.n : 0) + 1, at: Date.now() });
    throw new Error("Wrong email or password.");
  }
  attempts.delete(e);
  await q(`UPDATE ev_users SET last_login_at=now() WHERE id=$1`, [row.id]);
  const { pw_hash: _h, ...u } = row;
  return u;
}

// ---------- first run: no users yet → whoever has SETUP_CODE creates the first admin ----------
export async function needsSetup() {
  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ev_users`);
  return n === 0;
}
export async function setupFirstAdmin(input: { email: string; name: string; password: string; code: string }) {
  if (!(await needsSetup())) throw new Error("Setup is already done. Sign in instead.");
  const want = process.env.SETUP_CODE;
  if (!want) throw new Error("Set SETUP_CODE in Vercel first, then redeploy.");
  const a = Buffer.from(input.code || ""), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Wrong setup code.");
  const p = pwProblem(input.password);
  if (p) throw new Error(p);
  const id = "u_" + randomBytes(6).toString("hex");
  const adminId = (await lookupAdminUserId(input.email)) ?? config.sessionUserIdOrNull();
  await q(
    `INSERT INTO ev_users (id, email, name, role, admin_user_id, pw_hash, created_by) VALUES ($1,$2,$3,'admin',$4,$5,'setup')`,
    [id, norm(input.email), input.name.trim(), adminId, hashPw(input.password)]
  );
  const [u] = await q<User>(`SELECT ${COLS} FROM ev_users WHERE id=$1`, [id]);
  return u;
}

// ---------- invites: admin adds a person → one-time link (48h) where they set their password ----------
const INVITE_HOURS = 48;
async function newInvite(userId: string) {
  const token = randomBytes(24).toString("base64url");
  await q(`UPDATE ev_users SET invite_hash=$2, invite_expires_at=now() + ($3 || ' hours')::interval WHERE id=$1`, [userId, sha(token), String(INVITE_HOURS)]);
  return token;
}
export async function inviteInfo(token: string) {
  const [u] = await q<{ name: string; email: string }>(`SELECT name, email FROM ev_users WHERE invite_hash=$1 AND invite_expires_at > now() AND active`, [sha(token)]);
  if (!u) throw new Error("This invite link is invalid or expired. Ask an admin for a new one.");
  return u;
}
export async function acceptInvite(token: string, password: string): Promise<User> {
  const p = pwProblem(password);
  if (p) throw new Error(p);
  const [u] = await q<User>(
    `UPDATE ev_users SET pw_hash=$2, invite_hash=NULL, invite_expires_at=NULL, last_login_at=now()
     WHERE invite_hash=$1 AND invite_expires_at > now() AND active RETURNING ${COLS}`,
    [sha(token), hashPw(password)]
  );
  if (!u) throw new Error("This invite link is invalid or expired. Ask an admin for a new one.");
  return u;
}

export async function changePassword(userId: string, current: string, next: string) {
  const [row] = await q<{ pw_hash: string }>(`SELECT pw_hash FROM ev_users WHERE id=$1`, [userId]);
  if (!checkPw(current, row?.pw_hash ?? null)) throw new Error("Current password is wrong.");
  const p = pwProblem(next);
  if (p) throw new Error(p);
  await q(`UPDATE ev_users SET pw_hash=$2 WHERE id=$1`, [userId, hashPw(next)]);
}

// ---------- admin account link: find the person's admin user ID from their email ----------
export async function lookupAdminUserId(email: string): Promise<string | null> {
  try {
    initSupertokens();
    const users = await supertokens.listUsersByAccountInfo(config.sessionTenantId(), { email: norm(email) });
    return users[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ---------- user management (admins) ----------
export const listUsers = () => q<User>(`SELECT ${COLS} FROM ev_users ORDER BY active DESC, name`);

export async function addUser(input: { email: string; name: string; role: Role; admin_user_id?: string | null }, by: User) {
  const email = norm(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email.");
  if (!input.name?.trim()) throw new Error("Enter their name.");
  if (!ROLES.includes(input.role)) throw new Error("Pick a role.");
  const [dupe] = await q(`SELECT id FROM ev_users WHERE email=$1`, [email]);
  if (dupe) throw new Error("That email already has an account.");
  const adminId = input.admin_user_id?.trim() || (await lookupAdminUserId(email));
  const id = "u_" + randomBytes(6).toString("hex");
  await q(`INSERT INTO ev_users (id, email, name, role, admin_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, email, input.name.trim(), input.role, adminId, by.name]);
  return { id, invite_token: await newInvite(id), admin_user_id: adminId, linked_automatically: !input.admin_user_id && !!adminId };
}

export async function updateUser(id: string, patch: { role?: Role; active?: boolean; admin_user_id?: string | null; name?: string }, by: User) {
  if (id === by.id && (patch.active === false || (patch.role && patch.role !== "admin"))) throw new Error("You can't remove your own admin access.");
  if (patch.role && !ROLES.includes(patch.role)) throw new Error("Unknown role.");
  if (patch.admin_user_id && !/^[0-9a-f-]{36}$/i.test(patch.admin_user_id.trim())) throw new Error("Admin user ID should look like 2290bf05-5cae-…");
  await q(
    `UPDATE ev_users SET role=COALESCE($2,role), active=COALESCE($3,active),
       admin_user_id=CASE WHEN $4::boolean THEN NULLIF($5,'') ELSE admin_user_id END, name=COALESCE(NULLIF($6,''),name),
       mcp_key_hash=CASE WHEN $3 = false THEN NULL ELSE mcp_key_hash END
     WHERE id=$1`,
    [id, patch.role ?? null, patch.active ?? null, patch.admin_user_id !== undefined, patch.admin_user_id?.trim() ?? "", patch.name ?? ""]
  );
}
export async function relinkAdmin(id: string) {
  const [u] = await q<{ email: string }>(`SELECT email FROM ev_users WHERE id=$1`, [id]);
  if (!u) throw new Error("No such user.");
  const adminId = await lookupAdminUserId(u.email);
  if (!adminId) throw new Error(`No admin account found for ${u.email}. Paste their admin user ID instead.`);
  await q(`UPDATE ev_users SET admin_user_id=$2 WHERE id=$1`, [id, adminId]);
  return adminId;
}
export const resetInvite = async (id: string) => ({ invite_token: await newInvite(id) });

// ---------- personal connector keys (each person's own Claude connector URL) ----------
export async function newMcpKey(userId: string) {
  const key = "evk_" + randomBytes(24).toString("base64url");
  await q(`UPDATE ev_users SET mcp_key_hash=$2 WHERE id=$1`, [userId, sha(key)]);
  return key;
}
export const revokeMcpKey = (userId: string) => q(`UPDATE ev_users SET mcp_key_hash=NULL WHERE id=$1`, [userId]);
export async function userByMcpKey(key: string): Promise<User | null> {
  if (!key || !key.startsWith("evk_")) return null;
  const [u] = await q<User>(`SELECT ${COLS} FROM ev_users WHERE mcp_key_hash=$1 AND active`, [sha(key)]);
  return u ?? null;
}
