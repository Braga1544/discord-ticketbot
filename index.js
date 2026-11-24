require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require('discord.js');

const banLog = require('./banlog');

const { createPool, ensureSchema } = require('./lib/db');
const { loadConfig, saveBotState, writeErrorStatus, writeStatus, readChangeId } = require('./lib/config-db');
const { saveTranscript, persistTranscriptSafe } = require('./lib/transcripts');
const { importSeedOnStart } = require('./lib/seed-import');
const { createReloader, resolveReactionRole, sameConfig, orphanedReactionMessages } = require('./lib/reload');
const { subteamOptions, findSubteam } = require('./lib/subteams');
const { t } = require('./lib/i18n');

// config comes from the db, loaded in startBot() before login
const pool = createPool(process.env);
let config = null;
let startChangeId = 0;

const TIMEZONE = 'Europe/Berlin';
const INACTIVE_MS = 3 * 24 * 60 * 60 * 1000;
// may extend reaction role windows besides team/admin
const EXTEND_SUBTEAMS = ['support', 'moderation'];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User]
});

// bot-owned state only, runs serially in the background, errors just get logged
let saveQueue = Promise.resolve();
function saveConfig() {
  saveQueue = saveQueue
    .then(() => saveBotState(pool, config))
    .catch((err) => console.error('could not write bot state to db:', err));
}

function banLogCtx() {
  return { config, saveConfig };
}

function formatTicketName(user, categoryName) {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  const dd = pad(now.getDate());
  const MM = pad(now.getMonth() + 1);
  const yyyy = now.getFullYear();
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const safeUsername = user.username.replace(/[^a-zA-Z0-9_\-]/g, '');
  const safeCategory = categoryName.replace(/[^a-zA-Z0-9_\-]/g, '');
  return `${safeUsername || user.id}_${dd}${MM}${yyyy}${hh}${mm}${ss}_${safeCategory}`;
}

function getTicketOwnerFromTopic(channel) {
  if (!channel.topic) return null;
  const match = channel.topic.match(/owner:(\d{17,20})/);
  return match ? match[1] : null;
}

function getAssignableRolesForMember(member) {
  if (!config.roleManagement) return [];
  const memberRoleIds = member.roles.cache.map((r) => r.id);
  const result = [];

  for (const manager of config.roleManagement) {
    if (manager.managerRoleIds.some((id) =>  memberRoleIds.includes(id))) {
      for (const role of manager.assignableRoles || []) {
        if (!result.some((r) => r.id === role.id)) {
          result.push(role);
        }
      }
    }
  }
  return result;
}

function getAllAssignableRoleChoices() {
  const choices = [];
  if (!config.roleManagement) return choices;

  for (const manager of config.roleManagement) {
    for (const role of manager.assignableRoles || []) {
      if (!choices.some((c) => c.value === role.id)) {
        choices.push({
          name: role.name || role.id,
          value: role.id
        });
      }
    }
  }

  // discord: max 25 choices
  return choices.slice(0, 25);
}

// account age, not server join
function getAccountAgeDays(user) {
  return Math.floor((Date.now() - user.createdTimestamp) / 86400000);
}

function getVoiceGroupForChannel(channelId) {
  if (!config.voiceGroups) return null;
  for (const group of config.voiceGroups) {
    if (group.channelIds && group.channelIds.includes(channelId)) {
      return group;
    }
  }
  return null;
}

async function ensureCategories(guild) {
  let changed = false;
  for (const cat of config.categories) {
    if (!cat.categoryId) {
      const created = await guild.channels.create({
        name: cat.name,
        type: ChannelType.GuildCategory
      });
      cat.categoryId = created.id;
      changed = true;
      console.log(`Created category "${cat.name}" -> ${created.id}`);
    }
  }
  if (changed) {
    saveConfig();
  }
}

async function setupTicketPanel(guild) {
  const ticketChannel = await guild.channels.fetch(config.ticketChannelId);
  if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
    console.error('Ticket channel not found or not a text channel');
    return;
  }

  // max 5 buttons per row
  const rows = [];
  let currentRow = new ActionRowBuilder();
  for (const cat of config.categories) {
    if (currentRow.components.length === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`openTicket_${cat.categoryId}`)
        .setLabel(cat.name)
        .setStyle(ButtonStyle.Primary)
    );
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  const panelContent = t('ticket.panel');

  const messages = await ticketChannel.messages.fetch({ limit: 50 });
  const existing = messages.find(
    (m) => m.author.id === client.user.id && m.components.length > 0
  );

  if (existing) {
    await existing.edit({ content: panelContent, components: rows });
    console.log('Updated existing ticket panel message');
  } else {
    await ticketChannel.send({ content: panelContent, components: rows });
    console.log('Sent new ticket panel message');
  }
}

