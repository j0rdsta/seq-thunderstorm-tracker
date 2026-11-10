/** Times the way BoM writes them, and matching tracker images to radar frames. */

export function formatAge(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min ago`;
}

/** Format like BoM's "Last updated" lines: "12:26 pm AEST" (Queensland time, no daylight saving). */
export function formatIssued(date) {
  const t = date.toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return `${t.replace(/\s+/g, ' ').toLowerCase()} AEST`;
}

/** Relative age in BoM's wording: "9 minutes ago", "2 hours ago". */
export function formatAgeLong(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'less than a minute ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const h = Math.floor(mins / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

export const TZ_OFFSETS_MIN = { AEST: 600, AEDT: 660, ACST: 570, ACDT: 630, AWST: 480 };
export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse the radar timeline label, e.g. "Tuesday 3 Nov,  12:20pm AEST", into a Date.
 * The year isn't shown, so pick the one that puts the date closest to `now`.
 */
export function parseTimelineLabel(text, now = new Date()) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s+(AEST|AEDT|ACST|ACDT|AWST)/i.exec(text || '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  let hour = +m[3] % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  const offset = TZ_OFFSETS_MIN[m[6].toUpperCase()];
  let best = null;
  for (const y of [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const d = new Date(Date.UTC(y, month, +m[1], hour, +m[4]) - offset * 60000);
    if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d;
  }
  return best;
}

/**
 * Choose the saved tracker image that belongs with a radar frame.
 * The tracker is issued every ~6 min from the latest radar scans, so the image for the radar
 * frame at time F is typically issued a few minutes after F. Picks the issue time closest to
 * F + leadMs, within toleranceMs; returns null when nothing saved is close enough.
 * @param {number[]} issuedTimes epoch ms
 * @param {number} frameMs epoch ms of the radar frame
 */
export function pickTrackerFrame(issuedTimes, frameMs, leadMs = 5 * 60000, toleranceMs = 7 * 60000) {
  let best = null;
  let bestDiff = Infinity;
  for (const t of issuedTimes) {
    const diff = Math.abs(t - (frameMs + leadMs));
    if (diff <= toleranceMs && diff < bestDiff) { best = t; bestDiff = diff; }
  }
  return best;
}
