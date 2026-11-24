'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { buildConfig, loadConfig, saveBotState, readState, writeState, writeErrorStatus, writeStatus, readChangeId } = require('../lib/config-db');

const ID = (n) => `14000000000000000${String(n).padStart(2, '0')}`; // 19 digits

function settingRows(obj) {
  return Object.entries(obj).map(([setting_key, value]) => ({ setting_key, value }));
}

function fullRows() {
  return {
    settings: settingRows({
      guild_id: ID(1),
      team_role_id: ID(2),
      user_role_id: ID(12),
      admin_role_ids: JSON.stringify([ID(3), ID(4)]),
      ticket_channel_id: ID(5),
      archive_channel_id: ID(6),
      role_command_channel_id: ID(7),
      voice_notification_channel_id: ID(8),
      reaction_log_channel_id: ID(9),
      banlog_input_channel_id: ID(10),
      banlog_output_channel_id: ID(11),
      banlog_reasons: JSON.stringify(['Spam', 'Harassment']),
    }),
    // unsorted on purpose
    categories: [
      { id: 2, sort: 2, name: 'Second', discord_category_id: ID(21), default_roles: JSON.stringify([ID(31)]) },
      { id: 1, sort: 1, name: 'First', discord_category_id: ID(20), default_roles: JSON.stringify([ID(30), ID(31)]) },
    ],
    subteams: [
      { id: 5, sort: 2, name: 'Moderation', roles: JSON.stringify([ID(41)]) },
      { id: 4, sort: 1, name: 'Support', roles: JSON.stringify([ID(40)]) },
    ],
    voiceGroups: [
      { id: 1, name: 'Waiting room', channel_ids: JSON.stringify([ID(50)]), ping_roles: JSON.stringify([ID(51)]) },
    ],
    reactionRoles: [
      { id: 8, sort: 2, role_id: ID(61), channel_id: ID(62), required_role_id: null, min_account_age_days: 0, start_time: '', end_time: null, message_id: null },
      { id: 7, sort: 1, role_id: ID(60), channel_id: ID(62), required_role_id: ID(63), min_account_age_days: 30, start_time: '18:00', end_time: '23:30', message_id: ID(64) },
    ],
    roleManagers: [{ id: 1, name: 'Verified', manager_roles: JSON.stringify([ID(70)]) }],
    assignableRows: [
      { id: 2, manager_id: 1, role_id: ID(72), name: 'Second' },
      { id: 1, manager_id: 1, role_id: ID(71), name: 'First' },
    ],
  };
}

test('buildConfig: full rows give the old config.json shape (sorted)', () => {
  const { config, errors } = buildConfig(fullRows());
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(config, {
    guildId: ID(1),
    adminRoleIds: [ID(3), ID(4)],
    teamRoleId: ID(2),
    userRoleId: ID(12),
    subteams: [
      { name: 'Support', roleIds: [ID(40)] },
      { name: 'Moderation', roleIds: [ID(41)] },
    ],
    ticketChannelId: ID(5),
    archiveChannelId: ID(6),
    categories: [
      { name: 'First', categoryId: ID(20), defaultRoleIds: [ID(30), ID(31)] },
      { name: 'Second', categoryId: ID(21), defaultRoleIds: [ID(31)] },
    ],
    roleCommandChannelId: ID(7),
    roleManagement: [
      {
        managerRoleIds: [ID(70)],
        assignableRoles: [{ id: ID(71), name: 'First' }, { id: ID(72), name: 'Second' }],
      },
    ],
    voiceNotificationChannelId: ID(8),
    voiceGroups: [{ name: 'Waiting room', channelIds: [ID(50)], pingRoleIds: [ID(51)] }],
    banLog: { inputChannelId: ID(10), outputChannelId: ID(11), panelMessageId: undefined, reasons: ['Spam', 'Harassment'] },
    reactionLogChannelId: ID(9),
    reactionRoles: [
      { dbId: 7, roleId: ID(60), channelId: ID(62), requiredRoleId: ID(63), messageId: ID(64), minAccountAgeDays: 30, startTime: '18:00', endTime: '23:30' },
      { dbId: 8, roleId: ID(61), channelId: ID(62), requiredRoleId: undefined, messageId: undefined, minAccountAgeDays: 0, startTime: undefined, endTime: undefined },
    ],
  });
});

