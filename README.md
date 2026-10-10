# ev-bot — EV Bot

Bulk estimated-value updates in Arena admin. Same engine as the Tag Bot (Metabase 4131 search, SuperTokens session, Neon audit log), separate Vercel project.

- **EV Bot screen** at `https://ev-bot.vercel.app/`: type the card and the value (`ohtani #US189 base psa 10 to $300`), review every matching copy with current value → new value and % change, deselect any, **Confirm values**, Undo if needed.
- **Claude connector** at `/api/mcp?key=<MCP_ACCESS_KEY>`: `preview_ev_run` → `stage_ev_run` → `go_live_ev_run` → `verify_ev_run` / `undo_ev_run`.

## Team accounts

**Full access (default, `FULL_ACCESS=true`):** everyone who signs in can search, submit, approve and undo, with no card limit (big jobs are sent in batches of `MAX_ITEMS_PER_RUN` automatically) and no extra confirmation typing. Sign-in lasts a year and renews each time the app is opened. The only admin-only thing is the **Users** tab. Set `FULL_ACCESS=false` to bring back the viewer / editor / approver roles below.

Everyone signs in with their own work email and password. Each person's writes go to admin **under their own admin login**, so admin's estimate history shows who changed what (like the "Alan Bailey" badge).

| Role | Can |
|---|---|
| viewer | search and look |
| editor | submit estimates (they wait in the Approve tab); withdraw their own |
| approver | everything an editor can, plus **Approve** and undo |
| admin | approver + the **Users** tab |

**First admin:** set `SETUP_CODE` in Vercel, deploy, open the site, and create your account with the code. It links to your admin login automatically. Remove `SETUP_CODE` afterward.

**Two-step sign-in (MFA) in admin:** if **test** shows HTTP 403 `st-mfa … MFA requirement for auth is not completed`, that person's admin account requires MFA. Set `ADMIN_SESSION_MFA_DONE=true` so the sessions ev-bot mints count as MFA-complete; ev-bot's own password sign-in is then what protects their admin access through ev-bot.

**Linking to admin (Users tab):** **link by admin email** — enter the email the person signs in to *admin* with (it can differ from their ev-bot email, e.g. `jensen@precisionlabeling.com`). ev-bot finds every login for that email and keeps the one admin actually accepts. **test** checks a linked login can use the estimate-value endpoints. A failed submit now says why in the bottom bar (e.g. "admin refused this login").

**Adding people (Users tab):** name, email, role → **Add person** → send them the invite link (one use, 48 h) to set their password. EV Bot finds their admin login from their email through SuperTokens. If it can't, paste their admin user ID (the `sub` in their admin token, or ask engineering). Until they're linked, their changes go through the shared login with "· by Name" added to the note (`SHARED_SESSION_FALLBACK=false` blocks that instead). Turn people off or change roles from the same tab; a forgotten password = **reset password link**.

**Claude connector:** each person makes their own URL under **My account**. Runs from Claude carry their name and their role limits. Turning a person off kills their URL too.

Notes:
- Their admin account needs admin permission to edit/approve estimates, same as clicking in admin. A 403 on a run means admin itself doesn't allow it for that person.
- Saved prompts and Recent runs are shared by the team.

## How a request is read

