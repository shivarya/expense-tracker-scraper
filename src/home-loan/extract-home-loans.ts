import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFParse } from 'pdf-parse';

const METADATA_FILE = path.join(process.cwd(), 'data', 'home-loan-statements.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'home-loan-raw.json');

interface LedgerRow {
  acc_date: string;
  doc_no: string;
  pm_code: string;
  description: string;
  amount: number;
  eff_date: string;
}

interface ExtractedLoan {
  loan_account_number: string;
  loan_type_raw: string | null;
  loan_amount: number | null;
  roi: number | null;
  current_emi: number | null;
  statement_period: string | null;
  borrowers: string[];
  transactions: LedgerRow[];
}

function parseDdMmmYyyy(raw: string): string {
  // "06-APR-2026" -> "2026-04-06"
  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
  };
  const match = raw.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/);
  if (!match) return raw;
  const [, day, mon, year] = match;
  return `${year}-${months[mon] || '01'}-${day}`;
}

async function parsePdfText(pdfPath: string): Promise<string> {
  const buffer = await fs.readFile(pdfPath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// HDFC's PDF text extracts the ledger table in COLUMN-MAJOR order, not row by
// row: all "Acc Dt" values first, then all "Doc No", then all "PM" codes, then
// description text, then all "Amount" values, then all "Eff Dt" values. This
// reconstructs rows by re-zipping those column groups back together.
function extractLedger(text: string): LedgerRow[] {
  const startMarker = '(For Chq Bounce if any)';
  const endMarker = 'Negative amounts are indicated in brackets.';
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return [];

  const block = text.slice(startIdx + startMarker.length, endIdx);
  const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const dateRe = /^\d{2}-[A-Z]{3}-\d{4}$/;

  let i = 0;
  const accDates: string[] = [];
  while (i < lines.length && dateRe.test(lines[i])) {
    accDates.push(lines[i]);
    i++;
  }
  const n = accDates.length;
  if (n === 0) return [];

  const docNos = lines.slice(i, i + n);
  i += n;
  const pmCodes = lines.slice(i, i + n);
  i += n;

  const remaining = lines.slice(i);
  if (remaining.length < 2 * n) {
    console.log(`⚠️  Ledger block shorter than expected (${remaining.length} lines left, need ${2 * n}) — parsing may be incomplete`);
  }
  const effDates = remaining.slice(remaining.length - n);
  const amounts = remaining.slice(remaining.length - 2 * n, remaining.length - n);
  const descLines = remaining.slice(0, remaining.length - 2 * n);

  // Group description lines into n entries using HDFC's known row vocabulary.
  const descriptions: string[] = [];
  let d = 0;
  while (descriptions.length < n && d < descLines.length) {
    const norm = descLines[d].replace(/\s+/g, '');
    if (norm === 'EMI' && descLines[d + 1]?.trim() === 'PREPAYMENT') {
      descriptions.push('EMI PREPAYMENT');
      d += 2;
    } else if (norm === 'EMI') {
      descriptions.push('EMI');
      d += 1;
    } else if (descLines[d] === 'SIMPLE' && descLines[d + 1]?.toUpperCase().startsWith('INTEREST') && descLines[d + 2] === 'PREPAYMENTS') {
      descriptions.push('SIMPLE INTEREST ON PREPAYMENTS');
      d += 3;
    } else {
      console.log(`⚠️  Unrecognized ledger description line: "${descLines[d]}" — keeping as-is`);
      descriptions.push(descLines[d]);
      d += 1;
    }
  }

  const rows: LedgerRow[] = [];
  for (let k = 0; k < n; k++) {
    rows.push({
      acc_date: parseDdMmmYyyy(accDates[k]),
      doc_no: docNos[k] || '',
      pm_code: pmCodes[k] || '',
      description: (descriptions[k] || '').trim(),
      amount: parseFloat((amounts[k] || '0').replace(/,/g, '')),
      eff_date: parseDdMmmYyyy(effDates[k])
    });
  }
  return rows;
}

function extractLoan(text: string, loanAccountNumber: string): ExtractedLoan {
  const loanAmountMatch = text.match(/LOAN AMOUNT\s*:\s*([\d,]+)/i);
  const roiMatch = text.match(/ROI\s*:\s*([\d.]+)\s*%/i);
  const emiMatch = text.match(/CURRENT EMI\s*:\s*([\d,]+)/i);
  const periodMatch = text.match(/STATEMENT OF ACCOUNT FOR THE PERIOD\s+([\d\-A-Z]+\s+to\s+[\d\-A-Z]+)/i);

  // Best-effort: HDFC's product-name header line, e.g.
  // "TYPE : RESIDENT HOME LOAN-VARIABLE RATE-MONTHLY REST"
  const typeMatch = text.match(/TYPE\s*:\s*([A-Z][A-Z \-]*LOAN[A-Z \-]*)/i);

  // Best-effort: "BORROWER /S:" section, one name per line until a blank/non-name line
  const borrowers: string[] = [];
  const borrowerSection = text.match(/BORROWER\s*\/?S?:?\s*\n([\s\S]*?)(?:\(All amounts|LOAN AMOUNT)/i);
  if (borrowerSection) {
    for (const line of borrowerSection[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed && /[A-Z]{2,}/.test(trimmed)) borrowers.push(trimmed);
    }
  }

  const transactions = extractLedger(text);

  return {
    loan_account_number: loanAccountNumber,
    loan_type_raw: typeMatch ? typeMatch[1].trim() : null,
    loan_amount: loanAmountMatch ? parseFloat(loanAmountMatch[1].replace(/,/g, '')) : null,
    roi: roiMatch ? parseFloat(roiMatch[1]) : null,
    current_emi: emiMatch ? parseFloat(emiMatch[1].replace(/,/g, '')) : null,
    statement_period: periodMatch ? periodMatch[1] : null,
    borrowers,
    transactions
  };
}

async function extractHomeLoans() {
  console.log('🔍 Extracting HDFC home loan statement data\n');
  console.log('━'.repeat(60));

  const metadataRaw = await fs.readFile(METADATA_FILE, 'utf-8');
  const metadata = JSON.parse(metadataRaw);
  const loans = metadata.loans as Array<{ loan_account_number: string; pdfPath: string }>;

  const results: ExtractedLoan[] = [];

  for (const loan of loans) {
    console.log(`\n📄 Parsing loan ${loan.loan_account_number}: ${loan.pdfPath}`);
    const text = await parsePdfText(loan.pdfPath);
    const extracted = extractLoan(text, loan.loan_account_number);

    if (!extracted.loan_amount || !extracted.roi || !extracted.current_emi) {
      console.log(`⚠️  Missing core fields for loan ${loan.loan_account_number} — check PDF format`);
    }
    console.log(`   Loan amount: ${extracted.loan_amount}, ROI: ${extracted.roi}%, EMI: ${extracted.current_emi}`);
    console.log(`   Transactions found: ${extracted.transactions.length}`);

    results.push(extracted);
  }

  await fs.writeFile(OUTPUT_FILE, JSON.stringify({ extractedAt: new Date().toISOString(), loans: results }, null, 2));
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  extractHomeLoans().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
