#!/usr/bin/env node
/** `npm run check` (second half) — start the built application. */
'use strict';
const { startBuilt } = require('../sdk/logic/app-scripts');

startBuilt({ appName: "ai-mentat-coolify-local" });
