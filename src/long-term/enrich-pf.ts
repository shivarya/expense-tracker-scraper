import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync } from 'fs';

const INPUT_FILE = path.join(process.cwd(), 'data', 'epfo-passbook.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'enriched-pf.json');
const PDF_TEXT_DIR = path.join(process.cwd(), 'data', 'raw-extracts', 'epfo-pdfs');

function parseWageMonth(wageMonth: string): Date | null {
  // "Mar-2025" → Date
  const match = wageMonth.match(/^([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const monthMap: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const monthIdx = monthMap[match[1].toLowerCase()];
  if (monthIdx === undefined) return null;
  return new Date(Number(match[2]), monthIdx, 1);
}

function toDateStr(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().split('T')[0];
}

interface PassbookEntry {
  wageMonth: string;
  transactionDate: string;
  employeeShare: number;
  employerShare: number;
  pensionShare: number;
  year: string;
}

interface MemberAccount {
  memberId: string;
  entries: PassbookEntry[];
  openingBalance: { employeeShare: number; employerShare: number; pensionShare: number } | null;
  yearTotals: any[];
  yearsAvailable: string[];
  pdfFiles: string[];
  entryCount: number;
}

/**
 * Parse closing balance from PDF text files for a given member.
 * PDF format: "Closing Balance as on DD/MM/YYYY  EE_Share  ER_Share  Pension"
 * Returns the latest closing balance found.
 */
function getClosingBalanceFromPdfs(memberId: string): {
  employeeShare: number;
  employerShare: number;
  pensionShare: number;
  total: number;
  asOnDate: string;
} | null {
  try {
    const files = readdirSync(PDF_TEXT_DIR).filter(f => f.endsWith('.txt'));
    // Find text files matching this member ID
    const memberFiles = files
      .filter(f => f.includes(memberId))
      .sort() // sort by name → natural year order
      .reverse(); // latest first

    // If no member-specific files, fall back to non-prefixed files (single-member case)
    const candidates = memberFiles.length > 0 ? memberFiles : files.filter(f => !f.match(/[A-Z]{5}\d{17}/));

    for (const file of candidates) {
      const text = readFileSync(path.join(PDF_TEXT_DIR, file), 'utf-8');
      // Match: "Closing Balance as on DD/MM/YYYY  amount1  amount2  amount3"
      // The first occurrence in a passbook PDF has EE, ER, Pension format
      const matches = [...text.matchAll(/Closing Balance as on (\d{2}\/\d{2}\/\d{4})\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/g)];
      if (matches.length > 0) {
        // First match in each PDF is the contribution-split closing balance (EE, ER, Pension)
        const m = matches[0];
        const parseAmt = (s: string) => parseInt(s.replace(/,/g, ''), 10) || 0;
        const ee = parseAmt(m[2]);
        const er = parseAmt(m[3]);
        const pension = parseAmt(m[4]);
        return {
          employeeShare: ee,
          employerShare: er,
          pensionShare: pension,
          total: ee + er + pension,
          asOnDate: m[1],
        };
      }
    }
  } catch {
    // PDF text dir may not exist
  }
  return null;
}

/**
 * Extract UAN from PDF text files.
 * PDF format contains: "UAN 100792384404"
 */
function getUanFromPdfs(): string | null {
  try {
    const files = readdirSync(PDF_TEXT_DIR).filter(f => f.endsWith('.txt')).sort().reverse();
    for (const file of files) {
      const text = readFileSync(path.join(PDF_TEXT_DIR, file), 'utf-8');
      const match = text.match(/UAN\s+(\d{12})/);
      if (match) return match[1];
    }
  } catch {}
  return null;
}

async function enrichPf() {
  console.log('🚀 Enriching EPFO PF data\n');
  console.log('━'.repeat(60));

  const raw = JSON.parse(await fs.readFile(INPUT_FILE, 'utf-8'));
  const memberAccounts: MemberAccount[] = raw.memberAccounts || [];

  if (memberAccounts.length === 0) {
    throw new Error('No memberAccounts found in epfo-passbook.json');
  }

  const longTermFunds = [];
  let totalInvested = 0;
  let totalEmployer = 0;
  let totalPension = 0;

  // Extract UAN from PDF text files (same UAN for all member accounts)
  const uan = getUanFromPdfs();
  if (uan) {
    console.log(`  🔑 UAN: ${uan}`);
  }

  for (const member of memberAccounts) {
    const entries = member.entries || [];

    // Calculate totals from entries (contributions only, no interest)
    const employeeTotal = entries.reduce((s, e) => s + (e.employeeShare || 0), 0);
    const employerTotal = entries.reduce((s, e) => s + (e.employerShare || 0), 0);
    const pensionTotal = entries.reduce((s, e) => s + (e.pensionShare || 0), 0);
    const contributionTotal = employeeTotal + employerTotal + pensionTotal;

    // Get closing balance from PDF text files (includes accumulated interest)
    const closingBalance = getClosingBalanceFromPdfs(member.memberId);

    // Determine date range from wage months
    const dates = entries
      .map(e => parseWageMonth(e.wageMonth))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());

    const startDate = dates.length > 0 ? dates[0] : null;
    const lastContributionDate = dates.length > 0 ? dates[dates.length - 1] : null;

    // invested_amount = employee contribution (what the employee put in)
    // current_value = closing balance from PDF (EE + ER including interest), or fallback to contribution sum
    // employer_contribution = employer closing balance (includes interest on employer share)
    // interest_earned = closing balance total - contribution total
    const investedAmount = closingBalance ? closingBalance.employeeShare : employeeTotal;
    const currentValue = closingBalance ? (closingBalance.employeeShare + closingBalance.employerShare) : (employeeTotal + employerTotal);
    const employerContribution = closingBalance ? closingBalance.employerShare : employerTotal;
    const interestEarned = closingBalance ? (currentValue - (employeeTotal + employerTotal)) : 0;

    if (closingBalance) {
      console.log(`  📊 Closing balance from PDF (as on ${closingBalance.asOnDate}):`);
      console.log(`     EE: ₹${closingBalance.employeeShare.toLocaleString('en-IN')}  ER: ₹${closingBalance.employerShare.toLocaleString('en-IN')}  Pension: ₹${closingBalance.pensionShare.toLocaleString('en-IN')}`);
      console.log(`     Interest earned: ₹${interestEarned.toLocaleString('en-IN')}`);
    } else {
      console.log(`  ⚠️  No closing balance found in PDFs, using contribution totals only`);
    }

    const fund = {
      fund_type: 'pf',
      account_name: `EPF - ${member.memberId}`,
      account_number: member.memberId,
      pran_number: null,
      uan_number: uan,
      invested_amount: investedAmount,
      current_value: currentValue,
      employer_contribution: employerContribution,
      interest_earned: interestEarned,
      pension_share: closingBalance?.pensionShare || pensionTotal,
      maturity_date: null,
      maturity_value: null,
      lock_in_period_years: null,
      start_date: toDateStr(startDate),
      last_contribution_date: toDateStr(lastContributionDate),
      status: 'active'
    };

    longTermFunds.push(fund);
    totalInvested += investedAmount;
    totalEmployer += employerContribution;
    totalPension += fund.pension_share;
  }

  const totalCorpus = longTermFunds.reduce((s, f) => s + f.current_value, 0);
  const totalInterest = longTermFunds.reduce((s, f) => s + f.interest_earned, 0);

  const output = {
    enrichedAt: new Date().toISOString(),
    source: 'epfo_passbook',
    summary: {
      memberAccounts: memberAccounts.length,
      totalEntries: memberAccounts.reduce((s, m) => s + m.entryCount, 0),
      employeeContribution: totalInvested,
      employerContribution: totalEmployer,
      pensionContribution: totalPension,
      interestEarned: totalInterest,
      totalCorpus: totalCorpus
    },
    longTermFunds
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n✅ PF enrichment complete`);
  console.log(`👥 Member accounts: ${memberAccounts.length}`);
  for (const fund of longTermFunds) {
    console.log(`\n  📋 ${fund.account_number}`);
    console.log(`     Employee:  ₹${fund.invested_amount.toLocaleString('en-IN')}`);
    console.log(`     Employer:  ₹${fund.employer_contribution.toLocaleString('en-IN')}`);
    if (fund.interest_earned > 0) {
      console.log(`     Interest:  ₹${fund.interest_earned.toLocaleString('en-IN')}`);
    }
    console.log(`     Corpus:    ₹${fund.current_value.toLocaleString('en-IN')}`);
    console.log(`     Period:    ${fund.start_date || '?'} → ${fund.last_contribution_date || '?'}`);
  }
  console.log(`\n💰 Total Corpus: ₹${totalCorpus.toLocaleString('en-IN')} (incl. ₹${totalInterest.toLocaleString('en-IN')} interest)`);
  console.log(`📄 Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  enrichPf().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
