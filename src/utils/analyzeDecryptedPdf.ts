#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { parsePDFWithAI } from '../scrapers/mutualFunds.js';

async function main() {
  const pdfPath = process.argv[2];
  const subject = process.argv[3] || '';
  if (!pdfPath) {
    console.error('Usage: tsx src/utils/analyzeDecryptedPdf.ts <pdfPath> [subject]');
    process.exit(2);
  }

  const abs = path.resolve(pdfPath);
  const data = await fs.readFile(abs);
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data });
  const parsed = await parser.getText();
  const text = parsed.text || '';

  console.log('Sending text to AI parser... (this may take a few seconds)');
  const res = await parsePDFWithAI(text, subject);
  console.log(JSON.stringify(res, null, 2));
}

main().catch(err => {
  console.error('Error:', err?.message || err);
  process.exit(3);
});
