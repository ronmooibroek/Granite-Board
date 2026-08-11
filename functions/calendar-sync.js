/**
 * Ice Schedule calendar sync.
 *
 * Reads the club's Google Calendar and rewrites the `events` collection so the
 * dashboard timeline is always current without anyone re-typing it.
 *
 * Auth: uses the project's default service account (Application Default
 * Credentials). You share the calendar with that account's email — read-only —
 * so there are no keys to store or rotate.
 *
 * Runs nightly at 03:00 America/Toronto, and can be triggered by hand from the
 * dashboard via syncCalendarNow().
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { GoogleAuth } = require('google-auth-library');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const CALENDAR_ID = '6dmbtndn39lfjop46as3mfn03c@group.calendar.google.com';
const TZ = 'America/Toronto';

// How far forward to sync. The season runs to April, so a year covers it.
const DAYS_AHEAD = 400;
const DAYS_BACK = 7;   // keep the last week so "just finished" items still show

// Events matching these get a red marker on the timeline
const HIGHLIGHT = /executive|board meeting|agm|open house|league play|championship|playdown|fall classic/i;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "2026-08-18" -> "Aug 18";  ranges -> "Aug 21 – 23" or "Aug 30 – Sep 2" */
function displayLabel(startISO, endISO) {
  const s = new Date(startISO + 'T12:00:00');
  const e = new Date(endISO + 'T12:00:00');
  const sTxt = `${MONTHS[s.getMonth()]} ${s.getDate()}`;
  if (startISO === endISO) return sTxt;
  if (s.getMonth() === e.getMonth()) return `${sTxt} – ${e.getDate()}`;
  return `${sTxt} – ${MONTHS[e.getMonth()]} ${e.getDate()}`;
}

/** Google returns all-day end dates as exclusive; step back a day. */
function normaliseEnd(ev) {
  if (ev.end?.date) {
    const d = new Date(ev.end.date + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return (ev.end?.dateTime || ev.start?.dateTime || '').slice(0, 10);
}

function timeNote(ev) {
  if (ev.start?.date) return '';                    // all-day
  const t = s => {
    const d = new Date(s);
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2,'0')}${ap}` : `${h}${ap}`;
  };
  try { return `${t(ev.start.dateTime)}–${t(ev.end.dateTime)}`; } catch { return ''; }
}

async function fetchCalendar() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/calendar.readonly']
  });
  const client = await auth.getClient();

  const now = new Date();
  const min = new Date(now); min.setDate(min.getDate() - DAYS_BACK);
  const max = new Date(now); max.setDate(max.getDate() + DAYS_AHEAD);

  const items = [];
  let pageToken;
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`
    );
    url.searchParams.set('timeMin', min.toISOString());
    url.searchParams.set('timeMax', max.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '2500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await client.request({ url: url.toString() });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
}

async function syncEvents() {
  const raw = await fetchCalendar();

  const events = raw
    .filter(ev => ev.status !== 'cancelled' && (ev.summary || '').trim())
    .map(ev => {
      const startISO = (ev.start?.date || ev.start?.dateTime || '').slice(0, 10);
      const endISO = normaliseEnd(ev) || startISO;
      const note = timeNote(ev);
      return {
        gcalId: ev.id,
        title: (ev.summary || '').trim(),
        date: startISO,
        endDate: endISO,
        label: displayLabel(startISO, endISO),
        detail: [note, (ev.location || '').trim()].filter(Boolean).join(' · '),
        highlight: HIGHLIGHT.test(ev.summary || ''),
        source: 'calendar'
      };
    })
    .filter(e => e.date);

  // Replace everything previously synced; leave hand-added events alone.
  const existing = await db.collection('events').where('source', '==', 'calendar').get();
  const keep = new Set(events.map(e => 'gcal_' + e.gcalId.replace(/[^A-Za-z0-9_-]/g, '')));

  let batch = db.batch(), ops = 0;
  const commit = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const d of existing.docs) {
    if (!keep.has(d.id)) { batch.delete(d.ref); if (++ops >= 400) await commit(); }
  }
  for (const e of events) {
    const id = 'gcal_' + e.gcalId.replace(/[^A-Za-z0-9_-]/g, '');
    batch.set(db.collection('events').doc(id),
      { ...e, updatedBy: 'calendar-sync', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true });
    if (++ops >= 400) await commit();
  }
  await commit();

  await db.collection('meta').doc('calendarSync').set({
    lastRun: admin.firestore.FieldValue.serverTimestamp(),
    count: events.length
  }, { merge: true });

  console.log(`Calendar sync: ${events.length} events`);
  return events.length;
}

// Nightly
exports.syncCalendar = onSchedule(
  { schedule: '0 3 * * *', timeZone: TZ, region: 'us-central1', timeoutSeconds: 300 },
  async () => { await syncEvents(); }
);

// Manual trigger from the dashboard
exports.syncCalendarNow = onCall(
  { cors: true, region: 'us-central1', timeoutSeconds: 300 },
  async (request) => {
    const email = request.auth?.token?.email;
    if (!email) throw new HttpsError('unauthenticated', 'Sign in first.');
    const member = await db.collection('boardMembers').doc(email).get();
    if (!member.exists) throw new HttpsError('permission-denied', 'Not a board member.');
    try {
      const n = await syncEvents();
      return { count: n };
    } catch (e) {
      console.error('sync failed', e);
      throw new HttpsError('internal',
        'Sync failed: ' + (e.message || e) +
        ' — check the Ice Schedule calendar is shared with the service account.');
    }
  }
);
