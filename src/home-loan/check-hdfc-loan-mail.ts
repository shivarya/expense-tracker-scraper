import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { authenticateGmail } from '../utils/gmail.js';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'hdfc-loan-email-list.json');
const LOAN_SENDER = 'customer.service@hdfcbank.bank.in';

async function checkHdfcLoanMail() {
  console.log('🔎 Checking Gmail for HDFC home loan statement emails\n');
  console.log('━'.repeat(60));

  const auth = await authenticateGmail();
  const gmail = google.gmail({ version: 'v1', auth });

  const query = `from:${LOAN_SENDER}`;
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
    const full = await gmail.users.messages.get({ userId: 'me', id: message.id!, format: 'full' });

    const headers = full.data.payload?.headers || [];
    const subject = headers.find((h) => h.name === 'Subject')?.value || '(No Subject)';
    const from = headers.find((h) => h.name === 'From')?.value || '';
    const date = headers.find((h) => h.name === 'Date')?.value || '';

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
      snippet: full.data.snippet || ''
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

  console.log(`Found ${items.length} email(s) from ${LOAN_SENDER}`);
  console.log(`PDF email(s): ${items.filter((i) => i.hasPdf).length}`);
  for (const item of items.slice(0, 10)) {
    console.log(`\n- ${item.date}`);
    console.log(`  Subject: ${item.subject}`);
    console.log(`  Attachments: ${item.attachments.join(', ') || '(none)'}`);
  }
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  checkHdfcLoanMail().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
