import crypto from 'crypto';

export function generateRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function extractCompletes(decision, store) {
  if (!decision) return store;
  const current = Array.isArray(store) ? [...store] : [];
  if (Array.isArray(decision.complete)) {
    for (const entry of decision.complete) {
      const value = String(entry || '').trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (!current.some((existing) => String(existing || '').toLowerCase() === key)) {
        current.push(value);
      }
    }
  } else if (typeof decision.complete === 'string') {
    const value = decision.complete.trim();
    if (value && !current.some((existing) => String(existing || '').toLowerCase() === value.toLowerCase())) {
      current.push(value);
    }
  }
  return current;
}

export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function filterByRadius(elements, center, radius = 120) {
  if (!center || !Array.isArray(center) || center.length !== 2) return elements;
  const [cx, cy] = center;
  const r = Number.isFinite(radius) ? radius : 120;
  const within = (element) => {
    try {
      if (Array.isArray(element.center) && element.center.length === 2) {
        const d = Math.hypot(element.center[0] - cx, element.center[1] - cy);
        if (d <= r) return true;
      }
      if (Array.isArray(element.rect) && element.rect.length === 4) {
        const [left, top, width, height] = element.rect;
        const right = left + (width || 0);
        const bottom = top + (height || 0);
        if (cx >= left && cx <= right && cy >= top && cy <= bottom) return true;
        const dx = cx < left ? left - cx : cx > right ? cx - right : 0;
        const dy = cy < top ? top - cy : cy > bottom ? cy - bottom : 0;
        return Math.hypot(dx, dy) <= r;
      }
    } catch {}
    return false;
  };
  const filtered = elements.filter(within);
  if (filtered.length > 0) return filtered;
  return elements
    .slice()
    .sort((a, b) => {
      const dist = (element) => {
        try {
          if (Array.isArray(element.center) && element.center.length === 2) {
            return Math.hypot(element.center[0] - cx, element.center[1] - cy);
          }
          if (Array.isArray(element.rect) && element.rect.length === 4) {
            const [left, top, width, height] = element.rect;
            const right = left + (width || 0);
            const bottom = top + (height || 0);
            const dx = cx < left ? left - cx : cx > right ? cx - right : 0;
            const dy = cy < top ? top - cy : cy > bottom ? cy - bottom : 0;
            return Math.hypot(dx, dy);
          }
        } catch {}
        return Number.POSITIVE_INFINITY;
      };
      return dist(a) - dist(b);
    })
    .slice(0, 20);
}

export function pickExactMatch(elements, hints, center, radius = 120) {
  if (!Array.isArray(elements) || elements.length === 0) return null;
  const exact = new Set(Array.isArray(hints?.text_exact) ? hints.text_exact.map(normalizeText) : []);
  if (!exact.size) return null;
  const candidates = filterByRadius(elements, center, radius).filter((element) => exact.has(normalizeText(element.name)));
  if (!candidates.length) return null;
  const hittable = candidates.filter((element) => element.hit_state === 'hittable');
  const pool = hittable.length ? hittable : candidates;
  if (!center) return pool[0];
  const [cx, cy] = center;
  let best = pool[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of pool) {
    if (Array.isArray(element.center) && element.center.length === 2) {
      const distance = Math.hypot(element.center[0] - cx, element.center[1] - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = element;
      }
    }
  }
  return best;
}

export function pickFuzzyMatch(elements, hints, center, radius = 120) {
  const pool = filterByRadius(elements, center, radius);
  if (!pool.length) return null;
  const fuzzyTerms = [];
  if (Array.isArray(hints?.text_contains)) fuzzyTerms.push(...hints.text_contains);
  if (typeof hints?.text_partial === 'string') fuzzyTerms.push(hints.text_partial);
  const normalized = fuzzyTerms.map(normalizeText).filter(Boolean);
  if (!normalized.length) return pool[0];
  for (const term of normalized) {
    const match = pool.find((element) => normalizeText(element.name).includes(term));
    if (match) return match;
  }
  return pool[0];
}