async function setupReactionRoleMessages(guild) {
  if (!config.reactionRoles || config.reactionRoles.length === 0) return;

  for (let i = 0; i < config.reactionRoles.length; i++) {
    const rr = config.reactionRoles[i];

    const channel = await guild.channels.fetch(rr.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.warn(`ReactionRole channel ${rr.channelId} not found or not a text channel.`);
      continue;
    }

    let message = null;

    if (rr.messageId) {
      message = await channel.messages.fetch(rr.messageId).catch(() => null);
    }

    if (!message) {
      // id gone -> look for the button
      const customId = `rr_${rr.dbId}`;
      const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (messages) {
        message = messages.find(
          (m) =>
            m.author.id === guild.client.user.id &&
            m.components &&
            m.components.some((row) =>
              row.components.some((c) => c.customId === customId)
            )
        ) || null;
      }
    }

    if (!message) {
      message = await channel.send({ content: t('rr.initializing'), components: [] });
      rr.messageId = message.id;
      saveConfig();
      console.log(`Created reaction role message shell for index ${i} in #${channel.id}`);
    } else if (!rr.messageId) {
      rr.messageId = message.id;
      saveConfig();
    }

    await updateReactionRoleMessage(guild, i, { force: true });
  }
}

const REACTION_RR_TICK_MS = 30 * 1000;

// idx -> { lastState, lastEffectiveEndIso }, saves fetches
const reactionRoleRuntime = new Map();

function getTZParts(date, timeZone = TIMEZONE) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = dtf.formatToParts(date);
  const obj = {};
  for (const p of parts) {
    if (p.type !== 'literal') obj[p.type] = p.value;
  }
  return {
    year: Number(obj.year),
    month: Number(obj.month),
    day: Number(obj.day),
    hour: Number(obj.hour),
    minute: Number(obj.minute),
    second: Number(obj.second)
  };
}

// local time -> utc ms, corrected iteratively until it fits the tz
function makeZonedTimestampMs({ year, month, day, hour, minute }, timeZone = TIMEZONE) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let i = 0; i < 3; i++) {
    const got = getTZParts(new Date(utc), timeZone);
    const gotAsUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, 0, 0);
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const delta = desiredAsUtc - gotAsUtc;
    if (delta === 0) break;
    utc += delta;
  }
  return utc;
}

