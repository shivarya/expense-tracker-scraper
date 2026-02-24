import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { authenticateGmail } from '../utils/gmail.js';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const LIST_FILE = path.join(OUTPUT_DIR, 'nps-email-list.json');
const NPS_SENDER = 'nps-statements@mailer.proteantech.in';

type MailListItem = {
  id: string;
  date: string;
  subject: string;
  hasPdf: boolean;
};

async function fetchLatestNpsEmailId(gmail: any): Promise<MailListItem | null> {
  const query = `from:${NPS_SENDER} has:attachment`;
  const listResponse = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 10 });
  const messages = listResponse.data.messages || [];
  if (messages.length === 0) return null;

  const results: MailListItem[] = [];
  for (const message of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: message.id!,
      format: 'metadata',
      metadataHeaders: ['Subject', 'Date']
    });
    const headers = msg.data.payload?.headers || [];
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(No Subject)';
    const date = headers.find((h: any) => h.name === 'Date')?.value || '';

    const full = await gmail.users.messages.get({ userId: 'me', id: message.id!, format: 'full' });
    const stack = [full.data.payload];
    let hasPdf = false;
    while (stack.length > 0) {
      const part = stack.pop();
      if (!part) continue;
      if (part.filename?.toLowerCase().endsWith('.pdf')) {
        hasPdf = true;
        break;
      }
      if (part.parts?.length) stack.push(...part.parts);
    }

    results.push({ id: message.id!, date, subject, hasPdf });
  }

  return results
    .filter((r) => r.hasPdf)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0] || null;
}

async function downloadLatestNps() {
  console.log('⬇️ Downloading latest NPS statement PDF\n');
  console.log('━'.repeat(60));

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const auth = await authenticateGmail();
  const gmail = google.gmail({ version: 'v1', auth });

  let latest: MailListItem | null = null;
  try {
    const data = await fs.readFile(LIST_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    const items = (parsed.items || []) as MailListItem[];
    latest = items
      .filter((i) => i.hasPdf)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0] || null;
  } catch {
  }

  if (!latest) {
    latest = await fetchLatestNpsEmailId(gmail);
  }

  if (!latest) {
    throw new Error('No NPS statement email with PDF attachment found');
  }

  console.log(`Latest email: ${latest.subject}`);
  console.log(`Date: ${latest.date}`);

  const full = await gmail.users.messages.get({ userId: 'me', id: latest.id, format: 'full' });

  const collectPdfParts = (part: any): Array<{ filename: string; attachmentId?: string }> => {
    const found: Array<{ filename: string; attachmentId?: string }> = [];
    if (part?.filename?.toLowerCase().endsWith('.pdf')) {
      found.push({ filename: part.filename, attachmentId: part.body?.attachmentId });
    }
    if (part?.parts?.length) {
      for (const p of part.parts) found.push(...collectPdfParts(p));
    }
    return found;
  };

  const pdfParts = collectPdfParts(full.data.payload);
  if (pdfParts.length === 0) {
    throw new Error('No PDF attachment found in latest NPS email');
  }

  for (const pdfPart of pdfParts) {
    if (!pdfPart.attachmentId) continue;
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: latest.id,
      id: pdfPart.attachmentId
    });

    const buffer = Buffer.from(attachment.data.data || '', 'base64');
    const ts = new Date(latest.date).getTime() || Date.now();
    const cleanName = pdfPart.filename.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_{2,}/g, '_');
    const outFile = `nps_${ts}_${cleanName}`;
    const outPath = path.join(OUTPUT_DIR, outFile);
    await fs.writeFile(outPath, buffer);
    console.log(`✅ Saved: ${outPath}`);
  }
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  downloadLatestNps().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
