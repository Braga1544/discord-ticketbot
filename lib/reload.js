'use strict';
// hot reload via config_change_log, no restart needed

const FULL_RELOAD_MS = 10 * 60 * 1000;

// resolve rr_<dbId> / rrx30_ / rrx60_. old index format and deleted rows -> null, otherwise wrong role
function resolveReactionRole(customId, config) {
  const match = /^(?:rr|rrx30|rrx60)_(\d+)$/.exec(String(customId || ''));
  if (!match) return null;
  const dbId = Number(match[1]);
  const list = (config && config.reactionRoles) || [];
  const idx = list.findIndex((rr) => rr.dbId !== undefined && Number(rr.dbId) === dbId);
  return idx >= 0 ? { idx } : null;
}

// orphaned = row deleted or channel changed (the new channel gets a new one)
function orphanedReactionMessages(oldConfig, newConfig) {
  const fresh = new Map();
  for (const rr of (newConfig && newConfig.reactionRoles) || []) {
    if (rr.dbId !== undefined) fresh.set(Number(rr.dbId), rr);
  }
  const orphaned = [];
  for (const rr of (oldConfig && oldConfig.reactionRoles) || []) {
    if (!rr.messageId || !rr.channelId) continue;
    const current = rr.dbId !== undefined ? fresh.get(Number(rr.dbId)) : undefined;
    if (!current || String(current.channelId) !== String(rr.channelId)) {
      orphaned.push({ channelId: String(rr.channelId), messageId: String(rr.messageId) });
    }
  }
  return orphaned;
}

// compare without bot-owned state
const BOT_STATE_KEYS = new Set(['messageId', 'panelMessageId', 'extensionUntilMs', 'extensionForDay', 'lastWarnedEffectiveEndIso', 'lastClosedEffectiveEndIso']);
function sameConfig(a, b) {
  if (!a || !b) return false;
  const text = (c) => JSON.stringify(c, (setting_key, value) => (BOT_STATE_KEYS.has(setting_key) ? undefined : value));
  return text(a) === text(b);
}

function createReloader({
  loadConfig,
  getMaxChangeId,
  applyConfig,
  writeStatus,
  intervalMs = 15000,
  fullReloadMs = FULL_RELOAD_MS,
  now = Date.now,
}) {
  let lastChangeId = 0;
  let lastFullReload = now();
  // never skip as unchanged after errors
  let retry = false;
  let running = false;
  let timer = null;

  async function writeStatusSafe(fields) {
    try {
      await writeStatus(fields);
    } catch (err) {
      console.error('could not write status:', err);
    }
  }

  async function reportError(text) {
    console.error(`config reload failed: ${text}`);
    await writeStatusSafe({ last_error: text, error_at: new Date() });
  }

  // remember the start id, otherwise the first tick reloads for nothing
  function setChangeId(id) {
    lastChangeId = Number(id) || 0;
    lastFullReload = now();
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const max = await getMaxChangeId(lastChangeId);
      const fresh = max > lastChangeId;
      if (!fresh && now() - lastFullReload < fullReloadMs) return;
      const unconditional = !fresh;
      const panelsOk = !retry;

      const loaded = await loadConfig();
      const id = loaded.changeId !== undefined ? loaded.changeId : max;
      lastFullReload = now();
      // remember even for broken config, otherwise the same thing every 15s
      lastChangeId = id;

      if (loaded.errors && loaded.errors.length > 0) {
        await reportError(loaded.errors.join('\n'));
        return;
      }
      retry = true;
      const problems = (await applyConfig(loaded.config, { unconditional, panelsOk })) || [];
      retry = problems.length > 0;
      // config is applied, panel errors go to status
      const current = new Date();
      await writeStatusSafe({
        config_loaded_at: current,
        config_change_id: id,
        last_error: problems.length > 0 ? problems.join('; ') : null,
        error_at: problems.length > 0 ? current : null,
      });
    } catch (err) {
      // applyConfig threw -> try again next time
      await reportError(err && err.message ? err.message : String(err));
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick(); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, setChangeId };
}

module.exports = { createReloader, resolveReactionRole, sameConfig, orphanedReactionMessages };