function parseHHMM(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hour: hh, minute: mm };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimeHHMMinTZ(date, timeZone = TIMEZONE) {
  const p = getTZParts(date, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function getTodayKeyInTZ(timeZone = TIMEZONE) {
  const p = getTZParts(new Date(), timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

// today's window, end <= start means past midnight
function getTodayWindowMs(rr) {
  const start = parseHHMM(rr.startTime);
  const end = parseHHMM(rr.endTime);
  if (!start || !end) return null;

  const today = getTZParts(new Date(), TIMEZONE);
  const startMs = makeZonedTimestampMs({ ...today, hour: start.hour, minute: start.minute });
  let endMs = makeZonedTimestampMs({ ...today, hour: end.hour, minute: end.minute });

  if (endMs <= startMs) {
    const tomorrow = new Date(startMs + 24 * 60 * 60 * 1000);
    const t = getTZParts(tomorrow, TIMEZONE);
    endMs = makeZonedTimestampMs({ ...t, hour: end.hour, minute: end.minute });
  }

  return {
    startMs,
    endMs,
    startStr: `${pad2(start.hour)}:${pad2(start.minute)}`,
    endStr: `${pad2(end.hour)}:${pad2(end.minute)}`
  };
}

// end incl. extension, extension only counts for that day (extensionForDay)
function getEffectiveEndMs(rr, window) {
  if (!window) return null;

  const dayKey = getTodayKeyInTZ(TIMEZONE);

  if (rr.extensionForDay && rr.extensionForDay !== dayKey) {
    delete rr.extensionForDay;
    delete rr.extensionUntilMs;
    delete rr.lastWarnedEffectiveEndIso;
    delete rr.lastClosedEffectiveEndIso;
    saveConfig();
  }

  const baseEnd = window.endMs;
  const ext = typeof rr.extensionUntilMs === 'number' ? rr.extensionUntilMs : null;

  return ext && ext > baseEnd ? ext : baseEnd;
}

function setExtension(rr, window, addMinutes) {
  const dayKey = getTodayKeyInTZ(TIMEZONE);
  rr.extensionForDay = dayKey;

  const baseEnd = window.endMs;
  const current = typeof rr.extensionUntilMs === 'number' ? rr.extensionUntilMs : null;
  const anchor = current && current > Date.now() ? current : baseEnd;
  rr.extensionUntilMs = anchor + addMinutes * 60 * 1000;

  // new end -> warning may fire again
  rr.lastWarnedEffectiveEndIso = null;

  saveConfig();
}

function isAllowedToExtend(member) {
  if (!member) return false;
  const roleIds = member.roles.cache.map((r) => r.id);

  if (roleIds.includes(config.teamRoleId)) return true;
  if (config.adminRoleIds?.some((id) => roleIds.includes(id))) return true;

  const allowed = (config.subteams || [])
    .filter((s) => EXTEND_SUBTEAMS.includes(String(s.name).toLowerCase()))
    .flatMap((s) => s.roleIds || []);
  return allowed.some((id) => roleIds.includes(id));
}

// custom ids use dbId not index, otherwise old buttons point at the wrong role after a config change
function buildReactionRoleOpenRow(dbId, roleName) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rr_${dbId}`)
      .setLabel(roleName ? t('rr.claimButton', { role: roleName }) : t('rr.claimButtonPlain'))
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildExtendRow(dbId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rrx30_${dbId}`)
      .setLabel(t('rr.extend30'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`rrx60_${dbId}`)
      .setLabel(t('rr.extend60'))
      .setStyle(ButtonStyle.Primary)
  );
}

async function fetchReactionRoleMessage(guild, idx) {
  const rr = config.reactionRoles[idx];
  if (!rr?.channelId || !rr?.messageId) return null;
  const channel = await guild.channels.fetch(rr.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  const msg = await channel.messages.fetch(rr.messageId).catch(() => null);
  return msg || null;
}

function buildBaseRRContent(guild, rr) {
  const role = guild.roles.cache.get(rr.roleId);
  const requiredRole = rr.requiredRoleId ? guild.roles.cache.get(rr.requiredRoleId) : null;

  const roleName = role?.name || rr.roleId;
  const reqName = requiredRole?.name || rr.requiredRoleId;

  return (
    t('rr.open', { role: roleName }) +
    (rr.requiredRoleId ? '\n' + t('rr.requires', { role: reqName }) : '')
  );
}

function buildClosedRRContent(guild, rr, window) {
  const role = guild.roles.cache.get(rr.roleId);
  const roleName = role?.name || rr.roleId;

  const startStr = window?.startStr || rr.startTime || '??:??';
  const endStr = window?.endStr || rr.endTime || '??:??';

  return t('rr.closedWindow', { role: roleName, start: startStr, end: endStr, suffix: t('timeSuffix') });
}

// button on/off depending on the window, no start/end = always open
async function updateReactionRoleMessage(guild, idx, { force = false } = {}) {
  const rr = config.reactionRoles[idx];
  if (!rr) return;

  const window = getTodayWindowMs(rr);

  if (!window) {
    const msg = await fetchReactionRoleMessage(guild, idx);
    if (!msg) return;

    const runtime = reactionRoleRuntime.get(idx) || { lastState: null, lastEffectiveEndIso: null };
    if (!force && runtime.lastState === 'open') return;

    const role = guild.roles.cache.get(rr.roleId);
    const roleName = role?.name || null;

    await msg.edit({
      content: buildBaseRRContent(guild, rr),
      components: [buildReactionRoleOpenRow(rr.dbId, roleName)]
    });

    reactionRoleRuntime.set(idx, { lastState: 'open', lastEffectiveEndIso: null });
    return;
  }

  const now = Date.now();
  const effectiveEndMs = getEffectiveEndMs(rr, window);
  const isOpen = now >= window.startMs && now < effectiveEndMs;

  const runtime = reactionRoleRuntime.get(idx) || { lastState: null, lastEffectiveEndIso: null };
  const effectiveEndIso = new Date(effectiveEndMs).toISOString();

  // warn 10 min before, once per end time
  const msLeft = effectiveEndMs - now;
  if (isOpen && msLeft > 0 && msLeft <= 10 * 60 * 1000) {
    if (rr.lastWarnedEffectiveEndIso !== effectiveEndIso) {
      rr.lastWarnedEffectiveEndIso = effectiveEndIso;
      saveConfig();
      await sendRRClosingSoonWarning(guild, idx, effectiveEndMs);
    }
  }

  if (force || runtime.lastState !== (isOpen ? 'open' : 'closed') || runtime.lastEffectiveEndIso !== effectiveEndIso) {
    const msg = await fetchReactionRoleMessage(guild, idx);
    if (!msg) return;

    const role = guild.roles.cache.get(rr.roleId);
    const roleName = role?.name || null;

    if (isOpen) {
      await msg.edit({
        content: buildBaseRRContent(guild, rr),
        components: [buildReactionRoleOpenRow(rr.dbId, roleName)]
      });

      // real change only, not on force (spam on every reload otherwise)
      if (runtime.lastState === 'closed') {
        await logReactionRoleEvent(guild, t('rr.openedLog', { role: role?.name || rr.roleId, start: window.startStr, end: window.endStr, suffix: t('timeSuffix') }));
      }
    } else {
      await msg.edit({
        content: buildClosedRRContent(guild, rr, window),
        components: []
      });

      if (rr.lastClosedEffectiveEndIso !== effectiveEndIso) {
        rr.lastClosedEffectiveEndIso = effectiveEndIso;
        saveConfig();
        await logReactionRoleEvent(
          guild,
          t('rr.closedLog', { role: role?.name || rr.roleId, end: formatTimeHHMMinTZ(new Date(effectiveEndMs)), suffix: t('timeSuffix') })
        );
      }
    }

    reactionRoleRuntime.set(idx, { lastState: isOpen ? 'open' : 'closed', lastEffectiveEndIso: effectiveEndIso });
  }
}

async function logReactionRoleEvent(guild, message) {
  const channelId = config.reactionLogChannelId;
  if (!channelId) return;
  const logChannel = await guild.channels.fetch(channelId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) return;
  await logChannel.send(message).catch(() => null);
}

async function sendRRClosingSoonWarning(guild, idx, effectiveEndMs) {
  const rr = config.reactionRoles[idx];
  if (!rr || !config.reactionLogChannelId) return;

  const logChannel = await guild.channels.fetch(config.reactionLogChannelId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) return;

  const role = guild.roles.cache.get(rr.roleId);
  const roleName = role?.name || rr.roleId;

  const endStr = formatTimeHHMMinTZ(new Date(effectiveEndMs));

  await logChannel.send({
    content: t('rr.closingSoon', { role: roleName, end: endStr, suffix: t('timeSuffix') }),
    components: [buildExtendRow(rr.dbId)]
  }).catch(() => null);
}

function startReactionRoleScheduler(guild) {
  for (let i = 0; i < (config.reactionRoles || []).length; i++) {
    updateReactionRoleMessage(guild, i, { force: true })
      .catch((e) => console.error('rr scheduler initial update failed:', e));
  }

  // always runs, a reload can add new ones
  setInterval(() => {
    for (let i = 0; i < (config.reactionRoles || []).length; i++) {
      updateReactionRoleMessage(guild, i).catch(() => null);
    }
  }, REACTION_RR_TICK_MS);
}

async function handleReactionRoleExtendButton(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // old format / unknown id -> null, do nothing
  const resolved = resolveReactionRole(interaction.customId, config);
  if (!resolved) {
    await interaction.reply({ content: t('rr.inactive'), ephemeral: true });
    return;
  }

  if (!isAllowedToExtend(member)) {
    await interaction.reply({
      content: t('rr.extendNotAllowed'),
      ephemeral: true
    });
    return;
  }

  const is30 = interaction.customId.startsWith('rrx30_');
  const is60 = interaction.customId.startsWith('rrx60_');
  if (!is30 && !is60) return;
  const idx = resolved.idx;
  const rr = config.reactionRoles[idx];

  const window = getTodayWindowMs(rr);
  if (!window) {
    await interaction.reply({
      content: t('rr.noWindow'),
      ephemeral: true
    });
    return;
  }

  const addMinutes = is30 ? 30 : 60;
  setExtension(rr, window, addMinutes);

  const role = guild.roles.cache.get(rr.roleId);
  const roleName = role?.name || rr.roleId;

  const effectiveEndMs = getEffectiveEndMs(rr, window);
  const endStr = formatTimeHHMMinTZ(new Date(effectiveEndMs));

  // disable buttons, no double click
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rrx30_${rr.dbId}`)
      .setLabel(t('rr.extend30'))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`rrx60_${rr.dbId}`)
      .setLabel(t('rr.extend60'))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true)
  );
  await interaction.message.edit({ components: [disabledRow] }).catch(() => null);

  await interaction.reply({
    content: t('rr.extended', { minutes: addMinutes, end: endStr, suffix: t('timeSuffix') }),
    ephemeral: true
  });

  await logReactionRoleEvent(
    guild,
    t('rr.extendedLog', { by: interaction.user, role: roleName, minutes: addMinutes, end: endStr, suffix: t('timeSuffix') })
  );

  // in case we were right at the end
  await updateReactionRoleMessage(guild, idx, { force: true });
}


async function createTicket(interaction, categoryConfig) {
  const guild = interaction.guild;
  const user = interaction.user;
  const member = interaction.member;

  const ticketName = formatTicketName(user, categoryConfig.name);

  const everyoneRole = guild.roles.everyone;

  const permissionOverwrites = [
    {
      id: everyoneRole.id,
      deny: [PermissionFlagsBits.ViewChannel]
    }
  ];

  for (const roleId of config.adminRoleIds) {
    permissionOverwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.MentionEveryone,
        PermissionFlagsBits.UseApplicationCommands
      ]
    });
  }

  if (config.teamRoleId) {
    permissionOverwrites.push({
      id: config.teamRoleId,
      allow: [
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.MentionEveryone,
        PermissionFlagsBits.UseApplicationCommands
      ]
    });
  }

  if (categoryConfig.defaultRoleIds) {
    for (const roleId of categoryConfig.defaultRoleIds) {
      permissionOverwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.MentionEveryone,
          PermissionFlagsBits.UseApplicationCommands
        ]
      });
    }
  }

  permissionOverwrites.push({
    id: member.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles
    ]
  });

  const channel = await guild.channels.create({
    name: ticketName,
    type: ChannelType.GuildText,
    parent: categoryConfig.categoryId,
    permissionOverwrites,
    topic: `${t('ticket.topic', { user: user.tag })} | owner:${user.id} | category:${categoryConfig.name}`
  });

  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel(t('ticket.closeButton'))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ticket_subteam')
      .setLabel(t('ticket.subteamButton'))
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({
    content: t('ticket.welcome', {
      user,
      category: categoryConfig.name,
      roles: categoryConfig.defaultRoleIds.map((id) => `<@&${id}>`).join(' '),
    }),
    components: [controlRow]
  });

  await interaction.reply({
    content: t('ticket.created', { channel }),
    ephemeral: true
  });
}

async function buildTranscript(channel) {
  let messages = [];
  let lastId = null;

  while (true) {
    const fetched = await channel.messages.fetch({
      limit: 100,
      before: lastId || undefined
    });
    if (fetched.size === 0) break;
    messages = messages.concat(Array.from(fetched.values()));
    lastId = fetched.last().id;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = messages.map((m) => {
    const date = new Date(m.createdTimestamp);
    const ts = date.toISOString().replace('T', ' ').slice(0, 19);
    const author = m.author ? m.author.tag : t('transcript.unknownAuthor');
    let content = m.content || '';
    if (m.attachments.size > 0) {
      const urls = m.attachments.map((att) => att.url).join(', ');
      content += ` ${t('transcript.attachments', { urls })}`;
    }
    return `[${ts}] ${author}: ${content}`;
  });

  return lines.join('\n');
}

async function closeTicket(channel, ownerId, closedByUser) {
  const guild = channel.guild;

  const transcript = await buildTranscript(channel);
  const transcriptsDir = path.join(__dirname, 'transcripts');
  if (!fs.existsSync(transcriptsDir)) {
    fs.mkdirSync(transcriptsDir, { recursive: true });
  }
  const fileName = `${channel.name}.txt`;
  const filePath = path.join(transcriptsDir, fileName);
  fs.writeFileSync(filePath, transcript, 'utf8');

  // db errors must not block closing, not even while building the payload
  await persistTranscriptSafe(async () => {
    const categoryLabel = config.categories.find((c) => c.categoryId === channel.parentId)?.name ?? null;
    await saveTranscript(pool, {
      channelName: channel.name,
      category: categoryLabel,
      creatorId: ownerId,
      creatorName: guild.members.cache.get(ownerId)?.user?.tag ?? null,
      openedAt: channel.createdAt ?? null,
      closedAt: new Date(),
      closedById: closedByUser?.id ?? null,
      closedByName: closedByUser?.tag ?? null,
      content: transcript,
    });
  }, { channelName: channel.name }, (...args) => console.error(...args));

  try {
    const member = await guild.members.fetch(ownerId);
    await member.send({
      content: t('ticket.transcriptDm', { name: channel.name }),
      files: [filePath]
    });
  } catch (err) {
    console.warn('could not dm transcript:', err.message);
  }

  try {
    const logChannel = await guild.channels.fetch(config.archiveChannelId).catch(() => null);
    await logChannel.send({
      content: t('ticket.transcriptArchive', { owner: `<@${ownerId}>`, closedBy: closedByUser.tag, name: channel.name }),
      files: [filePath]
    });
  } catch (err) {
    console.warn('could not post transcript to archive:', err.message);
  }
  await channel.delete(t('ticket.deleteReason'));
}

async function handleCloseButton(interaction) {
  const channel = interaction.channel;
  const member = interaction.member;

  const ownerId = getTicketOwnerFromTopic(channel);
  if (!ownerId) {
    await interaction.reply({
      content: t('ticket.ownerUnknown'),
      ephemeral: true
    });
    return;
  }

  const isOwner = member.id === ownerId;
  const memberRoleIds = member.roles.cache.map((r) => r.id);
  const isTeam =
    memberRoleIds.includes(config.teamRoleId) ||
    config.adminRoleIds.some((id) => memberRoleIds.includes(id));

  if (!isOwner && !isTeam) {
    await interaction.reply({
      content: t('ticket.closeNotAllowed'),
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // team closes and the user has been quiet for 3 days -> note for the transcript
  if (isTeam) {
    const messages = await channel.messages.fetch({ limit: 100 });
    const lastUserMessage = messages
      .filter((m) => m.author && m.author.id === ownerId)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
      .first();
    if (!lastUserMessage || Date.now() - lastUserMessage.createdTimestamp > INACTIVE_MS) {
      await channel.send(t('ticket.inactiveNote'));
    }
  }

  await closeTicket(channel, ownerId, interaction.user);
  await interaction.editReply({ content: t('ticket.closed') });
}

async function handleSubteamButton(interaction) {
  const member = interaction.member;
  const memberRoleIds = member.roles.cache.map((r) => r.id);
  const isTeam =
    memberRoleIds.includes(config.teamRoleId) ||
    config.adminRoleIds.some((id) => memberRoleIds.includes(id));

  if (!isTeam) {
    await interaction.reply({
      content: t('subteam.teamOnly'),
      ephemeral: true
    });
    return;
  }

  if (!config.subteams || config.subteams.length === 0) {
    await interaction.reply({
      content: t('subteam.noneConfigured'),
      ephemeral: true
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('subteam_select')
    .setPlaceholder(t('subteam.placeholder'))
    .addOptions(
      subteamOptions(config.subteams)
    );

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.reply({
    content: t('subteam.prompt'),
    components: [row],
    ephemeral: true
  });
}

async function handleSubteamSelect(interaction) {
  const channel = interaction.channel;
  const member = interaction.member;

  const memberRoleIds = member.roles.cache.map((r) => r.id);
  const isTeam =
    memberRoleIds.includes(config.teamRoleId) ||
    config.adminRoleIds.some((id) => memberRoleIds.includes(id));

  if (!isTeam) {
    await interaction.reply({
      content: t('subteam.teamOnly'),
      ephemeral: true
    });
    return;
  }

  const subteam = findSubteam(config.subteams, interaction.values[0]);
  if (!subteam) {
    await interaction.reply({
      content: t('subteam.gone'),
      ephemeral: true
    });
    return;
  }

  for (const roleId of subteam.roleIds) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      AddReactions: true,
      EmbedLinks: true,
      AttachFiles: true,
      MentionEveryone: true,
      UseApplicationCommands: true
    });
  }

  await interaction.reply({
    content: t('subteam.added', { name: subteam.name }),
    ephemeral: true
  });

  await channel.send(
    t('subteam.addedLog', { name: subteam.name, by: member, roles: subteam.roleIds.map((id) => `<@&${id}>`).join(' ') })
  );
}


async function handleTicketAddCommand(interaction) {
  const channel = interaction.channel;

  // ticket categories only
  if (!config.categories.some((c) => c.categoryId === channel.parentId)) {
    await interaction.reply({
      content: t('ticket.onlyInTickets'),
      ephemeral: true
    });
    return;
  }

  const user = interaction.options.getUser('user', true);

  await channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: true,
    AddReactions: true,
    EmbedLinks: true,
    AttachFiles: true
  });

  await interaction.reply({
    content: t('ticket.userAdded', { user })
  });

  await channel.send(t('ticket.userAddedLog', { user, by: interaction.user }));
}


async function handleRoleAddCommand(interaction) {
  if (!config.roleCommandChannelId) {
    await interaction.reply({
      content: t('roles.noCommandChannel'),
      ephemeral: true
    });
    return;
  }

  if (interaction.channelId !== config.roleCommandChannelId) {
    await interaction.reply({
      content: t('roles.wrongChannel', { channel: `<#${config.roleCommandChannelId}>` }),
      ephemeral: true
    });
    return;
  }

  const member = interaction.member;
  const assignable = getAssignableRolesForMember(member);
  if (assignable.length === 0) {
    await interaction.reply({
      content: t('roles.noPermissionAdd'),
      ephemeral: true
    });
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const roleId = interaction.options.getString('role', true);

  if (!assignable.some((r) => r.id === roleId)) {
    await interaction.reply({
      content: t('roles.roleNotAssignable'),
      ephemeral: true
    });
    return;
  }

  const guild = interaction.guild;
  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!targetMember) {
    await interaction.reply({
      content: t('roles.userNotFound'),
      ephemeral: true
    });
    return;
  }

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    await interaction.reply({
      content: t('roles.roleMissing'),
      ephemeral: true
    });
    return;
  }

  if (config.userRoleId && !targetMember.roles.cache.has(config.userRoleId)) {
    await interaction.reply({
      content: t('roles.missingUserRole'),
      ephemeral: true
    });
    return;
  }

  try {
    await targetMember.roles.add(roleId);
  } catch (err) {
    console.error('adding role failed:', err);
    await interaction.reply({
      content: t('roles.addFailed'),
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: t('roles.added', { user: targetMember, role: role.name }),
    ephemeral: true
  });

  const logChannel = await guild.channels.fetch(config.roleCommandChannelId).catch(() => null);
  if (logChannel && logChannel.isTextBased()) {
    await logChannel.send(t('roles.addedLog', { by: interaction.user, user: targetMember, role: role.name }));
  }
}

