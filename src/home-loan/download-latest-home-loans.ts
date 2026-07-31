import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { authenticateGmail } from '../utils/gmail.js';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const PDF_DIR = path.join(OUTPUT_DIR, 'home-loan-pdfs');
const METADATA_FILE = path.join(process.cwd(), 'data', 'home-loan-statements.json');
const LOAN_SENDER = 'customer.service@hdfcbank.bank.in';

interface EmailMatch {
  id: string;
  date: string;
  subject: string;
  loanAccountNumber: string;
}

function extractLoanAccountNumber(subject: string): string | null {
  const match = subject.match(/Loan\s+Account\s+No\.?\s*[:\-]?\s*(\d{6,})/i);
  return match ? match[1] : null;
}

function collectPdfParts(part: any): Array<{ filename: string; attachmentId?: string }> {
  const found: Array<{ filename: string; attachmentId?: string }> = [];
  if (part?.filename?.toLowerCase().endsWith('.pdf')) {
    found.push({ filename: part.filename, attachmentId: part.body?.attachmentId });
  }
  if (part?.parts?.length) {
    for (const p of part.parts) found.push(...collectPdfParts(p));
  }
  return found;
}

async function downloadLatestHomeLoans() {
  console.log('⬇️ Downloading latest HDFC home loan statement PDFs\n');
  console.log('━'.repeat(60));

  const auth = await authenticateGmail();
  const gmail = google.gmail({ version: 'v1', auth });

  const query = `from:${LOAN_SENDER} subject:"Statement Of Account"`;
  const listResponse = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 30 });
  const messages = listResponse.data.messages || [];

  const matches: EmailMatch[] = [];
  for (const message of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: message.id!, format: 'full' });
    const headers = full.data.payload?.headers || [];
    const subject = headers.find((h) => h.name === 'Subject')?.value || '';
    const date = headers.find((h) => h.name === 'Date')?.value || '';

    const loanAccountNumber = extractLoanAccountNumber(subject);
    if (!loanAccountNumber) {
      console.log(`⚠️  Skipping email with unparseable subject: ${subject}`);
      continue;
    }

    matches.push({ id: message.id!, date, subject, loanAccountNumber });
  }

  // Keep only the latest email per distinct loan account number
  const latestByLoan = new Map<string, EmailMatch>();
  for (const m of matches) {
    const existing = latestByLoan.get(m.loanAccountNumber);
    if (!existing || new Date(m.date).getTime() > new Date(existing.date).getTime()) {
      latestByLoan.set(m.loanAccountNumber, m);
    }
  }

  if (latestByLoan.size === 0) {
    throw new Error(`No "Statement Of Account" emails found from ${LOAN_SENDER}`);
  }

  await fs.mkdir(PDF_DIR, { recursive: true });

  const loans: Array<{ loan_account_number: string; subject: string; date: string; pdfPath: string }> = [];

  for (const match of latestByLoan.values()) {
    const full = await gmail.users.messages.get({ userId: 'me', id: match.id, format: 'full' });
    const pdfParts = collectPdfParts(full.data.payload);

    if (pdfParts.length === 0) {
      console.log(`⚠️  No PDF attachment found for loan ${match.loanAccountNumber}`);
      continue;
    }

    for (const pdfPart of pdfParts) {
      if (!pdfPart.attachmentId) continue;
      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: match.id,
        id: pdfPart.attachmentId
      });

      const buffer = Buffer.from(attachment.data.data || '', 'base64');
      const ts = new Date(match.date).getTime() || Date.now();
      const cleanName = pdfPart.filename.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_{2,}/g, '_');
      const outFile = `${match.loanAccountNumber}_${ts}_${cleanName}`;
      const outPath = path.join(PDF_DIR, outFile);
      await fs.writeFile(outPath, buffer);

      loans.push({
        loan_account_number: match.loanAccountNumber,
        subject: match.subject,
        date: match.date,
        pdfPath: outPath
      });

      console.log(`✅ Saved loan ${match.loanAccountNumber}: ${outPath}`);
    }
  }

  await fs.mkdir(path.dirname(METADATA_FILE), { recursive: true });
  await fs.writeFile(
    METADATA_FILE,
    JSON.stringify({ downloadedAt: new Date().toISOString(), loans }, null, 2)
  );

  console.log(`\n✅ Metadata saved: ${METADATA_FILE}`);
  console.log(`   ${loans.length} loan statement(s) downloaded`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  downloadLatestHomeLoans().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
