import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const INPUT_FILE = path.join(process.cwd(), 'data', 'nps-raw.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'enriched-nps.json');

function toDateOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split('T')[0];
}

async function enrichNps() {
  console.log('🚀 Enriching NPS data\n');
  console.log('━'.repeat(60));

  const raw = JSON.parse(await fs.readFile(INPUT_FILE, 'utf-8'));
  const nps = raw.nps || {};

  const totalContribution = Number(nps.total_contribution || 0);
  const currentValue = Number(nps.current_value || nps.closing_balance || 0);
  const interestEarned = Number(nps.interest_earned || (currentValue - totalContribution));

  const accountName = nps.account_name?.trim()
    ? `${nps.account_name}${nps.tier ? ` - ${nps.tier}` : ''}`
    : `NPS ${nps.tier || 'Tier I'}`;

  const status = ['active', 'matured', 'closed'].includes((nps.status || '').toLowerCase())
    ? nps.status.toLowerCase()
    : 'active';

  const fund = {
    fund_type: 'nps',
    account_name: accountName,
    account_number: nps.account_number || null,
    pran_number: nps.pran_number || null,
    uan_number: null,
    invested_amount: totalContribution,
    current_value: currentValue,
    employer_contribution: Number(nps.employer_contribution || 0),
    interest_earned: interestEarned,
    maturity_date: null,
    maturity_value: null,
    lock_in_period_years: 60,
    start_date: toDateOrNull(nps.statement_period?.from),
    last_contribution_date: toDateOrNull(nps.last_contribution_date || nps.statement_period?.to),
    status
  };

  const output = {
    enrichedAt: new Date().toISOString(),
    source: 'NPS Statement Email',
    summary: {
      count: 1,
      investedAmount: fund.invested_amount,
      currentValue: fund.current_value,
      gainLossAmount: Number((fund.current_value - fund.invested_amount).toFixed(2))
    },
    longTermFunds: [fund]
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log('✅ NPS enrichment complete');
  console.log(`Invested: ₹${output.summary.investedAmount.toLocaleString('en-IN')}`);
  console.log(`Current: ₹${output.summary.currentValue.toLocaleString('en-IN')}`);
  console.log(`Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  enrichNps().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
