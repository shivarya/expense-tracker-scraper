import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { authenticateGmail } from '../utils/gmail.js';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'nps-email-list.json');
const NPS_SENDER = 'nps-statements@mailer.proteantech.in';

async function checkNpsMail() {
  console.log('🔎 Checking Gmail for NPS statement emails\n');
  console.log('━'.repeat(60));

  const auth = await authenticateGmail();
  const gmail = google.gmail({ version: 'v1', auth });

  const query = `from:${NPS_SENDER} has:attachment`;
  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 30
  });

  const messages = listResponse.data.messages || [];
  const items: Array<{
    id: string;
    threadId: string;
    date: string;
    subject: string;
    from: string;
    hasPdf: boolean;
    attachments: string[];
    snippet: string;
  }> = [];

  for (const message of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: message.id!,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date']
    });

    const headers = msg.data.payload?.headers || [];
    const subject = headers.find((h) => h.name === 'Subject')?.value || '(No Subject)';
    const from = headers.find((h) => h.name === 'From')?.value || '';
    const date = headers.find((h) => h.name === 'Date')?.value || '';

    const full = await gmail.users.messages.get({ userId: 'me', id: message.id!, format: 'full' });

    const attachments: string[] = [];
    const stack = [full.data.payload];
    while (stack.length > 0) {
      const part = stack.pop();
      if (!part) continue;
      if (part.filename) attachments.push(part.filename);
      if (part.parts?.length) stack.push(...part.parts);
    }

    const hasPdf = attachments.some((a) => a.toLowerCase().endsWith('.pdf'));

    items.push({
      id: message.id!,
      threadId: message.threadId || '',
      date,
      subject,
      from,
      hasPdf,
      attachments,
      snippet: msg.data.snippet || ''
    });
  }

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        query,
        totalEmails: items.length,
        emailsWithPdf: items.filter((i) => i.hasPdf).length,
        items
      },
      null,
      2
    )
  );

  console.log(`Found ${items.length} NPS email(s)`);
  console.log(`PDF email(s): ${items.filter((i) => i.hasPdf).length}`);
  if (items[0]) {
    console.log(`Latest: ${items[0].subject}`);
    console.log(`Date: ${items[0].date}`);
  }
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  checkNpsMail().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
