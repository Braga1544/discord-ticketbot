'use strict';
// buildConfig() rebuilds the old config.json shape, index.js doesn't notice a difference

const SNOWFLAKE = /^\d{17,20}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function bySortId(a, b) {
  return (Number(a.sort) || 0) - (Number(b.sort) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0);
}

function sorted(rowList) {
  return [...(rowList || [])].sort(bySortId);
}

// invalid -> undefined + entry in errors
function validators(errors) {
  const snowflake = (value, where, required) => {
    if (isBlank(value)) {
      if (required) errors.push(`${where}: required`);
      return undefined;
    }
    const text = String(value).trim();
    if (!SNOWFLAKE.test(text)) {
      errors.push(`${where}: invalid discord id "${text}"`);
      return undefined;
    }
    return text;
  };

  // json array as text, snowflakes=true -> discord ids only
  const list = (value, where, snowflakes) => {
    if (isBlank(value)) return [];
    let data;
    try {
      data = JSON.parse(String(value));
    } catch (err) {
      errors.push(`${where}: invalid json`);
      return [];
    }
    if (!Array.isArray(data)) {
      errors.push(`${where}: must be a json array`);
      return [];
    }
    const result = [];
    for (const entry of data) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        errors.push(`${where}: entry "${entry}" is not a string`);
      } else if (snowflakes && !SNOWFLAKE.test(entry)) {
        errors.push(`${where}: invalid discord id "${entry}"`);
      } else {
        result.push(entry);
      }
    }
    return result;
  };


  return { snowflake, list };
}

function buildConfig(rows) {
  const errors = [];
  const warnings = [];
  const { snowflake, list } = validators(errors);
  const settings = {};
  for (const row of (rows && rows.settings) || []) settings[row.setting_key] = row.value;
  const s = (setting_key) => settings[setting_key];

  // message_id belongs to the bot, broken -> drop and recreate instead of blocking startup
  const botMessageId = (value, where) => {
    if (isBlank(value)) return undefined;
    const t = String(value).trim();
    if (SNOWFLAKE.test(t)) return t;
    warnings.push(`${where}: dropping invalid message id "${t}"`);
    return undefined;
  };

  const config = {
    guildId: snowflake(s('guild_id'), 'guild_id', true),
    adminRoleIds: list(s('admin_role_ids'), 'admin_role_ids', true),
    teamRoleId: snowflake(s('team_role_id'), 'team_role_id', true),
    userRoleId: snowflake(s('user_role_id'), 'user_role_id', false),
    subteams: sorted(rows && rows.subteams).map((z) => ({
      name: String(z.name),
      roleIds: list(z.roles, `subteams[${z.id}].roles`, true),
    })),
    ticketChannelId: snowflake(s('ticket_channel_id'), 'ticket_channel_id', true),
    archiveChannelId: snowflake(s('archive_channel_id'), 'archive_channel_id', true),
    categories: sorted(rows && rows.categories).map((z) => ({
      name: String(z.name),
      categoryId: snowflake(z.discord_category_id, `categories[${z.id}].discord_category_id`, true),
      defaultRoleIds: list(z.default_roles, `categories[${z.id}].default_roles`, true),
    })),
    roleCommandChannelId: snowflake(s('role_command_channel_id'), 'role_command_channel_id', false),
    roleManagement: sorted(rows && rows.roleManagers).map((m) => ({
      managerRoleIds: list(m.manager_roles, `role_managers[${m.id}].manager_roles`, true),
      assignableRoles: sorted((rows.assignableRows || []).filter((v) => v.manager_id === m.id)).map((v) => ({
        id: snowflake(v.role_id, `assignable_roles[${v.id}].role_id`, true),
        name: String(v.name),
      })),
    })),
    voiceNotificationChannelId: snowflake(s('voice_notification_channel_id'), 'voice_notification_channel_id', false),
    voiceGroups: sorted(rows && rows.voiceGroups).map((z) => ({
      name: String(z.name),
      channelIds: list(z.channel_ids, `voice_groups[${z.id}].channel_ids`, true),
      pingRoleIds: list(z.ping_roles, `voice_groups[${z.id}].ping_roles`, true),
    })),
    banLog: {
      inputChannelId: snowflake(s('banlog_input_channel_id'), 'banlog_input_channel_id', false),
      outputChannelId: snowflake(s('banlog_output_channel_id'), 'banlog_output_channel_id', false),
      panelMessageId: undefined, // comes from state
      reasons: list(s('banlog_reasons'), 'banlog_reasons', false),
    },
    reactionLogChannelId: snowflake(s('reaction_log_channel_id'), 'reaction_log_channel_id', false),
    reactionRoles: sorted(rows && rows.reactionRoles).map((z) => {
      const where = `reaction_roles[${z.id}]`;
      const hhmm = (value, field) => {
        if (isBlank(value)) return undefined;
        const t = String(value).trim();
        if (!HHMM.test(t)) {
          errors.push(`${where}.${field}: expected HH:MM, got "${t}"`);
          return undefined;
        }
        return t;
      };
      return {
        dbId: z.id,
        roleId: snowflake(z.role_id, `${where}.role_id`, true),
        channelId: snowflake(z.channel_id, `${where}.channel_id`, true),
        requiredRoleId: snowflake(z.required_role_id, `${where}.required_role_id`, false),
        messageId: botMessageId(z.message_id, `${where}.message_id`),
        minAccountAgeDays: Number(z.min_account_age_days) || 0,
        startTime: hhmm(z.start_time, 'start_time'),
        endTime: hhmm(z.end_time, 'end_time'),
      };
    }),
  };

  return { config, errors, warnings };
}