async function handleRoleRemoveCommand(interaction) {
  if (!config.roleCommandChannelId) {
    await interaction.reply({
      content: t('roles.noCommandChannel'),
      ephemeral: true
    });
    return;
  }

  if (interaction.channelId !== config.roleCommandChannelId) {
    await interaction.reply({
      content: t('roles.wrongChannel', { channel: `<#${config.roleCommandChannelId}>` }),
      ephemeral: true
    });
    return;
  }

  const member = interaction.member;
  const assignable = getAssignableRolesForMember(member);
  if (assignable.length === 0) {
    await interaction.reply({
      content: t('roles.noPermissionRemove'),
      ephemeral: true
    });
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const roleId = interaction.options.getString('role', true);

  if (!assignable.some((r) => r.id === roleId)) {
    await interaction.reply({
      content: t('roles.roleNotRemovable'),
      ephemeral: true
    });
    return;
  }

  const guild = interaction.guild;
  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!targetMember) {
    await interaction.reply({
      content: t('roles.userNotFound'),
      ephemeral: true
    });
    return;
  }

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    await interaction.reply({
      content: t('roles.roleMissing'),
      ephemeral: true
    });
    return;
  }

  try {
    await targetMember.roles.remove(roleId);
  } catch (err) {
    console.error('removing role failed:', err);
    await interaction.reply({
      content: t('roles.removeFailed'),
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: t('roles.removed', { role: role.name, user: targetMember }),
    ephemeral: true
  });

  const logChannel = await guild.channels.fetch(config.roleCommandChannelId).catch(() => null);
  if (logChannel && logChannel.isTextBased()) {
    await logChannel.send(t('roles.removedLog', { by: interaction.user, role: role.name, user: targetMember }));
  }
}

