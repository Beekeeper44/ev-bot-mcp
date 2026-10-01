// Tag filter for searches: "tag sd_wemby_grail", "tagged inv_dump", "#sd_wemby_grail", a bare snake_case word,
// "tag: op_promo", or "untagged" / "no tag". Several tags = any of them.
export function readTags(text: string): { tags: string[]; untagged: boolean; rest: string } {
  const tags: string[] = [];
  let rest = " " + text + " ";
  const untagged = /\b(untagged|no tag|without (?:a )?tag|not tagged)\b/i.test(rest);
  rest = rest.replace(/\b(untagged|no tag|without (?:a )?tag|not tagged)\b/gi, " ");
  rest = rest.replace(/\b(?:tagged(?: with)?|with tag|tags?)\b\s*[:=]?\s*#?([a-z0-9][a-z0-9_-]*)/gi, (_m, t: string) => (tags.push(t.toLowerCase()), " "));
  rest = rest.replace(/(^|\s)#([a-z0-9]*_[a-z0-9_-]*)/gi, (_m, pre: string, t: string) => (tags.push(t.toLowerCase()), pre + " "));
  rest = rest.replace(/(^|\s)([a-z][a-z0-9]*_[a-z0-9_-]+)(?=\s|,|$)/gi, (_m, pre: string, t: string) => (tags.push(t.toLowerCase()), pre + " "));
  return { tags: [...new Set(tags)], untagged, rest: rest.replace(/^ | $/g, "").trim() };
}
export const hasTag = (rowTag: string | null | undefined, tags: string[]) =>
  !tags.length || tags.some((t) => String(rowTag ?? "").toLowerCase().includes(t));
