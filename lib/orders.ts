// Order / PO in a request: "order 1234567", "order #1234567", "ord 1234567", "orders 123, 456",
// "po 4386", "PO #4386". Pulled out before searching; a request with only an order shows that order's cards.
export function readOrders(text: string): { orders: string[]; pos: string[]; rest: string } {
  const orders: string[] = [], pos: string[] = [];
  const list = (s: string) => s.split(/[\s,]+(?:and\s+)?/).map((x) => x.replace(/^#/, "")).filter((x) => /^[a-z0-9-]{2,}$/i.test(x));
  let t = " " + text + " ";
  t = t.replace(/\b(?:purchase\s+order|p\.?o\.?)\s*(?:numbers?|#|no\.?)?\s*[:#]?\s*((?:#?[a-z0-9-]*\d[a-z0-9-]*[\s,]*(?:and\s+)?)+)/gi, (_m, g: string) => (pos.push(...list(g)), " "));
  t = t.replace(/\b(?:orders?|ord)\s*(?:numbers?|#|no\.?)?\s*[:#]?\s*((?:#?[a-z0-9-]*\d[a-z0-9-]*[\s,]*(?:and\s+)?)+)/gi, (_m, g: string) => (orders.push(...list(g)), " "));
  return { orders: [...new Set(orders)], pos: [...new Set(pos)], rest: t.replace(/^ | $/g, "").trim() };
}