async function readState(pool, key) {
  const [rows] = await pool.query('SELECT value FROM ticketbot_state WHERE setting_key = ?', [key]);
  return rows.length > 0 && rows[0].value !== undefined ? rows[0].value : null;
}

async function writeState(pool, key, value) {
  await pool.query(
    'INSERT INTO ticketbot_state (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, value]
  );
}

// rr runtime values (extension, warn/close markers)
const RR_RUNTIME_FIELDS = ['extensionUntilMs', 'extensionForDay', 'lastWarnedEffectiveEndIso', 'lastClosedEffectiveEndIso'];

function collectRrState(config) {
  const state = {};
  for (const rr of config.reactionRoles || []) {
    if (rr.dbId === undefined) continue;
    const vals = {};
    for (const field of RR_RUNTIME_FIELDS) {
      if (rr[field] !== undefined && rr[field] !== null && rr[field] !== '') vals[field] = rr[field];
    }
    if (Object.keys(vals).length > 0) state[rr.dbId] = vals;
  }
  return state;
}

function applyRrState(config, state) {
  if (!state || typeof state !== 'object') return;
  for (const rr of config.reactionRoles || []) {
    const vals = state[rr.dbId];
    if (!vals || typeof vals !== 'object') continue;
    for (const field of RR_RUNTIME_FIELDS) {
      if (vals[field] !== undefined) rr[field] = vals[field];
    }
  }
}

async function loadRows(pool) {
  const select = async (sql) => (await pool.query(sql))[0];
  return {
    settings: await select('SELECT setting_key, value FROM ticketbot_settings'),
    categories: await select('SELECT * FROM ticketbot_categories ORDER BY sort, id'),
    subteams: await select('SELECT * FROM ticketbot_subteams ORDER BY sort, id'),
    voiceGroups: await select('SELECT * FROM ticketbot_voice_groups ORDER BY id'),
    reactionRoles: await select('SELECT * FROM ticketbot_reaction_roles ORDER BY sort, id'),
    roleManagers: await select('SELECT * FROM ticketbot_role_managers ORDER BY id'),
    assignableRows: await select('SELECT * FROM ticketbot_assignable_roles ORDER BY id'),
  };
}

// highest change id for ticketbot_*, 0 without the table. with `since` only scan the pk range after it
async function readChangeId(pool, since = 0) {
  const after = Number(since) || 0;
  try {
    const [rows] = after > 0
      ? await pool.query(
        "SELECT MAX(id) AS m FROM config_change_log WHERE id > ? AND table_name LIKE 'ticketbot\\_%'", [after])
      : await pool.query("SELECT MAX(id) AS m FROM config_change_log WHERE table_name LIKE 'ticketbot\\_%'");
    const m = Number(rows[0] && rows[0].m) || 0;
    return Math.max(m, after);
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return after;
    throw err;
  }
}

// read the change id before the rows, otherwise a change during loading gets lost
async function loadConfig(pool) {
  const changeId = await readChangeId(pool);
  const rows = await loadRows(pool);
  const { config, errors, warnings } = buildConfig(rows);

  const panelId = await readState(pool, 'banlog_panel_message_id');
  if (panelId && SNOWFLAKE.test(panelId.trim())) config.banLog.panelMessageId = panelId.trim();

  const rrText = await readState(pool, 'rr_state');
  if (rrText) {
    try {
      applyRrState(config, JSON.parse(rrText));
    } catch (err) {
      console.warn(`ignoring unreadable rr_state (${err.message})`);
    }
  }
  return { config, errors, warnings, changeId };
}

// only what the bot owns (rr message_id, rr_state, banlog panel), the rest comes from outside
async function saveBotState(pool, config) {
  for (const rr of config.reactionRoles || []) {
    if (rr.dbId === undefined) continue;
    await pool.query('UPDATE ticketbot_reaction_roles SET message_id = ? WHERE id = ?', [rr.messageId || null, rr.dbId]);
  }
  await writeState(pool, 'rr_state', JSON.stringify(collectRrState(config)));
  if (config.banLog && config.banLog.panelMessageId) {
    await writeState(pool, 'banlog_panel_message_id', String(config.banLog.panelMessageId));
  }
}

async function writeErrorStatus(pool, errorText) {
  await pool.query(
    'INSERT INTO ticketbot_status (id, last_error, error_at) VALUES (1, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE last_error = VALUES(last_error), error_at = VALUES(error_at)',
    [errorText, new Date()]
  );
}

const STATUS_COLUMNS = ['bot_tag', 'started_at', 'config_loaded_at', 'config_change_id', 'last_error', 'error_at'];

// only the given columns, null resets
async function writeStatus(pool, fields) {
  const columns = STATUS_COLUMNS.filter((name) => fields[name] !== undefined);
  if (columns.length === 0) return;
  const list = columns.map((name) => `\`${name}\``).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const update = columns.map((name) => `\`${name}\` = VALUES(\`${name}\`)`).join(', ');
  await pool.query(
    `INSERT INTO ticketbot_status (id, ${list}) VALUES (1, ${placeholders}) ON DUPLICATE KEY UPDATE ${update}`,
    columns.map((name) => fields[name])
  );
}

module.exports = { buildConfig, loadConfig, saveBotState, readState, writeState, writeErrorStatus, writeStatus, readChangeId };