async function handleReactionRoleButton(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  const resolved = resolveReactionRole(interaction.customId, config);
  if (!resolved) {
    await interaction.reply({ content: t('rr.inactive'), ephemeral: true });
    return;
  }
  const idx = resolved.idx;
  const rr = config.reactionRoles[idx];

  const window = getTodayWindowMs(rr);
  if (window) {
    const effectiveEndMs = getEffectiveEndMs(rr, window);
    const now = Date.now();
    const isOpen = now >= window.startMs && now < effectiveEndMs;

    if (!isOpen) {
      // make sure the message shows closed
      await updateReactionRoleMessage(guild, idx).catch(() => null);

      await interaction.reply({
        content: buildClosedRRContent(guild, rr, window),
        ephemeral: true
      });
      return;
    }
  }

  if (rr.requiredRoleId) {
    const hasRequired = member.roles.cache.has(rr.requiredRoleId);
    if (!hasRequired) {
      const requiredRole = guild.roles.cache.get(rr.requiredRoleId);
      await interaction.reply({
        content: requiredRole
          ? t('rr.needsRole', { role: requiredRole })
          : t('rr.requirementsNotMet'),
        ephemeral: true
      });
      return;
    }
  }

  const minAgeDays = Number(rr.minAccountAgeDays);
  const hasMinAge = Number.isFinite(minAgeDays) && minAgeDays > 0;
  const ageDays = hasMinAge ? getAccountAgeDays(interaction.user) : null;

  if (hasMinAge) {
    if (ageDays < minAgeDays) {
      await interaction.reply({
        content:
          t('rr.accountTooYoung') +
          (config.ticketChannelId ? t('rr.accountTooYoungTicket', { channel: `<#${config.ticketChannelId}>` }) : ''),
        ephemeral: true
      });

      if (config.reactionLogChannelId) {
        const roleName = guild.roles.cache.get(rr.roleId)?.name || rr.roleId;
        const createdStr = interaction.user.createdAt.toLocaleDateString(t('dateLocale'));
        const logChannel = await guild.channels
          .fetch(config.reactionLogChannelId)
          .catch(() => null);

        if (logChannel && logChannel.isTextBased()) {
          await logChannel
            .send(t('rr.accountTooYoungLog', { user: interaction.user, role: roleName, age: ageDays, min: minAgeDays, created: createdStr }))
            .catch(() => null);
        }
      }
      return;
    }
  }

  const role = guild.roles.cache.get(rr.roleId);
  if (!role) {
    await interaction.reply({
      content: t('rr.roleMissing'),
      ephemeral: true
    });
    return;
  }

  if (member.roles.cache.has(role.id)) {
    await interaction.reply({
      content: t('rr.alreadyHas', { role }),
      ephemeral: true
    });
    return;
  }

  try {
    await member.roles.add(role.id);
  } catch (err) {
    console.error('assigning reaction role failed:', err);
    await interaction.reply({
      content: t('roles.addFailed'),
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: t('rr.claimed', { role }),
    ephemeral: true
  });

  if (config.reactionLogChannelId) {
    const logChannel = await guild.channels.fetch(config.reactionLogChannelId).catch(() => null);
    if (logChannel && logChannel.isTextBased()) {
      // age only if there is a limit
      const ageSuffix = hasMinAge ? t('rr.claimedLogAge', { days: ageDays }) : '';
      await logChannel.send(t('rr.claimedLog', { user: interaction.user, role: role.name, age: ageSuffix }));
    }
  }
}



client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    if (!config.voiceNotificationChannelId || !config.voiceGroups) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId === newChannelId) return;

    const joinedGroup = newChannelId ? getVoiceGroupForChannel(newChannelId) : null;
    const leftGroup = oldChannelId ? getVoiceGroupForChannel(oldChannelId) : null;

    // only when moving into a group
    if (!joinedGroup || (leftGroup && leftGroup.name === joinedGroup.name)) {
      return;
    }

    const guild = newState.guild;
    const logChannel = await guild.channels.fetch(config.voiceNotificationChannelId).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) return;

    const member = newState.member;
    const rolesMention =
      joinedGroup.pingRoleIds && joinedGroup.pingRoleIds.length > 0
        ? joinedGroup.pingRoleIds.map((id) => `<@&${id}>`).join(' ')
        : '';

    await logChannel.send(t('voice.joined', { roles: rolesMention, user: member, channel: `<#${newChannelId}>` }));
  } catch (err) {
    console.error('voice state update failed:', err);
  }
});

