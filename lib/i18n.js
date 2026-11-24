'use strict';
const path = require('node:path');

const fallback = require('../locales/en.json');

function load(locale) {
  if (!locale || locale === 'en') return fallback;
  try {
    return require(path.join(__dirname, '..', 'locales', `${locale}.json`));
  } catch (err) {
    console.warn(`locale "${locale}" not found, using en`);
    return fallback;
  }
}

const strings = load(process.env.BOT_LOCALE);

// t('rr.claimed', { role }) -> string, missing keys fall back to en
function t(key, vars = {}) {
  const template = strings[key] ?? fallback[key];
  if (template === undefined) throw new Error(`missing locale key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])));
}

module.exports = { t };
