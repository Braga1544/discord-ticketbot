const {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require('discord.js');
const { t } = require('./lib/i18n');

// discord: 5 buttons per row, 5 rows per message
const MAX_BUTTONS = 25;
const MAX_LABEL_LENGTH = 80;
const MAX_REASON_LENGTH = 200;

// how long an interaction token lives
const PENDING_TTL_MS = 15 * 60 * 1000;

// token -> { reason, userId, createdAt }, memory only so nothing half-confirmed goes out after a restart
const pendingBans = new Map();

function getBanLogConfig(config) {
  const banLog = config.banLog;
  if (!banLog || !banLog.inputChannelId || !banLog.outputChannelId) return null;
  return banLog;
}

function getReasons(banLog) {
  return Array.isArray(banLog.reasons) ? banLog.reasons.slice(0, MAX_BUTTONS) : [];
}

function prunePendingBans() {
  const now = Date.now();
  for (const [token, entry] of pendingBans) {
    if (now - entry.createdAt > PENDING_TTL_MS) {
      pendingBans.delete(token);
    }
  }
}

function normalizeReason(raw) {
  return String(raw).replace(/\s+/g, ' ').trim();
}

function buildPanelRows(reasons) {
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (let i = 0; i < reasons.length; i++) {
    if (currentRow.components.length === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`banReason_${i}`)
        .setLabel(String(reasons[i]).slice(0, MAX_LABEL_LENGTH))
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (currentRow.components.length > 0) rows.push(currentRow);
  return rows;
}

function buildConfirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`banConfirm_${token}`)
      .setLabel(t('banlog.send'))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`banCancel_${token}`)
      .setLabel(t('banlog.cancel'))
      .setStyle(ButtonStyle.Secondary)
  );
}

// find the panel via panelMessageId, else via its button in the last 50 messages
async function setupBanLogPanel(guild, ctx) {
  const { config, saveConfig } = ctx;

  const banLog = getBanLogConfig(config);
  if (!banLog) {
    console.warn('ban log: inputChannelId/outputChannelId missing, skipping panel');
    return;
  }

  const allReasons = Array.isArray(banLog.reasons) ? banLog.reasons : [];
  if (allReasons.length === 0) {
    console.warn('ban log: no reasons configured, skipping panel');
    return;
  }
  if (allReasons.length > MAX_BUTTONS) {
    console.warn(`ban log: ${allReasons.length} reasons but discord allows ${MAX_BUTTONS} buttons, showing the first ${MAX_BUTTONS}`);
  }
  const reasons = getReasons(banLog);

  const channel = await guild.channels.fetch(banLog.inputChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.warn(`ban log: input channel ${banLog.inputChannelId} not found or not a text channel`);
    return;
  }

  const rows = buildPanelRows(reasons);

  let message = null;
  if (banLog.panelMessageId) {
    message = await channel.messages.fetch(banLog.panelMessageId).catch(() => null);
  }

  if (!message) {
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (messages) {
      message =
        messages.find(
          (m) =>
            m.author.id === guild.client.user.id &&
            m.components &&
            m.components.some((row) =>
              row.components.some((c) => c.customId && c.customId.startsWith('banReason_'))
            )
        ) || null;
    }
  }

  const content = t('banlog.panel');
  if (message) {
    await message.edit({ content, components: rows });
    if (banLog.panelMessageId !== message.id) {
      banLog.panelMessageId = message.id;
      saveConfig();
    }
    console.log('ban log panel updated');
  } else {
    const sent = await channel.send({ content, components: rows });
    banLog.panelMessageId = sent.id;
    saveConfig();
    console.log('ban log panel sent');
  }
}

function buildBanReasonCommand() {
  return new SlashCommandBuilder()
    .setName('banreason')
    .setDescription(t('cmd.banreason'))
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription(t('cmd.banreason.reason'))
        .setRequired(true)
        .setMaxLength(MAX_REASON_LENGTH)
    )
    .toJSON();
}

function isBanLogCustomId(customId) {
  return (
    typeof customId === 'string' &&
    (customId.startsWith('banReason_') ||
      customId.startsWith('banConfirm_') ||
      customId.startsWith('banCancel_'))
  );
}

// reason lives in the map, not the customId, free text would blow the 100 char limit
async function askForConfirmation(interaction, reason) {
  const token = interaction.id;

  prunePendingBans();
  pendingBans.set(token, { reason, userId: interaction.user.id, createdAt: Date.now() });

  await interaction.reply({
    content: t('banlog.confirm', { reason }),
    components: [buildConfirmRow(token)],
    allowedMentions: { parse: [] },
    ephemeral: true
  });
}

async function sendBanNotice(guild, banLog, reason) {
  const channel = await guild.channels.fetch(banLog.outputChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error(`ban log: output channel ${banLog.outputChannelId} not found or not a text channel`);
    return false;
  }

  try {
    await channel.send({
      content: t('banlog.notice', { reason }),
      allowedMentions: { parse: [] }
    });
    return true;
  } catch (err) {
    console.error('ban log: could not send notice:', err);
    return false;
  }
}

async function handleBanLogButton(interaction, ctx) {
  const banLog = getBanLogConfig(ctx.config);
  if (!banLog) {
    await interaction.reply({ content: t('banlog.notConfigured'), ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  if (customId.startsWith('banReason_')) {
    const idx = parseInt(customId.slice('banReason_'.length), 10);
    const reason = getReasons(banLog)[idx];

    if (!reason) {
      await interaction.reply({ content: t('banlog.reasonGone'), ephemeral: true });
      return;
    }

    await askForConfirmation(interaction, reason);
    return;
  }

  const isConfirm = customId.startsWith('banConfirm_');
  const token = customId.slice((isConfirm ? 'banConfirm_' : 'banCancel_').length);
  const pending = pendingBans.get(token);

  if (!pending) {
    await interaction.update({ content: t('banlog.expired'), components: [] });
    return;
  }

  if (pending.userId !== interaction.user.id) {
    await interaction.reply({ content: t('banlog.notYours'), ephemeral: true });
    return;
  }

  pendingBans.delete(token);

  if (!isConfirm) {
    await interaction.update({ content: t('banlog.cancelled'), components: [] });
    return;
  }

  const sent = await sendBanNotice(interaction.guild, banLog, pending.reason);
  if (!sent) {
    await interaction.update({ content: t('banlog.sendFailed'), components: [] });
    return;
  }

  await interaction.update({
    content: t('banlog.sent', { reason: pending.reason }),
    components: [],
    allowedMentions: { parse: [] }
  });
}

async function handleBanReasonCommand(interaction, ctx) {
  const banLog = getBanLogConfig(ctx.config);
  if (!banLog) {
    await interaction.reply({ content: t('banlog.notConfigured'), ephemeral: true });
    return;
  }

  if (interaction.channelId !== banLog.inputChannelId) {
    await interaction.reply({
      content: t('banlog.wrongChannel', { channel: `<#${banLog.inputChannelId}>` }),
      ephemeral: true
    });
    return;
  }

  const reason = normalizeReason(interaction.options.getString('reason', true));
  if (!reason) {
    await interaction.reply({ content: t('banlog.reasonRequired'), ephemeral: true });
    return;
  }

  await askForConfirmation(interaction, reason);
}

module.exports = {
  setupBanLogPanel,
  buildBanReasonCommand,
  isBanLogCustomId,
  handleBanLogButton,
  handleBanReasonCommand
};