| Typed | Meaning |
|---|---|
| `to $300`, `ev 300`, `ev = 1.2k`, `→ $85.50`, `set to 300` | **New value** (pulled out before searching) |
| `over $200`, `under $1k`, `between $200 and $1,000` | Filters on the **current** value |
| a pasted card row (tabs or wide gaps between columns): `2026 Pokemon Mega Evolution — Mega Lucario ex 033 — Ascended Heroes Premium Poster Collection - Mega Lucario — PSA 10` | **Exact** search: set · insert · player · card # (its own column, or on the end of the player) · parallel (`—`/blank = base) · grade, e.g. `2022-23 Panini Donruss  Rated Rookie  Chet Holmgren  202  —  PSA 9`. Insert must match too (`—` = no insert). Paste several rows (one per line) to fetch several cards at once |
| `tag sd_wemby_grail`, `tagged inv_dump`, `#op_promo`, a bare snake_case tag, `untagged` | **Tag filter** — on its own pulls every card with that tag; with other words narrows that search. Several tags = any of them |
| a Pokémon / One Piece title: `2023 pokemon swsh crown zenith leafeon vstar #gg35 psa 10`, `2025 one piece tony tony chopper p-101 store tournament vol.4 arena club 10` | **Title search**: finds the character first, then keeps cards where every other word is on the card (set, insert, parallel, #); year, grade and card # must match. Words that are on none of that character's cards (e.g. "swsh") are ignored and shown. Also the fallback when a normal search finds nothing |
| `5000 or more ev`, `$5k+`, `ev 5000+`, `over $5,000`, `under $100`, `between $1,000 and $5,000`, `$500-$999`, `1k to 5k ev` | **EV range** on the current value (never read as the new value). A lone year (`2020 basketball`) keeps results to sets from that year |
| everything else | Same search as the Tag Bot (players, sets, parallels, card #, grades, AC/cert numbers) |

**The flow (two steps, like admin) — same layout as the Tag Bot:**
1. **Request** tab — opens on **Any card (4131)**: type any card (player, set, card #, parallel, grade) or an AC / cert number plus the value on one line, e.g. `ohtani #US189 base psa 10 ev 300 lc 300 note mcp done` (`ev`/`to $` = value, `lc`/`last comp` = last comp, `note …`, a pasted `https://` link = URL). Every matching card shows as a slab tile; a card that already has an EV gets it replaced (cards already at the new value are skipped). The panel value applies to every selected card; type on a tile to give one card its own value or last comp. **Submit** sends each card to admin as "done".
2. **Approve** tab — everything submitted, from anyone. **Approve all** (or a selection) with note `mcp approved`; values go live. Failures stay in the queue with the error. **Withdraw** removes a card without approving it.
3. Undo an approve run from **Recent runs** (puts the previous values back live).

**Last comp is required on the first pass when the card has none.** On Estimate tasks, those rows show "required" and Submit skips them until filled (the task question's `LAST_COMP` column tells ev-bot which cards have one; cards that already have a last comp can leave it blank and keep it). On Search & set and from Claude, the server checks each card in admin right before writing and skips any card with no last comp when none was given.

Admin's Estimate value form requires a **Note**, so the screen does too (Confirm stays off until one is entered). **Last comp** and **URL** are optional and sent only when filled. All three carry over between searches and are saved on the run.

The value can also be typed in the `$` field, or picked with **Use median**, **Use highest**, or a card's **(i) → Use this value**.

## Guardrails

- Cards already at the value are dropped (no no-op writes).
- **Different cards warning:** if the selection holds more than one distinct card (set · player · card # · parallel · grade), the screen lists them. For a recomp, include card number, parallel and grade.
- **Big changes:** any card moving more than `BIG_CHANGE_PCT` (default 50%) or with no current value is flagged; confirming requires typing the card count.
- `MIN_EV` / `MAX_EV` bound the value; `MAX_ITEMS_PER_RUN` caps a run. Confirm re-runs the search on fresh 4131 data and writes only cards that still match.
- **Exact undo:** right before each write the server reads the card's live value, last comp, URL and note from admin and saves it (`prev_source=admin`); the warehouse value is the fallback. Cards that had no value before are reported, not blanked.

## Setup (new Vercel project)

1. **The estimate call is known** (captured from admin's Approve): `POST /admin/estimate-value` with `cardId, cardTypeId, parallelId, grade, gradingCompany, estimatedValueCents, lastCompValueCents, gradingTaskStatus, note, url, startedAt, finishedAt`. Submit = `"done"`, Approve = `"approved"`; each creates a new record. Defaults in `.env.example` match. Submit (`"done"`) and Approve (`"approved"`) are both confirmed from admin captures, as are the card record (`GET /admin/v1/cards/{id}`; grade comes from `overall`) and the estimate history (`POST /admin/estimate-value/search`, newest first), which ev-bot reads right before every write to save what was live and to know whether the card already has a last comp. Only the Estimate tasks source is still open: save `sql/ev-tasks.sql` as a Metabase question (confirm the "still open" line with its check query first) and put its ID in `EV_TASKS_CARD_ID`. Paste `sql/4131-warehouse-cards.sql` into question 4131: it adds SET_NUMBER, LAST_COMP and EV_DATE_SOURCE, and makes ESTIMATED_VALUE_DATE / EV_AGE_DAYS the date the EV was last **approved** (approval or recomp) instead of the estimate_value task date. Tiles then read "EV approved 9/30/2026 · 1 day ago" (or "never approved").

**Live EV dates:** ev-bot also reads each on-screen card's estimate history straight from admin (`POST /admin/estimate-value/search`), so the date, value and last comp are current even before Snowflake syncs. Live statuses = `EV_LIVE_STATUSES` (default `approved,done_skip_verify` — recomps are saved as `done_skip_verify`). A newer estimate that isn't live yet shows as "Waiting: $X done 10/1/2026".
2. **Vercel:** new project from this folder. Copy Metabase, SuperTokens and `DATABASE_URL` from the Tag Bot project; set `SESSION_SECRET`, `SETUP_CODE` and `MCP_ACCESS_KEY`; add the `EV_*` vars. Keep `DRY_RUN=true`. Deploy, then create the first admin (see Team accounts).
3. **Check the endpoint** (read-only, admins): MCP Inspector with your personal connector URL → `check_ev_endpoint` with any ITEM_ID, or signed in on the screen, in the browser console:
   `fetch("/api/ui/probe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({item_id:"<ITEM_ID>"})}).then(r=>r.json()).then(console.log)`
   Expect `status: 200`, `configured_value_in_dollars` matching admin, and the exact write call it would send.
4. **Dry run** a real request on the screen.
5. **Go live:** `DRY_RUN=false`, redeploy. Set 2–3 cards, check them in admin, Undo, confirm they revert. Then raise `MAX_ITEMS_PER_RUN`.

## Tools

| Tool | Writes to admin? |
|---|---|
| `list_ev_tasks`, `list_approval_queue` | No |
| `submit_ev_tasks` (per-card values) | **Yes** — submit only |
| `approve_ev_queue` (all or some) | **Yes** — values go live (approvers) |
| `withdraw_from_queue` | No admin write |
| `find_cards_ev`, `preview_ev_run` | No |
| `stage_ev_run` | No (freezes list + current values) |
| `submit_ev_run` | **Yes** — submit only |
| `undo_ev_run` (approve runs) | **Yes** |
| `verify_ev_run`, `get_ev_run`, `list_ev_runs`, `check_ev_endpoint`, `get_settings` | No |

## Security

- `SUPERTOKENS_API_KEY` can mint an admin session for any user. Only the server holds it; limit who can see the Vercel project.
- Passwords are stored as scrypt hashes; invite links and connector keys are stored only as SHA-256 hashes and shown once.
- Sign-in locks for 15 minutes after 8 wrong tries. Sessions last 14 days, and every request re-checks that the account is still on.
- Role checks happen on the server for the screen and the connector alike; tool arguments can't change who a run is by.

## Card Ladder (CL Value)

The panel row is **Estimated value · Last comp · Cert # · Grader · CL Value**. Clicking a cert on a card (the number or ⧉) copies it, fills Cert # and Grader from that card, and looks up its Card Ladder value; **Use CL value → EV** puts it in Estimated value. You can also type a cert and press Enter.

The lookup calls Card Ladder `GET /estimate?cert=…&grader=…` and uses `estimatedValue` only. Set `CARD_LADDER_API_KEY` in Vercel (the URL is built in). If Card Ladder answers 401/403, set `CARD_LADDER_KEY_IN_URL=true` (also sends `?key=`) or `CARD_LADDER_KEY_HEADER` to the header name it expects.