// on reload only if changed, discord rate limits registering
let lastRegisteredCommands = null;
async function registerCommands() {
  const roleChoices = getAllAssignableRoleChoices();

  const ticketAddCommand = new SlashCommandBuilder()
    .setName('ticketadd')
    .setDescription(t('cmd.ticketadd'))
    .addUserOption((option) =>
      option.setName('user').setDescription(t('cmd.ticketadd.user')).setRequired(true)
    )
    .toJSON();

  const roleAddCommand = new SlashCommandBuilder()
    .setName('add')
    .setDescription(t('cmd.add'))
    .addUserOption((option) =>
      option.setName('user').setDescription(t('cmd.add.user')).setRequired(true)
    )
    .addStringOption((option) => {
      option = option
        .setName('role')
        .setDescription(t('cmd.add.role'))
        .setRequired(true);
      roleChoices.forEach((c) => option.addChoices(c));
      return option;
    })
    .toJSON();

  const roleRemoveCommand = new SlashCommandBuilder()
    .setName('remove')
    .setDescription(t('cmd.remove'))
    .addUserOption((option) =>
      option.setName('user').setDescription(t('cmd.remove.user')).setRequired(true)
    )
    .addStringOption((option) => {
      option = option
        .setName('role')
        .setDescription(t('cmd.remove.role'))
        .setRequired(true);
      roleChoices.forEach((c) => option.addChoices(c));
      return option;
    })
    .toJSON();

  const banReasonCommand = banLog.buildBanReasonCommand();

  const commands = [ticketAddCommand, roleAddCommand, roleRemoveCommand, banReasonCommand];
  const signature = JSON.stringify(commands);
  if (signature === lastRegisteredCommands) return;
  await client.application.commands.set(commands);
  lastRegisteredCommands = signature;
}

