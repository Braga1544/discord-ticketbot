'use strict';
// config.json -> ticketbot_* rows

const RR_RUNTIME_FIELDS = ['extensionUntilMs', 'extensionForDay', 'lastWarnedEffectiveEndIso', 'lastClosedEffectiveEndIso'];

function textOrNull(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

// rows the way buildConfig expects them, ids from 1, plus state
function configToRows(json) {
  const list = (a) => JSON.stringify(Array.isArray(a) ? a : []);
  const setting = (setting_key, value) => ({ setting_key, value: textOrNull(value) });
  const bl = json.banLog || {};

  const settings = [
    setting('guild_id', json.guildId),
    setting('team_role_id', json.teamRoleId),
    setting('user_role_id', json.userRoleId),
    setting('admin_role_ids', list(json.adminRoleIds)),
    setting('ticket_channel_id', json.ticketChannelId),
    setting('archive_channel_id', json.archiveChannelId),
    setting('role_command_channel_id', json.roleCommandChannelId),
    setting('voice_notification_channel_id', json.voiceNotificationChannelId),
    setting('reaction_log_channel_id', json.reactionLogChannelId),
    setting('banlog_input_channel_id', bl.inputChannelId),
    setting('banlog_output_channel_id', bl.outputChannelId),
    setting('banlog_reasons', list(bl.reasons)),
  ];

  const categories = (json.categories || []).map((c, i) => ({
    id: i + 1, sort: i + 1, name: c.name, discord_category_id: c.categoryId, default_roles: list(c.defaultRoleIds),
  }));
  const subteams = (json.subteams || []).map((s, i) => ({ id: i + 1, sort: i + 1, name: s.name, roles: list(s.roleIds) }));
  const voiceGroups = (json.voiceGroups || []).map((v, i) => ({
    id: i + 1, name: v.name, channel_ids: list(v.channelIds), ping_roles: list(v.pingRoleIds),
  }));

  const roleManagers = [];
  const assignableRows = [];
  (json.roleManagement || []).forEach((m, i) => {
    roleManagers.push({ id: i + 1, name: `Group ${i + 1}`, manager_roles: list(m.managerRoleIds) });
    for (const r of m.assignableRoles || []) {
      assignableRows.push({ id: assignableRows.length + 1, manager_id: i + 1, role_id: r.id, name: r.name });
    }
  });

  const rrState = {};
  const reactionRoles = (json.reactionRoles || []).map((r, i) => {
    const id = i + 1;
    const runtime = {};
    for (const field of RR_RUNTIME_FIELDS) {
      if (r[field] !== undefined && r[field] !== null && r[field] !== '') runtime[field] = r[field];
    }
    if (Object.keys(runtime).length > 0) rrState[id] = runtime;
    return {
      id, sort: i + 1, role_id: r.roleId, channel_id: r.channelId,
      required_role_id: textOrNull(r.requiredRoleId),
      min_account_age_days: Number(r.minAccountAgeDays) || 0,
      start_time: textOrNull(r.startTime), end_time: textOrNull(r.endTime),
      message_id: textOrNull(r.messageId),
    };
  });

  const state = { rr_state: JSON.stringify(rrState) };
  if (bl.panelMessageId) state.banlog_panel_message_id = String(bl.panelMessageId);

  return { settings, categories, subteams, voiceGroups, reactionRoles, roleManagers, assignableRows, state };
}

async function insertRows(pool, table_name, rowList) {
  for (const z of rowList) {
    const columns = Object.keys(z);
    await pool.query(
      `INSERT INTO ${table_name} (${columns.map((s) => `\`${s}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((s) => z[s])
    );
  }
}

async function hasConfig(pool) {
  for (const t of ['settings', 'categories', 'subteams', 'voice_groups', 'reaction_roles', 'role_managers']) {
    const [r] = await pool.query(`SELECT COUNT(*) AS n FROM ticketbot_${t}`);
    if (Number(r[0].n) > 0) return true;
  }
  return false;
}

// one transaction, nothing half-written on errors and the next start tries again
async function writeRows(pool, rows) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await insertRows(conn, 'ticketbot_settings', rows.settings);
    await insertRows(conn, 'ticketbot_categories', rows.categories);
    await insertRows(conn, 'ticketbot_subteams', rows.subteams);
    await insertRows(conn, 'ticketbot_voice_groups', rows.voiceGroups);
    await insertRows(conn, 'ticketbot_reaction_roles', rows.reactionRoles);
    await insertRows(conn, 'ticketbot_role_managers', rows.roleManagers);
    await insertRows(conn, 'ticketbot_assignable_roles', rows.assignableRows);
    for (const [setting_key, value] of Object.entries(rows.state)) {
      await conn.query(
        'INSERT INTO ticketbot_state (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [setting_key, value]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => null);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { configToRows, hasConfig, writeRows };
