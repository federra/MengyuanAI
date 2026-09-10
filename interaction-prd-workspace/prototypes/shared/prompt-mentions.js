export function projectMentions(raw, names) {
    const tokens = [];
    let text = "", cursor = 0;
    for (const match of raw.matchAll(/@\[([^\]]+)\]/g)) {
        text += raw.slice(cursor, match.index);
        const start = text.length;
        text += "@" + (names.get(match[1]) || "待绑定图片");
        tokens.push({ start, end: text.length, raw: match[0] });
        cursor = match.index + match[0].length;
    }
    text += raw.slice(cursor);
    return { text, tokens };
}
// Preserve identities of unchanged mentions; editing a label never guesses an ID by name.
export function editMentions(raw, next, names) {
    const old = projectMentions(raw, names);
    let prefix = 0, suffix = 0;
    while (prefix < old.text.length &&
        prefix < next.length &&
        old.text[prefix] === next[prefix])
        prefix++;
    while (suffix < old.text.length - prefix &&
        suffix < next.length - prefix &&
        old.text[old.text.length - 1 - suffix] === next[next.length - 1 - suffix])
        suffix++;
    const delta = next.length - old.text.length;
    const kept = old.tokens
        .filter((t) => t.end <= prefix || t.start >= old.text.length - suffix)
        .map((t) => t.end <= prefix
        ? t
        : { ...t, start: t.start + delta, end: t.end + delta });
    let result = next;
    for (const t of kept.reverse())
        result = result.slice(0, t.start) + t.raw + result.slice(t.end);
    return result;
}
// Existing IDs are the authority; duplicate character names never infer identity.
export function inlineCharacterMentions(raw, characters) {
    const counts = new Map();
    for (const name of characters.values())
        counts.set(name, (counts.get(name) || 0) + 1);
    const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!characters.size)
        return raw;
    const pattern = new RegExp([...new Set(characters.values())]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escape)
        .join("|"), "g");
    const prose = raw.replace(/@\[[^\]]+\]/g, "");
    const present = new Set(prose.match(pattern) || []);
    const eligible = new Map([...characters].filter(([id, name]) => counts.get(name) === 1 && present.has(name) && raw.includes(`@[${id}]`)));
    let result = raw;
    for (const [id] of eligible) {
        const token = `@[${id}]`;
        result = result
            .split(`（${token}）`)
            .join("")
            .split(`(${token})`)
            .join("")
            .split(token)
            .join("");
    }
    const byName = new Map([...eligible].map(([id, name]) => [name, id]));
    return result
        .split(/(@\[[^\]]+\])/g)
        .map((part) => part.startsWith("@[")
        ? part
        : part.replace(pattern, (name) => byName.has(name) ? `${name}（@[${byName.get(name)}]）` : name))
        .join("")
        .trimEnd();
}
