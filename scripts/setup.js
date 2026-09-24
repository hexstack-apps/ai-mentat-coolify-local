#!/usr/bin/env node
/** `npm run setup` — install every npm and non-npm dependency needed to run. */
'use strict';
const path = require('path');
const { setup } = require('../sdk/logic/app-scripts');

setup({
  appName: "ai-mentat-coolify-local",
  root: path.resolve(__dirname, '..'),
  system: ["limactl"],
  extra: () => {
  // lima VM image is fetched on first run by scripts/download-lima.js
  try { require('child_process').execSync('node scripts/download-lima.js', { stdio: 'inherit' }); }
  catch { console.warn('    (lima download skipped)'); }
  },
});
