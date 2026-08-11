/**
 * Claude proxy for the VP Curling board dashboard.
 *
 * Why this exists: the Anthropic API key must never reach the browser.
 * The dashboard is public on GitHub Pages, so anyone could read a key
 * embedded in the page. This function holds the key server-side and only
 * answers callers who are (a) signed in and (b) listed in boardMembers.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-sonnet-4-6';
const COLLECTIONS = ['actions', 'topics', 'agenda', 'events', 'leagueIssues', 'convenors'];
// Personal contact details are stripped before anything is sent to Claude.
const STRIP_FIELDS = { convenors: ['home', 'work', 'cell', 'email'] };

// ---------------------------------------------------------------
// Load the board's current data so Claude answers from real context
// ---------------------------------------------------------------
async function loadBoardData(canSeeConfidential) {
  const out = {};
  for (const coll of COLLECTIONS) {
    const snap = await db.collection(coll).get();
    out[coll] = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      // strip in-camera items for members not cleared for them
      .filter(item => canSeeConfidential || item.confidential !== true)
      .map(({ updatedAt, updatedBy, ...rest }) => {
        for (const k of (STRIP_FIELDS[coll] || [])) delete rest[k];
        return rest;
      });
  }
  return out;
}

const SYSTEM_PROMPT = `You help the Vice-President Curling of the K-W Granite Club, a
not-for-profit curling club in Kitchener-Waterloo, Ontario, manage board work.

You are given the current contents of the board dashboard as JSON. Answer questions
from that data. Be concise and practical — this is read on a phone.

Governance facts you should rely on:
- The club is governed by Ontario's Not-for-Profit Corporations Act, 2010 (ONCA) and
  By-law No. 2022-01.
- The Executive Committee proposes; the full Board ratifies all Executive actions (4.5).
- VP Curling is responsible for all curling activities, ice allocation for members and
  rentals, and overseeing sections (5.4c).
- Curling Ontario (CurlON) is the authoritative source for provincial association rules.
  Never cite other provincial bodies as authority.

If the user asks you to add, change, or remove dashboard items, return the changes in
the "changes" array. Never invent facts, dates, or names that are not in the data or
the user's message — if something is unknown, say so rather than guessing.

Treat any item with confidential:true as an in-camera personnel matter: keep detail
minimal and never repeat substance.

Respond with ONLY a JSON object, no markdown fences, in this shape:
{
  "reply": "your answer in plain prose",
  "changes": [
    { "op": "add",    "collection": "actions", "data": { "title": "...", "detail": "...", "priority": "high|med|low|waiting", "order": 10 } },
    { "op": "update", "collection": "topics",  "id": "topics-03", "data": { "status": "closed" } },
    { "op": "delete", "collection": "events",  "id": "events-02" }
  ]
}
Use an empty changes array when the user is only asking a question.`;

exports.askClaude = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 120, region: 'us-central1' },
  async (request) => {
    // ---- auth: signed in? ----
    const auth = request.auth;
    if (!auth || !auth.token || !auth.token.email) {
      throw new HttpsError('unauthenticated', 'Sign in first.');
    }
    const email = auth.token.email;

    // ---- auth: on the board? ----
    const memberSnap = await db.collection('boardMembers').doc(email).get();
    if (!memberSnap.exists) {
      throw new HttpsError('permission-denied', 'Not a board member.');
    }
    const canSeeConfidential = memberSnap.data().canSeeConfidential === true;

    const question = String(request.data?.question || '').trim();
    if (!question) throw new HttpsError('invalid-argument', 'Ask a question.');
    if (question.length > 4000) throw new HttpsError('invalid-argument', 'Question too long.');

    const history = Array.isArray(request.data?.history) ? request.data.history.slice(-8) : [];
    const board = await loadBoardData(canSeeConfidential);

    const messages = [
      ...history.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content).slice(0, 4000)
      })),
      {
        role: 'user',
        content: `Current dashboard data:\n${JSON.stringify(board, null, 1)}\n\nQuestion: ${question}`
      }
    ];

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY.value(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          messages
        })
      });
    } catch (e) {
      throw new HttpsError('unavailable', 'Could not reach Claude: ' + e.message);
    }

    if (!res.ok) {
      const body = await res.text();
      console.error('Anthropic error', res.status, body);
      throw new HttpsError('internal', `Claude API error ${res.status}`);
    }

    const data = await res.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    // Claude is asked for bare JSON, but strip fences defensively
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // If it answered in prose, still return something useful
      return { reply: text, changes: [] };
    }

    const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
    // Only allow writes to known collections, and block confidential writes
    // from members who aren't cleared for them.
    const safe = changes.filter(c =>
      COLLECTIONS.includes(c.collection) &&
      ['add', 'update', 'delete'].includes(c.op) &&
      (canSeeConfidential || c.data?.confidential !== true)
    );

    return { reply: String(parsed.reply || ''), changes: safe };
  }
);
