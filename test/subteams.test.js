'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { subteamOptions, findSubteam } = require('../lib/subteams');

const list = () => [{ name: 'Support', roleIds: ['1'] }, { name: 'Moderation', roleIds: ['2'] }];

test('subteamOptions: value is the name, not the index', () => {
  assert.deepStrictEqual(subteamOptions(list()), [
    { label: 'Support', value: 'Support' },
    { label: 'Moderation', value: 'Moderation' },
  ]);
});

test('findSubteam: finds by name even if the order changed', () => {
  const reordered = list().reverse();
  assert.strictEqual(findSubteam(reordered, 'Support').roleIds[0], '1');
});

test('findSubteam: unknown name (renamed/deleted) gives null', () => {
  assert.strictEqual(findSubteam(list(), 'Altes Team'), null);
  assert.strictEqual(findSubteam(list(), '0'), null);
  assert.strictEqual(findSubteam(undefined, 'Support'), null);
});

test('names over 100 chars are cut the same way for value and lookup', () => {
  const lang = [{ name: 'x'.repeat(120), roleIds: [] }];
  const opt = subteamOptions(lang);
  assert.strictEqual(opt[0].value.length, 100);
  assert.strictEqual(findSubteam(lang, opt[0].value), lang[0]);
});
