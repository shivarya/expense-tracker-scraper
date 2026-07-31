import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const RAW_FILE = path.join(process.cwd(), 'data', 'home-loan-raw.json');
const SEED_FILE = path.join(process.cwd(), 'data', 'home-loan-manual-seed.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'enriched-home-loans.json');

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

interface SeedEntry {
  outstanding_balance: number;
  as_of_date: string;
  // Optional authoritative values, e.g. read straight off a bank NetBanking
  // "Account Summary" screen — when present, these replace the amortization-
  // formula approximations for remaining_months/tenure_months/start_date.
  remaining_months?: number;
  tenure_months?: number;
  start_date?: string;
}

interface ExistingEmi {
  id: number;
  loan_name: string;
  principal_amount: number;
  remaining_principal: number;
  remaining_months: number;
  last_payment_date: string | null;
  tenure_months: number;
  start_date: string;
}

interface EnrichedLoan {
  loan_account_number: string;
  loan_name: string;
  loan_type: 'home';
  bank: 'hdfc';
  principal_amount: number;
  interest_rate: number;
  emi_amount: number;
  tenure_months: number;
  start_date: string;
  end_date: string;
  due_date: number;
  remaining_months: number;
  remaining_principal: number;
  last_payment_date: string;
  next_payment_date: string | null;
  total_paid: number;
  status: 'active' | 'paid';
  fees_charged: Array<{ date: string; description: string; amount: number }>;
}

function isRenovation(loanTypeRaw: string | null): boolean {
  return !!loanTypeRaw && /RENOVATION/i.test(loanTypeRaw);
}

function buildLoanName(loan: ExtractedLoan): string {
  const kind = isRenovation(loan.loan_type_raw) ? 'House Renovation' : 'Home';
  return `HDFC ${kind} Loan ${loan.loan_account_number}`;
}

function monthlyRate(roi: number): number {
  return roi / 12 / 100;
}

// Standard reducing-balance remaining-tenure formula, given a fixed EMI.
function computeRemainingMonths(balance: number, emiAmount: number, roi: number): number {
  if (balance <= 0) return 0;
  const r = monthlyRate(roi);
  const ratio = (r * balance) / emiAmount;
  if (ratio >= 1) {
    // EMI can't even cover the interest at this balance — cannot be represented
    // by the standard formula; fall back to a conservative large tenure so the
    // record still surfaces as active rather than throwing.
    return 999;
  }
  const months = -Math.log(1 - ratio) / Math.log(1 + r);
  return Math.max(0, Math.ceil(months));
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function dayOf(dateStr: string): number {
  return parseInt(dateStr.slice(8, 10), 10);
}

async function fetchExistingEmis(apiUrl: string, apiToken: string): Promise<ExistingEmi[]> {
  const response = await axios.get(`${apiUrl}/emis`, {
    headers: { Authorization: `Bearer ${apiToken}` }
  });
  return response.data?.data || [];
}

async function readSeed(): Promise<Record<string, SeedEntry>> {
  try {
    const raw = await fs.readFile(SEED_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function enrichLoan(
  loan: ExtractedLoan,
  loanName: string,
  existing: ExistingEmi | undefined,
  seed: SeedEntry | undefined
): EnrichedLoan {
  if (!loan.loan_amount || !loan.roi || !loan.current_emi) {
    throw new Error(`Loan ${loan.loan_account_number} is missing core fields (loan_amount/roi/current_emi) — check extract step`);
  }

  const roi = loan.roi;
  const emiAmount = loan.current_emi;
  const principalAmount = existing ? existing.principal_amount : loan.loan_amount;

  let runningBalance: number;
  let boundaryDate: string;
  let remainingMonths: number;
  let tenureMonths: number;
  let startDate: string;

  if (existing) {
    runningBalance = existing.remaining_principal;
    boundaryDate = existing.last_payment_date || existing.start_date;
    remainingMonths = existing.remaining_months;
    tenureMonths = existing.tenure_months;
    startDate = existing.start_date;
  } else {
    const seedEntry = seed;
    if (!seedEntry) {
      throw new Error(
        `No existing emis record and no manual seed entry for loan ${loan.loan_account_number}. ` +
        `Add it to ${SEED_FILE} as { "outstanding_balance": N, "as_of_date": "YYYY-MM-DD" }.`
      );
    }
    runningBalance = seedEntry.outstanding_balance;
    boundaryDate = seedEntry.as_of_date;
    // Prefer authoritative values from the seed (e.g. NetBanking's own balance-
    // term figure) over the amortization-formula approximation.
    remainingMonths = seedEntry.remaining_months ?? computeRemainingMonths(runningBalance, emiAmount, roi);
    tenureMonths = seedEntry.tenure_months ?? remainingMonths;
    startDate = seedEntry.start_date ?? seedEntry.as_of_date;
  }

  const feesCharged: Array<{ date: string; description: string; amount: number }> = [];
  let dueDate = existing ? dayOf(boundaryDate) : dayOf(boundaryDate);
  let lastPaymentDate = boundaryDate;

  const sortedTxns = [...loan.transactions].sort((a, b) => (a.eff_date < b.eff_date ? -1 : 1));

  for (const row of sortedTxns) {
    if (row.eff_date <= boundaryDate) continue;

    const isPrepayment = /PREPAYMENT/i.test(row.description) && !/SIMPLE INTEREST/i.test(row.description);
    const isFee = /SIMPLE INTEREST/i.test(row.description);
    const isEmi = /^E\s*M\s*I$/i.test(row.description);

    if (isEmi) {
      const r = monthlyRate(roi);
      const interestComponent = Math.round(runningBalance * r * 100) / 100;
      const principalComponent = Math.round((row.amount - interestComponent) * 100) / 100;
      runningBalance = Math.round((runningBalance - principalComponent) * 100) / 100;
      remainingMonths = Math.max(0, remainingMonths - 1);
      dueDate = dayOf(row.eff_date);
    } else if (isPrepayment) {
      runningBalance = Math.round((runningBalance - row.amount) * 100) / 100;
      remainingMonths = computeRemainingMonths(runningBalance, emiAmount, roi);
    } else if (isFee) {
      feesCharged.push({ date: row.eff_date, description: row.description, amount: row.amount });
    } else {
      console.log(`⚠️  Unrecognized ledger row for loan ${loan.loan_account_number}: "${row.description}" — skipped (balance untouched)`);
    }

    lastPaymentDate = row.eff_date;
  }

  runningBalance = Math.max(0, runningBalance);
  const totalPaid = Math.round((principalAmount - runningBalance) * 100) / 100;
  const status: 'active' | 'paid' = runningBalance <= 0 ? 'paid' : 'active';
  const nextPaymentDate = status === 'active' && remainingMonths > 0
    ? addMonths(lastPaymentDate, 1)
    : null;
  const endDate = addMonths(startDate, tenureMonths);

  return {
    loan_account_number: loan.loan_account_number,
    loan_name: loanName,
    loan_type: 'home',
    bank: 'hdfc',
    principal_amount: principalAmount,
    interest_rate: roi,
    emi_amount: emiAmount,
    tenure_months: tenureMonths,
    start_date: startDate,
    end_date: endDate,
    due_date: dueDate,
    remaining_months: remainingMonths,
    remaining_principal: runningBalance,
    last_payment_date: lastPaymentDate,
    next_payment_date: nextPaymentDate,
    total_paid: totalPaid,
    status,
    fees_charged: feesCharged
  };
}

async function enrichHomeLoans() {
  console.log('💰 Enriching HDFC home loan data\n');
  console.log('━'.repeat(60));

  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_TOKEN;
  if (!apiUrl || !apiToken) {
    throw new Error('Missing API_URL or API_TOKEN in .env');
  }

  const rawContent = await fs.readFile(RAW_FILE, 'utf-8');
  const raw = JSON.parse(rawContent) as { loans: ExtractedLoan[] };

  const [existingEmis, seed] = await Promise.all([
    fetchExistingEmis(apiUrl, apiToken),
    readSeed()
  ]);

  const results: EnrichedLoan[] = [];

  for (const loan of raw.loans) {
    const loanName = buildLoanName(loan);
    const existing = existingEmis.find((e) => e.loan_name === loanName);
    const seedEntry = seed[loan.loan_account_number];

    console.log(`\n📊 Loan ${loan.loan_account_number} (${loanName})`);
    console.log(`   Mode: ${existing ? 'carry-forward from GET /emis' : 'manual seed'}`);

    const enriched = enrichLoan(loan, loanName, existing, seedEntry);
    results.push(enriched);

    console.log(`   Remaining principal: ₹${enriched.remaining_principal.toLocaleString('en-IN')}`);
    console.log(`   Remaining months: ${enriched.remaining_months}`);
    console.log(`   Status: ${enriched.status}`);
    if (enriched.fees_charged.length > 0) {
      console.log(`   Fees logged (not deducted from balance): ${enriched.fees_charged.length}`);
    }
  }

  await fs.writeFile(OUTPUT_FILE, JSON.stringify({ enrichedAt: new Date().toISOString(), loans: results }, null, 2));
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  enrichHomeLoans().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
