export function readDraft<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export function durableCommand(scope: string, body: unknown) {
  const storageKey = "sf.pending." + scope;
  const input = JSON.stringify(body);
  const commands = readDraft<Record<string, string>>(storageKey) || {};
  const key = commands[input] || crypto.randomUUID();
  commands[input] = key;
  // Fail closed if paid commands cannot survive a page reload.
  localStorage.setItem(storageKey, JSON.stringify(commands));
  return {
    key,
    done: () => {
      const latest = readDraft<Record<string, string>>(storageKey) || {};
      delete latest[input];
      localStorage.setItem(storageKey, JSON.stringify(latest));
    },
  };
}
export function storeDraft(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
export function removeDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
