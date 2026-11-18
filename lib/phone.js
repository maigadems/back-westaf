// Numéro local sénégalais (9 chiffres), utilisé par les anciens comptes clients
export const localPhone = (raw) => {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('221') && d.length === 12) d = d.slice(3);
  return d;
};

// Format international sans "+" (ex : 221778600482), requis par l'API WhatsApp
export const intlPhone = (raw) => {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9) d = '221' + d;
  if (d.length < 8 || d.length > 15) return null;
  return d;
};