// each panel on its own, one bad channel id shouldn't block the rest
async function setupPanels(guild) {
  const problems = [];
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      console.error(`${name} failed:`, err);
      problems.push(`${name}: ${err && err.message ? err.message : err}`);
    }
  };
  await step('categories', () => ensureCategories(guild));
  await step('ticket panel', () => setupTicketPanel(guild));
  await step('reaction role messages', () => setupReactionRoleMessages(guild));
  await step('ban log panel', () => banLog.setupBanLogPanel(guild, banLogCtx()));
  return problems;
}

// runtime caches are keyed by index, so drop them on reload
async function applyConfig(newConfig, { unconditional = false, panelsOk = true } = {}) {
  // nothing changed and last run ok -> nothing to do
  if (unconditional && panelsOk && sameConfig(config, newConfig)) return [];
  const guild = await client.guilds.fetch(newConfig.guildId);
  const orphaned = orphanedReactionMessages(config, newConfig);
  config = newConfig;
  for (const v of orphaned) {
    try {
      const ch = await guild.channels.fetch(v.channelId);
      if (ch && ch.messages) await ch.messages.delete(v.messageId);
    } catch (err) {
      console.warn(`could not delete old reaction role message ${v.messageId} in ${v.channelId}:`, err && err.message ? err.message : err);
    }
  }
  reactionRoleRuntime.clear();
  await registerCommands();
  const problems = await setupPanels(guild);
  console.log('config reloaded and applied');
  return problems;
}

