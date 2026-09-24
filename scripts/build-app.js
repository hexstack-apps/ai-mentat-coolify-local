#!/usr/bin/env node
/** `npm run build` — build for the current system into
 *  /.hexstack-app/<app-name>/<app-name>.<ext> */
'use strict';
const path = require('path');
const { build } = require('../sdk/logic/app-scripts');

build({ appName: "ai-mentat-coolify-local", root: path.resolve(__dirname, '..') });
