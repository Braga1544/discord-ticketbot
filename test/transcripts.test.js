'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseLegacyTranscript, persistTranscriptSafe } = require('../lib/transcripts');

test('parseLegacyTranscript reads the fixture', () => {
  const name = 'testuser_09012026124012_bugreport.txt';
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const t = parseLegacyTranscript(name, text);
  assert.strictEqual(t.channelName, 'testuser_09012026124012_bugreport');
  assert.strictEqual(t.creatorId, '111111111111111111');
  assert.strictEqual(t.category, 'bugreport');
  assert.strictEqual(t.creatorName, 'testuser');
  assert.strictEqual(t.openedAt.toISOString(), '2026-01-09T11:40:12.000Z');
  assert.strictEqual(t.closedAt.toISOString(), '2026-01-09T11:40:17.000Z');
  assert.strictEqual(t.content, text);
});

test('parseLegacyTranscript: underscore in username', () => {
  const t = parseLegacyTranscript('_reasons_02042026215353_gewerbesupport-konzepte.txt',
    '[2026-04-02 19:53:53] Bot#0001: Hallo <@123456789012345678>,\nzweite Zeile\n[2026-04-02 20:10:00] x: ok');
  assert.strictEqual(t.creatorName, '_reasons');
  assert.strictEqual(t.category, 'gewerbesupport-konzepte');
  assert.strictEqual(t.creatorId, '123456789012345678');
  assert.strictEqual(t.closedAt.toISOString(), '2026-04-02T20:10:00.000Z');
});

test('parseLegacyTranscript: no timestamp lines, no dates, no throw', () => {
  const t = parseLegacyTranscript('a_b_01012026000000_support.txt', 'nur Text\nohne Zeit');
  assert.strictEqual(t.openedAt, null);
  assert.strictEqual(t.closedAt, null);
  assert.strictEqual(t.creatorId, null);
  assert.strictEqual(t.creatorName, 'a_b');
});

test('parseLegacyTranscript: odd file name does not throw', () => {
  const t = parseLegacyTranscript('weird.txt', '');
  assert.strictEqual(t.channelName, 'weird');
  assert.strictEqual(t.category, null);
});

test('persistTranscriptSafe swallows errors and logs', async () => {
  const logs = [];
  await persistTranscriptSafe(async () => { throw new Error('db gone'); }, { channelName: 'x' }, (...a) => logs.push(a));
  assert.strictEqual(logs.length, 1);
  assert.match(String(logs[0][1] && logs[0][1].message || logs[0].join(' ')), /db gone/);
});

test('persistTranscriptSafe calls saveFn on success', async () => {
  let got = null;
  await persistTranscriptSafe(async (t) => { got = t; }, { channelName: 'y' }, () => assert.fail());
  assert.deepStrictEqual(got, { channelName: 'y' });
});

test('import is idempotent, bot saves and imports coexist (db)', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const crypto = require('node:crypto');
  const mysql = require('mysql2/promise');
  const { ensureSchema } = require('../lib/db');
  const { saveTranscript, importLegacyTranscript } = require('../lib/transcripts');
  const dbName = `tb_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = await mysql.createConnection(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool({ uri: process.env.TEST_DATABASE_URL, database: dbName, timezone: 'Z' });
  try {
    await ensureSchema(pool);
    const name = 'testuser_09012026124012_bugreport.txt';
    const t = parseLegacyTranscript(name, fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
    assert.strictEqual(await importLegacyTranscript(pool, t), true);
    assert.strictEqual(await importLegacyTranscript(pool, t), false);
    await saveTranscript(pool, { ...t, closedById: '1', closedByName: 'x#1' });
    const [rows] = await pool.query('SELECT source, opened_at FROM ticketbot_transcripts ORDER BY source');
    assert.deepStrictEqual(rows.map((r) => r.source), ['bot', 'import']);
    assert.strictEqual(rows[0].opened_at.toISOString(), '2026-01-09T11:40:12.000Z');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  }
});

test('persistTranscriptSafe: hanging save is cut off after the timeout and logged', async () => {
  const reports = [];
  const start = Date.now();
  await persistTranscriptSafe(() => new Promise(() => {}), {}, (...a) => reports.push(a.join(' ')), 30);
  assert.ok(Date.now() - start < 1000);
  assert.strictEqual(reports.length, 1);
  assert.match(reports[0], /timed out/);
});

test('persistTranscriptSafe: error after the timeout causes no unhandled rejection', async () => {
  const reports = [];
  await persistTranscriptSafe(() => new Promise((_, nein) => setTimeout(() => nein(new Error('late')), 60)), {}, (...a) => reports.push(a), 10);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(reports.length, 1);
});

test('persistTranscriptSafe: fast success and fast failure as before', async () => {
  const reports = [];
  let saved = 0;
  await persistTranscriptSafe(async () => { saved++; }, {}, (...a) => reports.push(a), 1000);
  await persistTranscriptSafe(async () => { throw new Error('broken'); }, {}, (...a) => reports.push(a), 1000);
  assert.strictEqual(saved, 1);
  assert.strictEqual(reports.length, 1);
});
