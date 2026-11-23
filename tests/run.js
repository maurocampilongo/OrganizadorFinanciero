#!/usr/bin/env node
'use strict';

/** Corre las tres suites en orden y devuelve código 1 si alguna falla. */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SUITES = ['static.test.js', 'backend.test.js', 'frontend.test.js'];

let failed = 0;
const started = Date.now();

for (const suite of SUITES) {
  console.log('\n' + '='.repeat(52));
  console.log('  ' + suite);
  console.log('='.repeat(52));

  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: 'inherit',
    cwd: ROOT
  });

  if (result.status !== 0) failed++;
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log('\n' + '='.repeat(52));
console.log(failed ? `FALLARON ${failed} suite(s) en ${seconds}s` : `TODO OK en ${seconds}s`);
console.log('='.repeat(52));
process.exit(failed ? 1 : 0);
