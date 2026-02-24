import { authenticateGmail } from '../utils/gmail.js';
import fs from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const listPath = path.join(OUTPUT_DIR, 'cdsl-email-list.json');

async function downloadLatest() {
  const data = await fs.readFile(listPath, 'utf-8');
  const parsed = JSON.parse(data);
  const items = parsed.items || [];
  if (items.length === 0) {
    console.error('No CDSL emails found in cdsl-email-list.json');
    process.exit(1);
  }

  const latest = items[0];
  console.log('Latest:', latest.subject, latest.date, 'id=', latest.id);

  const auth = await authenticateGmail();
  const gmail = google.gmail({ version: 'v1', auth });

  const full = await gmail.users.messages.get({ userId: 'me', id: latest.id, format: 'full' });

  function traverse(part: any) {
    const results: Array<{ filename: string; attachmentId?: string }> = [];
    if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
      results.push({ filename: part.filename, attachmentId: part.body?.attachmentId });
    }
    if (part.parts) {
      for (const p of part.parts) results.push(...traverse(p));
    }
    return results;
  }

  const atts = traverse(full.data.payload);
  if (atts.length === 0) {
    console.error('No PDF attachments found for latest message');
    process.exit(1);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  for (const att of atts) {
    if (!att.attachmentId) {
      console.warn('Attachment without attachmentId, skipping:', att.filename);
      continue;
    }

    console.log(`Downloading ${att.filename}...`);
    const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: latest.id, id: att.attachmentId });
    const dataBuf = Buffer.from(res.data.data || '', 'base64');
    const timestamp = new Date(latest.date).getTime();
    const sanitized = att.filename.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_{2,}/g, '_');
    const outName = `cdsl_${timestamp}_${sanitized}`;
    const outPath = path.join(OUTPUT_DIR, outName);
    await fs.writeFile(outPath, dataBuf);
    console.log('Saved to', outPath);
  }
  console.log('\n✅ Download(s) complete');
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  downloadLatest().catch(err => { console.error('Error:', err.message || err); process.exit(1); });
}
