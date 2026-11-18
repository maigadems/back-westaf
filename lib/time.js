// Le studio est à Dakar (UTC+0, sans heure d'été) : les DATETIME MySQL sont stockés
// en heure locale du studio, qui coïncide avec l'UTC. Les fonctions ci-dessous
// manipulent des chaînes "YYYY-MM-DD HH:MM:SS".

const pad = (n) => String(n).padStart(2, '0');

export const toSql = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

export const fromSql = (s) => {
  if (!s) return null;
  const v = String(s);
  return new Date(v.length <= 10 ? `${v}T00:00:00Z` : `${v.replace(' ', 'T')}Z`);
};

export const nowSql = () => toSql(new Date());

export const addMinutes = (sqlOrDate, minutes) => {
  const d = sqlOrDate instanceof Date ? new Date(sqlOrDate) : fromSql(sqlOrDate);
  return toSql(new Date(d.getTime() + minutes * 60000));
};

export const minutesUntil = (sql) => (fromSql(sql).getTime() - Date.now()) / 60000;

export const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(fromSql(s).getTime());

export const isValidDateTime = (s) =>
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(s || '')) && !Number.isNaN(fromSql(normDateTime(s)).getTime());

// "2026-01-02T10:00" -> "2026-01-02 10:00:00"
export const normDateTime = (s) => {
  const v = String(s).replace('T', ' ');
  return v.length === 16 ? `${v}:00` : v.slice(0, 19);
};

export const weekday = (dateStr) => fromSql(dateStr).getUTCDay();

export const addDays = (dateStr, days) => {
  const d = fromSql(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toSql(d).slice(0, 10);
};

export const todayStr = () => nowSql().slice(0, 10);

// "HH:MM" -> minutes depuis minuit ("24:00" accepté)
export const hm = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

export const minutesToHm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// Créneaux historiques ["08-09","09-10"] -> { start, end, hours }
export const legacySlotsToRange = (date, slots) => {
  if (!Array.isArray(slots) || !slots.length) return null;
  const starts = slots
    .map((s) => Number(String(s).split('-')[0]))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (!starts.length) return null;
  const start = `${date} ${pad(starts[0])}:00:00`;
  const end = addMinutes(`${date} ${pad(starts[starts.length - 1])}:00:00`, 60);
  return { start, end, hours: starts.length };
};

// Débuts d'heure couverts par [start, end)
export const hoursBetween = (start, end) => {
  const out = [];
  let cur = fromSql(start).getTime();
  const stop = fromSql(end).getTime();
  while (cur < stop) {
    out.push(toSql(new Date(cur)));
    cur += 3600000;
  }
  return out;
};

// Créneaux au format historique ("08-09") pour [start, end)
export const rangeToLegacySlots = (start, end) =>
  hoursBetween(start, end).map((h) => {
    const s = Number(h.slice(11, 13));
    return `${pad(s)}-${pad((s + 1) % 24)}`;
  });

export const formatFr = (sql) => {
  const d = fromSql(sql);
  if (!d) return '';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export const formatHour = (sql) => String(sql).slice(11, 16).replace(':', 'h');
