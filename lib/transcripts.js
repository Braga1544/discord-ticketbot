'use strict';

async function saveTranscript(pool, t) {
  await pool.query(
    `INSERT INTO ticketbot_transcripts
       (channel_name, category, creator_discord_id, creator_name, opened_at, closed_at,
        closed_by_id, closed_by_name, content, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bot')
     ON DUPLICATE KEY UPDATE category = VALUES(category), closed_at = VALUES(closed_at),
       closed_by_id = VALUES(closed_by_id), closed_by_name = VALUES(closed_by_name),
       content = VALUES(content)`,
    [t.channelName, t.category ?? null, t.creatorId ?? null, t.creatorName ?? null,
      t.openedAt ?? null, t.closedAt ?? null, t.closedById ?? null,
      t.closedByName ?? null, t.content]
  );
}

const SAVE_TIMEOUT_MS = 10 * 1000;

// must never block closing, not even a hanging db call -> just log after limitMs
async function persistTranscriptSafe(saveFn, t, log = console.error, limitMs = SAVE_TIMEOUT_MS) {
  const report = (...args) => {
    try { log(...args); } catch { /* ignore */ }
  };
  let timer = null;
  try {
    const saving = Promise.resolve().then(() => saveFn(t));
    // a late error must not become an unhandled rejection
    saving.catch(() => {});
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve('limit'), limitMs);
    });
    const result = await Promise.race([saving.then(() => 'ok'), limit]);
    if (result === 'limit') {
      report(`could not save transcript to db: timed out after ${limitMs} ms`);
    }
  } catch (err) {
    report('could not save transcript to db:', err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TIMESTAMP = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/;

function toDate(match) {
  if (!match) return null;
  const d = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "<user>_<ddMMyyyyHHmmss>_<category>.txt", never throws
function parseLegacyTranscript(fileName, text) {
  const content = String(text ?? '');
  const base = String(fileName).replace(/^.*[\/]/, '').replace(/\.txt$/i, '');
  const parts = base.split('_');
  let creatorName = base;
  let category = null;
  if (parts.length >= 3 && /^\d{14}$/.test(parts[parts.length - 2])) {
    category = parts[parts.length - 1] || null;
    creatorName = parts.slice(0, -2).join('_');
  }

  const rowList = content.split(/\r?\n/);
  const idMatch = /<@(\d{17,20})>/.exec(rowList[0] || '');
  let first = null;
  let last = null;
  for (const row of rowList) {
    const m = TIMESTAMP.exec(row);
    if (m) {
      if (!first) first = m;
      last = m;
    }
  }
  return {
    channelName: base,
    category,
    creatorName,
    creatorId: idMatch ? idMatch[1] : null,
    openedAt: toDate(first),
    closedAt: toDate(last),
    content,
  };
}

// true = new, false = already there
async function importLegacyTranscript(pool, t) {
  const [res] = await pool.query(
    `INSERT IGNORE INTO ticketbot_transcripts
       (channel_name, category, creator_discord_id, creator_name, opened_at, closed_at, content, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'import')`,
    [t.channelName, t.category, t.creatorId, t.creatorName, t.openedAt, t.closedAt, t.content]
  );
  return res.affectedRows > 0;
}

module.exports = { saveTranscript, persistTranscriptSafe, parseLegacyTranscript, importLegacyTranscript };
