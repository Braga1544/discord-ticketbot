'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createReloader, resolveReactionRole, sameConfig, orphanedReactionMessages } = require('../lib/reload');

function build({ max = 5, loaded, loadErrors, maxErrors, applyErrors, clock } = {}) {
  const calls = { load: 0, apply: [], status: [] };
  const state = { max };
  const reloader = createReloader({
    getMaxChangeId: async () => {
      if (maxErrors) throw maxErrors;
      return state.max;
    },
    loadConfig: async () => {
      calls.load++;
      if (loadErrors) throw loadErrors;
      return loaded || { config: { x: 1 }, errors: [], changeId: state.max };
    },
    applyConfig: async (config) => {
      if (applyErrors) throw applyErrors;
      calls.apply.push(config);
    },
    writeStatus: async (fields) => { calls.status.push(fields); },
    now: clock ? () => clock.t : undefined,
  });
  return { reloader, calls, state };
}

test('new change id + valid config: applyConfig once, status without error', async () => {
  const { reloader, calls } = build({ max: 6 });
  reloader.setChangeId(5);
  await reloader.tick();
  assert.strictEqual(calls.apply.length, 1);
  assert.strictEqual(calls.status.length, 1);
  assert.strictEqual(calls.status[0].config_change_id, 6);
  assert.strictEqual(calls.status[0].last_error, null);
  assert.strictEqual(calls.status[0].error_at, null);
  assert.ok(calls.status[0].config_loaded_at instanceof Date);
});

test('new change id + errors: applyConfig not called, status has the error', async () => {
  const { reloader, calls } = build({
    max: 6,
    loaded: { config: {}, errors: ['guild_id: Pflichtfeld fehlt', 'team_role_id: Pflichtfeld fehlt'], changeId: 6 },
  });
  reloader.setChangeId(5);
  const stumm = console.error;
  console.error = () => {};
  try {
    await reloader.tick();
    assert.strictEqual(calls.apply.length, 0);
    assert.strictEqual(calls.status.length, 1);
    assert.match(calls.status[0].last_error, /guild_id: Pflichtfeld fehlt\nteam_role_id/);
    assert.ok(calls.status[0].error_at instanceof Date);
    assert.strictEqual(calls.status[0].config_loaded_at, undefined);
    // don't check the same broken change again
    await reloader.tick();
    assert.strictEqual(calls.load, 1);
  } finally {
    console.error = stumm;
  }
});

test('same change id: nothing happens', async () => {
  const { reloader, calls } = build({ max: 5 });
  reloader.setChangeId(5);
  await reloader.tick();
  assert.strictEqual(calls.load, 0);
  assert.strictEqual(calls.apply.length, 0);
  assert.strictEqual(calls.status.length, 0);
});

test('db read, load or apply errors: no crash, error in status', async () => {
  const stumm = console.error;
  console.error = () => {};
  try {
    const a = build({ maxErrors: new Error('db gone') });
    await a.reloader.tick();
    assert.strictEqual(a.calls.apply.length, 0);
    assert.match(a.calls.status[0].last_error, /db gone/);

    const b = build({ max: 9, loadErrors: new Error('query broken') });
    await b.reloader.tick();
    assert.match(b.calls.status[0].last_error, /query broken/);

    const c = build({ max: 9, applyErrors: new Error('Discord down') });
    await c.reloader.tick();
    assert.match(c.calls.status[0].last_error, /Discord down/);
    assert.strictEqual(c.calls.status[0].config_loaded_at, undefined);
  } finally {
    console.error = stumm;
  }
});

test('full reload after 10 minutes even without new change id', async () => {
  const clock = { t: 1000 };
  const { reloader, calls } = build({ max: 5, clock });
  reloader.setChangeId(5);
  clock.t += 9 * 60 * 1000;
  await reloader.tick();
  assert.strictEqual(calls.apply.length, 0);
  clock.t += 61 * 1000;
  await reloader.tick();
  assert.strictEqual(calls.apply.length, 1);
});

