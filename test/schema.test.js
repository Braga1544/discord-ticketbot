'use strict';
// only with TEST_DATABASE_URL, skipped otherwise
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const URL_ = process.env.TEST_DATABASE_URL;
const TABLES = [
  'settings', 'categories', 'subteams', 'voice_groups', 'reaction_roles',
  'role_managers', 'assignable_roles', 'state', 'status', 'transcripts',
].map((t) => `ticketbot_${t}`);

test('ensureSchema creates all tables idempotently', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, async () => {
  const { ensureSchema } = require('../lib/db');
  const dbName = `tb_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = await mysql.createConnection(URL_);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool({ uri: URL_, database: dbName });
  try {
    await ensureSchema(pool);
    await ensureSchema(pool);
    const [rows] = await pool.query(
      'SELECT table_name AS n FROM information_schema.tables WHERE table_schema = ?', [dbName]);
    const present = rows.map((r) => r.n || r.TABLE_NAME).sort();
    assert.deepStrictEqual(present, [...TABLES].sort());
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  }
});
