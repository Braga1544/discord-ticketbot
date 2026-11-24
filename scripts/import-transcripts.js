'use strict';
// node scripts/import-transcripts.js <dir>, imports old .txt transcripts, safe to rerun
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const fs = require('node:fs');
const path = require('node:path');
const { createPool, ensureSchema } = require('../lib/db');
const { parseLegacyTranscript, importLegacyTranscript } = require('../lib/transcripts');

async function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('usage: node scripts/import-transcripts.js <dir>');
    process.exit(1);
  }
  const pool = createPool(process.env);
  let imported = 0;
  let skipped = 0;
  try {
    await ensureSchema(pool);
    for (const file of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt')).sort()) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      if (await importLegacyTranscript(pool, parseLegacyTranscript(file, text))) imported++;
      else skipped++;
    }
  } finally {
    await pool.end().catch(() => null);
  }
  console.log(`${imported} imported, ${skipped} skipped`);
}

main().catch((err) => {
  console.error('import failed:', err);
  process.exit(1);
});