test('resolveReactionRole resolves by dbId, not index', () => {
  const config = { reactionRoles: [{ dbId: 3 }, { dbId: 5 }, { dbId: 7 }] };
  assert.deepStrictEqual(resolveReactionRole('rr_7', config), { idx: 2 });
  assert.deepStrictEqual(resolveReactionRole('rrx30_5', config), { idx: 1 });
  assert.deepStrictEqual(resolveReactionRole('rrx60_3', config), { idx: 0 });
});

test('resolveReactionRole: unknown dbId gives null (deleted row never hands out another role)', () => {
  const config = { reactionRoles: [{ dbId: 3 }, { dbId: 5 }, { dbId: 7 }] };
  assert.strictEqual(resolveReactionRole('rr_9', config), null);
  assert.strictEqual(resolveReactionRole('rr_', config), null);
  assert.strictEqual(resolveReactionRole('other_3', config), null);
  assert.strictEqual(resolveReactionRole('rr_3', { reactionRoles: [] }), null);
  assert.strictEqual(resolveReactionRole('rr_3', {}), null);
});

test('resolveReactionRole: legacy index format is never resolved, even if the number matches a dbId', () => {
  const config = { reactionRoles: [{ dbId: 1 }, { dbId: 2 }] };
  assert.strictEqual(resolveReactionRole('reactionRole_1', config), null);
  assert.strictEqual(resolveReactionRole('rrExtend30_1', config), null);
  assert.strictEqual(resolveReactionRole('rrExtend60_2', config), null);
});

test('sameConfig ignores bot state fields but catches real changes', () => {
  const basis = () => ({ guildId: '1', banLog: { reasons: ['a'], panelMessageId: undefined }, reactionRoles: [{ dbId: 1, roleId: '2' }] });
  const a = basis();
  const b = basis();
  b.banLog.panelMessageId = '99';
  b.reactionRoles[0].messageId = '5';
  b.reactionRoles[0].extensionUntilMs = 123;
  assert.strictEqual(sameConfig(a, b), true);
  b.reactionRoles[0].roleId = '3';
  assert.strictEqual(sameConfig(a, b), false);
  assert.strictEqual(sameConfig(null, b), false);
});

test('panel errors from applyConfig: config counts as applied, errors go to status', async () => {
  const calls = { status: [] };
  const reloader = createReloader({
    getMaxChangeId: async () => 8,
    loadConfig: async () => ({ config: {}, errors: [], changeId: 8 }),
    applyConfig: async () => ['ticket panel: Unknown Channel', 'ban log panel: broken'],
    writeStatus: async (f) => { calls.status.push(f); },
  });
  reloader.setChangeId(1);
  await reloader.tick();
  assert.strictEqual(calls.status.length, 1);
  assert.strictEqual(calls.status[0].config_change_id, 8);
  assert.ok(calls.status[0].config_loaded_at instanceof Date);
  assert.strictEqual(calls.status[0].last_error, 'ticket panel: Unknown Channel; ban log panel: broken');
  assert.ok(calls.status[0].error_at instanceof Date);
});

test('full reload passes unconditional=true, a change passes unconditional=false', async () => {
  const optionen = [];
  const clock = { t: 0 };
  const state = { max: 5 };
  const reloader = createReloader({
    getMaxChangeId: async () => state.max,
    loadConfig: async () => ({ config: {}, errors: [], changeId: state.max }),
    applyConfig: async (c, o) => { optionen.push(o); },
    writeStatus: async () => {},
    now: () => clock.t,
  });
  reloader.setChangeId(5);
  clock.t += 11 * 60 * 1000;
  await reloader.tick();
  state.max = 6;
  await reloader.tick();
  assert.deepStrictEqual(optionen, [{ unconditional: true, panelsOk: true }, { unconditional: false, panelsOk: true }]);
});