test('buildConfig: invalid bot-owned message_id is dropped (warning, not error)', () => {
  const rows = fullRows();
  rows.reactionRoles[1].message_id = 'broken';
  const { config, errors, warnings } = buildConfig(rows);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(config.reactionRoles[0].messageId, undefined);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /reaction_roles\[7\]\.message_id/);
});

test('buildConfig: broken json in admin_role_ids reports the key', () => {
  const rows = fullRows();
  rows.settings.find((e) => e.setting_key === 'admin_role_ids').value = 'kein json';
  const { errors } = buildConfig(rows);
  assert.ok(errors.some((f) => f.includes('admin_role_ids')), errors.join('; '));
});

test('buildConfig: missing required ids are errors', () => {
  for (const key of ['guild_id', 'team_role_id', 'ticket_channel_id', 'archive_channel_id']) {
    const rows = fullRows();
    rows.settings = rows.settings.filter((e) => e.setting_key !== key);
    const { errors } = buildConfig(rows);
    assert.ok(errors.some((f) => f.includes(key)), `${key}: ${errors.join('; ')}`);
  }
});

test('buildConfig: invalid snowflake and blank required value', () => {
  const rows = fullRows();
  rows.settings.find((e) => e.setting_key === 'guild_id').value = '123';
  rows.settings.find((e) => e.setting_key === 'team_role_id').value = '  ';
  const { errors } = buildConfig(rows);
  assert.ok(errors.some((f) => f.includes('guild_id')));
  assert.ok(errors.some((f) => f.includes('team_role_id')));
});

test('buildConfig: errors in lists and table rows name the row', () => {
  const rows = fullRows();
  rows.categories[0].default_roles = '["abc"]';
  rows.reactionRoles[0].start_time = '25:99';
  const { errors } = buildConfig(rows);
  assert.ok(errors.some((f) => f.includes('categories[2].default_roles')), errors.join('; '));
  assert.ok(errors.some((f) => f.includes('reaction_roles[8].start_time')), errors.join('; '));
});

test('buildConfig: empty start_time gives startTime undefined', () => {
  const rows = fullRows();
  rows.reactionRoles[0].start_time = '';
  const { config } = buildConfig(rows);
  const rr = config.reactionRoles.find((r) => r.dbId === 8);
  assert.strictEqual(rr.startTime, undefined);
  assert.strictEqual(rr.endTime, undefined);
});


const URL_ = process.env.TEST_DATABASE_URL;