const reloader = createReloader({
  // wait for own writes first, otherwise state is missing
  loadConfig: async () => {
    await saveQueue;
    const loaded = await loadConfig(pool);
    (loaded.warnings || []).forEach((w) => console.warn(`config: ${w}`));
    return loaded;
  },
  getMaxChangeId: (since) => readChangeId(pool, since),
  applyConfig,
  writeStatus: (fields) => writeStatus(pool, fields),
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();

  const guild = await client.guilds.fetch(config.guildId);
  const startProblems = await setupPanels(guild);
  startReactionRoleScheduler(guild);

  const current = new Date();
  await writeStatus(pool, {
    bot_tag: client.user.tag,
    started_at: current,
    config_loaded_at: current,
    config_change_id: startChangeId,
    last_error: startProblems.length > 0 ? startProblems.join('; ') : null,
    error_at: startProblems.length > 0 ? current : null
  }).catch((err) => console.error('could not write status:', err));
  reloader.setChangeId(startChangeId);
  reloader.start();

  console.log('bot ready');
});


client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('openTicket_')) {
        const categoryId = interaction.customId.split('openTicket_')[1];
        const categoryConfig = config.categories.find((c) => c.categoryId === categoryId);
        if (!categoryConfig) {
          await interaction.reply({
            content: t('ticket.categoryMissing'),
            ephemeral: true
          });
          return;
        }
        await createTicket(interaction, categoryConfig);
      } else if (interaction.customId === 'ticket_close') {
        await handleCloseButton(interaction);
      } else if (interaction.customId === 'ticket_subteam') {
        await handleSubteamButton(interaction);
      } else if (interaction.customId.startsWith('rrx30_') || interaction.customId.startsWith('rrx60_') || interaction.customId.startsWith('rrExtend30_') || interaction.customId.startsWith('rrExtend60_')) {
        await handleReactionRoleExtendButton(interaction);
      } else if (interaction.customId.startsWith('rr_') || interaction.customId.startsWith('reactionRole_')) {
        await handleReactionRoleButton(interaction);
      } else if (banLog.isBanLogCustomId(interaction.customId)) {
        await banLog.handleBanLogButton(interaction, banLogCtx());
      }

    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'subteam_select') {
        await handleSubteamSelect(interaction);
      }
    } else if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticketadd') {
        await handleTicketAddCommand(interaction);
      } else if (interaction.commandName === 'add') {
        await handleRoleAddCommand(interaction);
      } else if (interaction.commandName === 'remove') {
        await handleRoleRemoveCommand(interaction);
      } else if (interaction.commandName === 'banreason') {
        await banLog.handleBanReasonCommand(interaction, banLogCtx());
      }
    }
  } catch (err) {
    console.error('interaction failed:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: t('error.generic'),
        ephemeral: true
      });
    }
  }
});

// broken config -> errors into status and exit
async function startBot() {
  await ensureSchema(pool);
  await importSeedOnStart(pool, path.join(__dirname, 'seed'));
  const loaded = await loadConfig(pool);
  if (loaded.errors.length > 0) {
    const text = loaded.errors.join('\n');
    console.error(`invalid config, not starting:\n${text}`);
    await writeErrorStatus(pool, text).catch((err) => console.error('could not write status:', err));
    await pool.end().catch(() => null);
    process.exit(1);
  }
  (loaded.warnings || []).forEach((w) => console.warn(`config: ${w}`));
  config = loaded.config;
  startChangeId = loaded.changeId;
  await client.login(process.env.DISCORD_TOKEN);
}

startBot().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});

// SIGTERM on redeploy: wait for writes, close pool
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  reloader.stop();
  const killTimer = setTimeout(() => process.exit(0), 10000);
  killTimer.unref();
  try {
    await saveQueue;
  } catch (err) {
    console.error('pending writes failed:', err);
  }
  await client.destroy();
  await pool.end().catch((err) => console.error('could not close pool:', err));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