test('two concurrent tick() with slow loadConfig call applyConfig at most once', async () => {
  let applied = 0;
  const reloader = createReloader({
    getMaxChangeId: async () => 9,
    loadConfig: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { config: {}, errors: [], changeId: 9 };
    },
    applyConfig: async () => { applied++; },
    writeStatus: async () => {},
  });
  reloader.setChangeId(1);
  await Promise.all([reloader.tick(), reloader.tick()]);
  assert.strictEqual(applied, 1);
});

test('getMaxChangeId gets the last seen change id', async () => {
  const gesehen = [];
  const reloader = createReloader({
    getMaxChangeId: async (since) => { gesehen.push(since); return 5; },
    loadConfig: async () => ({ config: {}, errors: [], changeId: 5 }),
    applyConfig: async () => {},
    writeStatus: async () => {},
  });
  reloader.setChangeId(5);
  await reloader.tick();
  assert.deepStrictEqual(gesehen, [5]);
});

test('panel errors: full reload applies again (panelsOk false), then skips again', async () => {
  const optionen = [];
  const status = [];
  const clock = { t: 0 };
  let result = ['ticket panel: broken'];
  const reloader = createReloader({
    getMaxChangeId: async () => 8,
    loadConfig: async () => ({ config: {}, errors: [], changeId: 8 }),
    applyConfig: async (c, o) => { optionen.push(o); return result; },
    writeStatus: async (f) => { status.push(f); },
    now: () => clock.t,
  });
  reloader.setChangeId(1);
  await reloader.tick(); // change, panels fail
  clock.t += 11 * 60 * 1000;
  await reloader.tick(); // unconditional, retry
  result = [];
  clock.t += 11 * 60 * 1000;
  await reloader.tick(); // unconditional, retry works
  clock.t += 11 * 60 * 1000;
  await reloader.tick(); // unconditional, skippable again
  assert.deepStrictEqual(optionen.map((o) => [o.unconditional, o.panelsOk]),
    [[false, true], [true, false], [true, false], [true, true]]);
  assert.strictEqual(status[1].last_error, 'ticket panel: broken');
  assert.strictEqual(status[2].last_error, null);
});

test('applyConfig throws: retried on the next full reload', async () => {
  const stumm = console.error;
  console.error = () => {};
  const optionen = [];
  const clock = { t: 0 };
  let werfen = true;
  const reloader = createReloader({
    getMaxChangeId: async () => 8,
    loadConfig: async () => ({ config: {}, errors: [], changeId: 8 }),
    applyConfig: async (c, o) => { optionen.push(o); if (werfen) throw new Error('Discord down'); return []; },
    writeStatus: async () => {},
    now: () => clock.t,
  });
  try {
    reloader.setChangeId(1);
    await reloader.tick();
    werfen = false;
    clock.t += 11 * 60 * 1000;
    await reloader.tick();
    assert.deepStrictEqual(optionen.map((o) => o.panelsOk), [true, false]);
  } finally {
    console.error = stumm;
  }
});

test('orphanedReactionMessages: deleted row and channel change, nothing else', () => {
  const old = { reactionRoles: [
    { dbId: 1, channelId: 'A', messageId: 'm1' },
    { dbId: 2, channelId: 'A', messageId: 'm2' },
    { dbId: 3, channelId: 'B', messageId: 'm3' },
    { dbId: 4, channelId: 'B', messageId: null },
    { dbId: 5, channelId: 'C', messageId: 'm5' },
  ] };
  const fresh = { reactionRoles: [
    { dbId: 1, channelId: 'A', messageId: 'm1' },   // unchanged
    { dbId: 3, channelId: 'X', messageId: 'm3' },   // channel changed
    { dbId: 4, channelId: 'Y' },                    // no old message
    { dbId: 6, channelId: 'C' },                    // new row
  ] };
  assert.deepStrictEqual(orphanedReactionMessages(old, fresh), [
    { channelId: 'A', messageId: 'm2' },
    { channelId: 'B', messageId: 'm3' },
    { channelId: 'C', messageId: 'm5' },
  ]);
  assert.deepStrictEqual(orphanedReactionMessages(null, fresh), []);
  assert.deepStrictEqual(orphanedReactionMessages(old, {}).length, 4);
});