test('db: loadConfig, saveBotState and state', { skip: !URL_ && 'TEST_DATABASE_URL not set' }, async () => {
  const { ensureSchema } = require('../lib/db');
  const dbName = `tb_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = await mysql.createConnection(URL_);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool({ uri: URL_, database: dbName, timezone: 'Z' });
  try {
    await ensureSchema(pool);
    const rows = fullRows();
    for (const e of rows.settings) {
      await pool.query('INSERT INTO ticketbot_settings (setting_key, value) VALUES (?, ?)', [e.setting_key, e.value]);
    }
    for (const k of rows.categories) {
      await pool.query('INSERT INTO ticketbot_categories (id, sort, name, discord_category_id, default_roles) VALUES (?,?,?,?,?)',
        [k.id, k.sort, k.name, k.discord_category_id, k.default_roles]);
    }
    for (const r of rows.reactionRoles) {
      await pool.query(
        'INSERT INTO ticketbot_reaction_roles (id, sort, role_id, channel_id, required_role_id, min_account_age_days, start_time, end_time, message_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [r.id, r.sort, r.role_id, r.channel_id, r.required_role_id, r.min_account_age_days, r.start_time || null, r.end_time, r.message_id]);
    }
    await pool.query('INSERT INTO ticketbot_role_managers (id, name, manager_roles) VALUES (1, ?, ?)', ['M', rows.roleManagers[0].manager_roles]);
    await pool.query('INSERT INTO ticketbot_assignable_roles (manager_id, role_id, name) VALUES (1, ?, ?)', [ID(71), 'First']);

    // no config_change_log -> changeId 0
    let res = await loadConfig(pool);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(res.changeId, 0);
    assert.deepStrictEqual(res.config.categories.map((c) => c.name), ['First', 'Second']);
    assert.deepStrictEqual(res.config.reactionRoles.map((r) => r.dbId), [7, 8]);
    assert.strictEqual(res.config.reactionRoles[0].minAccountAgeDays, 30);
    assert.strictEqual(res.config.reactionRoles[1].startTime, undefined);
    assert.deepStrictEqual(res.config.roleManagement[0].assignableRoles, [{ id: ID(71), name: 'First' }]);

    // with config_change_log -> highest id of the ticketbot tables
    await pool.query('CREATE TABLE config_change_log (id BIGINT AUTO_INCREMENT PRIMARY KEY, table_name VARCHAR(100))');
    await pool.query("INSERT INTO config_change_log (table_name) VALUES ('ticketbot_categories'), ('other_table'), ('ticketbot_subteams'), ('lrpXticketbotXx'), ('other_table')");
    res = await loadConfig(pool);
    assert.strictEqual(res.changeId, 3);

    // from the last id, stays the same without new entries
    assert.strictEqual(await readChangeId(pool, 3), 3);
    assert.strictEqual(await readChangeId(pool, 1), 3);
    assert.strictEqual(await readChangeId(pool, 0), 3);
    await pool.query("INSERT INTO config_change_log (table_name) VALUES ('ticketbot_settings')");
    assert.strictEqual(await readChangeId(pool, 3), 6);
    assert.strictEqual(await readChangeId(pool, 6), 6);
    // other tables don't count
    await pool.query("INSERT INTO config_change_log (table_name) VALUES ('other_table')");
    assert.strictEqual(await readChangeId(pool, 6), 6);

    const cfg = res.config;
    cfg.reactionRoles[1].messageId = ID(80);
    cfg.reactionRoles[0].extensionUntilMs = 1234;
    cfg.reactionRoles[0].extensionForDay = '2026-11-23';
    cfg.banLog.panelMessageId = ID(81);
    await saveBotState(pool, cfg);

    const [[rr8]] = await pool.query('SELECT message_id FROM ticketbot_reaction_roles WHERE id = 8');
    assert.strictEqual(rr8.message_id, ID(80));
    const [[category]] = await pool.query('SELECT name FROM ticketbot_categories WHERE id = 1');
    assert.strictEqual(category.name, 'First'); // foreign data stays

    res = await loadConfig(pool);
    assert.strictEqual(res.config.reactionRoles[1].messageId, ID(80));
    assert.strictEqual(res.config.reactionRoles[0].extensionUntilMs, 1234);
    assert.strictEqual(res.config.reactionRoles[0].extensionForDay, '2026-11-23');
    assert.strictEqual(res.config.banLog.panelMessageId, ID(81));
    assert.strictEqual(await readState(pool, 'banlog_panel_message_id'), ID(81));

    assert.strictEqual(await readState(pool, 'test_state'), null);
    await writeState(pool, 'test_state', '{"a":1}');
    await writeState(pool, 'test_state', '{"a":2}');
    assert.strictEqual(await readState(pool, 'test_state'), '{"a":2}');

    await writeErrorStatus(pool, 'broken');
    await writeErrorStatus(pool, 'noch moreBroken');
    const [[st]] = await pool.query('SELECT last_error, error_at FROM ticketbot_status WHERE id = 1');
    assert.strictEqual(st.last_error, 'noch moreBroken');
    assert.ok(st.error_at instanceof Date);

    // reload clears the error, bot_tag/started_at stay
    const start = new Date('2026-11-23T10:00:00Z');
    await writeStatus(pool, { bot_tag: 'Bot#0001', started_at: start, config_loaded_at: start, config_change_id: 3, last_error: null, error_at: null });
    let [[s1]] = await pool.query('SELECT * FROM ticketbot_status WHERE id = 1');
    assert.strictEqual(s1.bot_tag, 'Bot#0001');
    assert.strictEqual(s1.started_at.getTime(), start.getTime());
    assert.strictEqual(Number(s1.config_change_id), 3);
    assert.strictEqual(s1.last_error, null);
    assert.strictEqual(s1.error_at, null);
    const later = new Date('2026-11-23T11:00:00Z');
    await writeStatus(pool, { config_loaded_at: later, config_change_id: 9, last_error: null, error_at: null });
    [[s1]] = await pool.query('SELECT * FROM ticketbot_status WHERE id = 1');
    assert.strictEqual(s1.bot_tag, 'Bot#0001');
    assert.strictEqual(s1.config_loaded_at.getTime(), later.getTime());
    assert.strictEqual(Number(s1.config_change_id), 9);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  }
});
