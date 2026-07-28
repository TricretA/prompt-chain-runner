#!/usr/bin/env node
'use strict';
// Test verification step: passes iff <file> (default app.txt) contains "GOOD".
const fs = require('fs');
const file = process.argv[2] || 'app.txt';
try {
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('GOOD')) {
    console.log(`${file} check ok`);
    process.exit(0);
  }
  console.error(`ERROR: ${file} does not contain GOOD (found: ${JSON.stringify(content.trim().slice(0, 100))})`);
  process.exit(1);
} catch (err) {
  console.error(`ERROR: could not read ${file}: ${err.message}`);
  process.exit(1);
}
