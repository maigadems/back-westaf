// Limitation des tentatives en mémoire : N échecs => blocage temporaire
const failures = new Map();

export const isBlocked = (key) => {
  const f = failures.get(key);
  if (!f) return false;
  if (f.until && f.until > Date.now()) return true;
  if (f.until) failures.delete(key);
  return false;
};

export const recordFailure = (key, max = 5, minutes = 15) => {
  const f = failures.get(key) || { count: 0 };
  f.count += 1;
  if (f.count >= max) f.until = Date.now() + minutes * 60000;
  failures.set(key, f);
};

export const clearFailures = (key) => failures.delete(key);

// Limiteur par fenêtre glissante (ex : demandes de réinitialisation)
const hits = new Map();
export const tooMany = (key, max, windowMinutes) => {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => t > now - windowMinutes * 60000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
};

setInterval(() => {
  const now = Date.now();
  for (const [k, f] of failures) if (f.until && f.until < now) failures.delete(k);
  for (const [k, arr] of hits) if (!arr.some((t) => t > now - 3600000)) hits.delete(k);
}, 10 * 60000).unref();
