#!/usr/bin/env node
'use strict';
// Test verification step: succeeds, but drops a stop flag one level above the
// project dir (where the runner looks for it) — used to prove a graceful stop
// is honored between verification steps.
require('fs').writeFileSync('../.stop', 'requested by write-stop.js test step');
console.log('stop flag written');
