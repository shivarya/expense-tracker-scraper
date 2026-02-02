#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('pdf-parse');
console.log('type:', typeof pkg);
console.log('keys:', Object.keys(pkg));
console.log('pkg:', pkg);
