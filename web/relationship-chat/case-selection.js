export function shuffleCases(cases, random = Math.random) {
  const shuffled = [...cases];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function chooseRandomCaseIndex(cases, options = {}) {
  if (!cases.length) return -1;
  const playedCaseIds = toIdSet(options.playedCaseIds);
  const currentCaseId = options.currentCaseId ?? "";
  const random = options.random ?? Math.random;
  const unplayed = cases.filter((item) => !playedCaseIds.has(item.id) && item.id !== currentCaseId);
  const fallback = cases.filter((item) => item.id !== currentCaseId);
  const pool = unplayed.length ? unplayed : fallback.length ? fallback : cases;
  const selected = pool[Math.floor(random() * pool.length)];
  return Math.max(0, cases.findIndex((item) => item.id === selected.id));
}

function toIdSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter(Boolean));
  return new Set();
}
