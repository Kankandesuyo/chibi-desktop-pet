'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createVisionClient } = require('./vision-client.cjs');
const { app } = require('electron');
const diagnostic = event => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'remote-chat/vision-diagnostics.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'); } catch {}
};
module.exports = { describeImage: createVisionClient({ diagnostic }) };
