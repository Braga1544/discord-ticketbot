'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { buildConfig, loadConfig } = require('../lib/config-db');
const { configToRows } = require('../lib/config-import');
const { importSeedOnStart } = require('../lib/seed-import');

const original = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'config.json'), 'utf8'));
const RUNTIME = ['extensionUntilMs', 'extensionForDay', 'lastWarnedEffectiveEndIso', 'lastClosedEffectiveEndIso'];

// without runtime fields and panelMessageId (come from state), minAccountAgeDays defaults to 0
function expected(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  for (const rr of copy.reactionRoles) {
    for (const f of RUNTIME) delete rr[f];
    rr.minAccountAgeDays = rr.minAccountAgeDays || 0;
  }
  delete copy.banLog.panelMessageId;
  return copy;
}

// json roundtrip drops undefined, dbId ignored
function withoutDbId(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  for (const rr of copy.reactionRoles) delete rr.dbId;
  delete copy.banLog.panelMessageId;
  return copy;
}

test('roundtrip: buildConfig(configToRows(x)) equals x (minus dbId, runtime fields, panelMessageId)', () => {
  const { config, errors } = buildConfig(configToRows(original));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(withoutDbId(config), expected(original));
});

test('state: panelMessageId, runtime fields and message_id are mapped', () => {
  const x = JSON.parse(JSON.stringify(original));
  x.reactionRoles[1].extensionUntilMs = 1234567890;
  x.reactionRoles[1].lastWarnedEffectiveEndIso = '2026-01-01T10:00:00.000Z';
  const rows = configToRows(x);
  assert.strictEqual(rows.state.banlog_panel_message_id, original.banLog.panelMessageId);
  assert.deepStrictEqual(JSON.parse(rows.state.rr_state), {
    2: { extensionUntilMs: 1234567890, lastWarnedEffectiveEndIso: '2026-01-01T10:00:00.000Z' },
  });
  assert.deepStrictEqual(rows.reactionRoles.map((r) => r.message_id), original.reactionRoles.map((r) => r.messageId));
  assert.strictEqual(rows.settings.find((e) => e.setting_key === 'guild_id').value, original.guildId);
});

test('seed import on start: second run changes nothing (db)', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const { ensureSchema } = require('../lib/db');
  const dbName = `tb_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = await mysql.createConnection(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool({ uri: process.env.TEST_DATABASE_URL, database: dbName, timezone: 'Z' });
  const log = () => {};
  try {
    await ensureSchema(pool);
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'config.json'), path.join(seed, 'config.json'));
    fs.mkdirSync(path.join(seed, 'transcripts'));
    for (const f of fs.readdirSync(path.join(__dirname, 'fixtures')).filter((f) => f.endsWith('.txt'))) {
      fs.copyFileSync(path.join(__dirname, 'fixtures', f), path.join(seed, 'transcripts', f));
    }
    const count = fs.readdirSync(path.join(seed, 'transcripts')).filter((f) => f.endsWith('.txt')).length;
    const first = await importSeedOnStart(pool, seed, log);
    assert.strictEqual(first.configImported, true);
    assert.strictEqual(first.transcriptsImported + first.transcriptsSkipped, count);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM ticketbot_transcripts');
    assert.strictEqual(Number(n), first.transcriptsImported);

    const loaded = await loadConfig(pool);
    assert.deepStrictEqual(loaded.errors, []);
    assert.strictEqual(loaded.config.banLog.panelMessageId, original.banLog.panelMessageId);
    assert.deepStrictEqual(withoutDbId(loaded.config), expected(original));

    // the second start must not overwrite a change in the db
    await pool.query("UPDATE ticketbot_settings SET value = 'changed' WHERE setting_key = 'banlog_reasons'");
    const second = await importSeedOnStart(pool, seed, log);
    assert.deepStrictEqual(second, { configImported: false, transcriptsImported: 0, transcriptsSkipped: count, transcriptsFailed: 0 });
    const [[{ m }]] = await pool.query('SELECT COUNT(*) AS m FROM ticketbot_transcripts');
    assert.strictEqual(Number(m), Number(n));
    const [[e]] = await pool.query("SELECT value FROM ticketbot_settings WHERE setting_key = 'banlog_reasons'");
    assert.strictEqual(e.value, 'changed');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${dbName}\``);
    await admin.end();
  }
});

test('failed config import rolls back, next import works; broken transcript does not stop the rest (db)', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const { ensureSchema } = require('../lib/db');
  const { writeRows, hasConfig } = require('../lib/config-import');
  const dbName = `tb_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = await mysql.createConnection(process.env.TEST_DATABASE_URL);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool({ uri: process.env.TEST_DATABASE_URL, database: dbName, timezone: 'Z' });
  try {
    await ensureSchema(pool);
    const rows = configToRows(original);
    // last table broken (fk on manager_id)
    const broken = { ...rows, assignableRows: [...rows.assignableRows, { id: 99, manager_id: 999, role_id: '1', name: 'x' }] };
    await assert.rejects(() => writeRows(pool, broken));
    assert.strictEqual(await hasConfig(pool), false);
    for (const t of ['settings', 'categories', 'role_managers', 'state']) {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ticketbot_${t}`);
      assert.strictEqual(Number(n), 0, t);
    }
    await writeRows(pool, rows);
    assert.strictEqual(await hasConfig(pool), true);

    // one rejected transcript must not stop the rest
    const fs2 = require('node:fs');
    const os = require('node:os');
    const tmp = fs2.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
    fs2.mkdirSync(path.join(tmp, 'transcripts'));
    fs2.writeFileSync(path.join(tmp, 'transcripts', `${'boom'}_01012026120000_x.txt`), 'x');
    fs2.writeFileSync(path.join(tmp, 'transcripts', 'ok_01012026120000_x.txt'), 'y');
    const reports = [];
    const errorPool = { query: (sql, params) => (params && params[0] === 'boom_01012026120000_x' ? Promise.reject(new Error('simulated db error')) : pool.query(sql, params)) };
    const res = await importSeedOnStart(errorPool, tmp, (m) => reports.push(m));
    fs2.rmSync(tmp, { recursive: true, force: true });
    assert.strictEqual(res.transcriptsImported, 1);
    assert.strictEqual(res.transcriptsFailed, 1);
    assert.ok(reports.some((m) => /1 failed/.test(m)));
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${dbName}\``);
    await admin.end();
  }
});
