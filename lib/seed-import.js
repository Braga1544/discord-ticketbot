'use strict';
// seed/ on start: config only into an empty db, transcripts idempotent

const fs = require('node:fs');
const path = require('node:path');
const { configToRows, hasConfig, writeRows } = require('./config-import');
const { parseLegacyTranscript, importLegacyTranscript } = require('./transcripts');

async function importSeedOnStart(pool, seedDir, log = console.log) {
  const result = { configImported: false, transcriptsImported: 0, transcriptsSkipped: 0, transcriptsFailed: 0 };
  if (!seedDir || !fs.existsSync(seedDir)) return result;

  const configFile = path.join(seedDir, 'config.json');
  if (fs.existsSync(configFile) && !(await hasConfig(pool))) {
    const json = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    await writeRows(pool, configToRows(json));
    result.configImported = true;
    log('seed: imported config from seed/config.json');
  }

  const transcriptDir = path.join(seedDir, 'transcripts');
  if (fs.existsSync(transcriptDir)) {
    for (const file of fs.readdirSync(transcriptDir).filter((f) => f.toLowerCase().endsWith('.txt')).sort()) {
      try {
        const text = fs.readFileSync(path.join(transcriptDir, file), 'utf8');
        if (await importLegacyTranscript(pool, parseLegacyTranscript(file, text))) result.transcriptsImported++;
        else result.transcriptsSkipped++;
      } catch (err) {
        result.transcriptsFailed++;
        log(`seed: could not import transcript ${file}: ${err.message}`);
      }
    }
    if (result.transcriptsImported > 0 || result.transcriptsFailed > 0) {
      log(`seed: ${result.transcriptsImported} transcripts imported, ${result.transcriptsFailed} failed`);
    }
  }
  return result;
}

module.exports = { importSeedOnStart };
