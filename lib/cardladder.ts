// Card Ladder value by cert + grading company — uses `estimatedValue` and `lastSaleDate`.
//   GET {CARD_LADDER_API_URL}/estimate?cert=119206372&grader=psa   →   { "estimatedValue": 32, ... }
// Key goes in a header (CARD_LADDER_KEY_HEADER, default x-api-key); set CARD_LADDER_KEY_IN_URL=true to also
// send it as ?key= (the test page's "send the key in the URL" option, for a 401/403).
export type ClResult = { configured: boolean; ok?: boolean; value?: number | null; last_sale?: string | null; url?: string | null; status?: number; error?: string; note?: string };

const BASE = () => (process.env.CARD_LADDER_API_URL || "https://gateway-v1-7m6abs4l.uc.gateway.dev").replace(/\/+$/, "");

export async function lookupCardLadder(input: { cert: string; grader: string }): Promise<ClResult> {
  const key = process.env.CARD_LADDER_API_KEY;
  const cert = String(input.cert || "").replace(/\D+/g, "");
  if (!key) return { configured: false, note: "Card Ladder isn't connected yet (add CARD_LADDER_API_KEY)." };
  if (!cert) return { configured: true, ok: false, error: "Enter a cert number." };
  const grader = String(input.grader || "psa").toLowerCase();
  const qs = new URLSearchParams({ cert, grader });
  if ((process.env.CARD_LADDER_KEY_IN_URL ?? "").toLowerCase() === "true") qs.set("key", key);
  try {
    const res = await fetch(`${BASE()}/estimate?${qs}`, {
      headers: { [process.env.CARD_LADDER_KEY_HEADER || "x-api-key"]: key, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { configured: true, ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
    const j = await res.json();
    const n = j?.estimatedValue == null || j.estimatedValue === "" ? null : Number(j.estimatedValue);
    if (n == null || !Number.isFinite(n)) return { configured: true, ok: false, error: "Card Ladder has no estimated value for this cert." };
    // whole dollars: .50 and up rounds up, .49 and below rounds down ($152.50 → $153, $152.49 → $152)
    return { configured: true, ok: true, value: Math.floor(Math.round(n * 100) / 100 + 0.5), last_sale: j?.lastSaleDate ? String(j.lastSaleDate) : null };
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
