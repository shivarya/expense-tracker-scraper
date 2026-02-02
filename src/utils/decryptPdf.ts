#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { decrypt } from 'node-qpdf2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadPasswords(passwordFile: string) {
  try {
    const content = await fs.readFile(passwordFile, 'utf-8');
    return JSON.parse(content) as string[];
  } catch (e) {
    return [];
  }
}

async function tryDecrypt(pdfPath: string, outputPath: string, passwords: string[]) {
  for (const pwd of passwords) {
    try {
      console.log(`Trying password: ${pwd}`);
      await decrypt({ input: pdfPath, output: outputPath, password: pwd });
      console.log(`Decrypted with password: ${pwd}`);
      return { success: true, password: pwd };
    } catch (err: any) {
      // continue
    }
  }
  return { success: false };
}

async function main() {
  const pdfPath = process.argv[2];
  const optPassword = process.argv[3];

  if (!pdfPath) {
    console.error('Usage: tsx src/utils/decryptPdf.ts <pdfPath> [password]');
    process.exit(2);
  }

  const absPdf = path.resolve(pdfPath);
  const out = absPdf.replace(/\.pdf$/i, '_decrypted.pdf');

  const pwdFile = path.resolve(__dirname, '..', 'config', 'pdf-passwords.json');
  const passwords = await loadPasswords(pwdFile);

  const tryList = optPassword ? [optPassword, ...passwords] : passwords;

  const result = await tryDecrypt(absPdf, out, tryList);
  if (result.success) {
    console.log(JSON.stringify({ success: true, output: out, password: result.password }));
    process.exit(0);
  } else {
    console.error(JSON.stringify({ success: false }));
    process.exit(3);
  }
}

main().catch(err => {
  console.error('Error:', err?.message || err);
  process.exit(4);
});
