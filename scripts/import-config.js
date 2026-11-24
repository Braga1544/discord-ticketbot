'use strict';
// node scripts/import-config.js <config.json>, empty tables only
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const fs = require('node:fs');
const { createPool, ensureSchema } = require('../lib/db');
const { configToRows, hasConfig, writeRows } = require('../lib/config-import');

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('usage: node scripts/import-config.js <path/config.json>');
    process.exit(1);
  }
  const rows = configToRows(JSON.parse(fs.readFileSync(file, 'utf8')));
  const pool = createPool(process.env);
  try {
    await ensureSchema(pool);
    if (await hasConfig(pool)) {
      console.error('aborting: ticketbot tables already contain config, clear them first');
      process.exit(2);
    }
    await writeRows(pool, rows);
  } finally {
    await pool.end().catch(() => null);
  }
  console.log('config imported');
}

main().catch((err) => {
  console.error('import failed:', err);
  process.exit(1);
});
