import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const ENRICHED_FILE = path.join(process.cwd(), 'data', 'enriched-home-loans.json');

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
}

function isRenovation(loanName: string): boolean {
  return /Renovation/i.test(loanName);
}

async function syncHomeLoans() {
  console.log('🚀 Syncing HDFC home loans to server\n');
  console.log('━'.repeat(60));

  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_TOKEN;
  if (!apiUrl || !apiToken) {
    throw new Error('Missing API_URL or API_TOKEN in .env');
  }

  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  const content = await fs.readFile(ENRICHED_FILE, 'utf-8');
  const data = JSON.parse(content) as { loans: EnrichedLoan[] };

  // Step 1: ensure a bank_accounts row exists per loan (account_type: 'loan')
  const accountsResponse = await axios.get(`${apiUrl}/accounts`, { headers });
  const accounts = accountsResponse.data?.data || [];
  const accountByNumber = new Map<string, number>(
    accounts.map((a: any) => [a.account_number, a.id])
  );

  const accountIdByLoan = new Map<string, number>();

  for (const loan of data.loans) {
    let accountId = accountByNumber.get(loan.loan_account_number);

    if (!accountId) {
      const last4 = loan.loan_account_number.slice(-4);
      const accountName = `HDFC ${isRenovation(loan.loan_name) ? 'House Renovation' : 'Home'} Loan *${last4}`;

      const createResponse = await axios.post(
        `${apiUrl}/accounts`,
        {
          bank: 'hdfc',
          account_type: 'loan',
          account_number: loan.loan_account_number,
          account_name: accountName,
          status: 'active'
        },
        { headers }
      );

      accountId = createResponse.data?.data?.id;
      console.log(`✅ Created loan account: ${accountName} (id=${accountId})`);
    }

    if (!accountId) {
      throw new Error(`Failed to resolve account_id for loan ${loan.loan_account_number}`);
    }
    accountIdByLoan.set(loan.loan_account_number, accountId);
  }

  // Step 2: match against existing emis by loan_name, then create or update
  const emisResponse = await axios.get(`${apiUrl}/emis`, { headers });
  const existingEmis = emisResponse.data?.data || [];
  const emiByLoanName = new Map<string, any>(existingEmis.map((e: any) => [e.loan_name, e]));

  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const loan of data.loans) {
    try {
      const existing = emiByLoanName.get(loan.loan_name);

      if (existing) {
        await axios.put(
          `${apiUrl}/emis/${existing.id}`,
          {
            remaining_months: loan.remaining_months,
            remaining_principal: loan.remaining_principal,
            last_payment_date: loan.last_payment_date,
            next_payment_date: loan.next_payment_date,
            total_paid: loan.total_paid,
            status: loan.status,
            interest_rate: loan.interest_rate,
            emi_amount: loan.emi_amount
          },
          { headers }
        );
        updated++;
        console.log(`🔄 Updated: ${loan.loan_name} — remaining ₹${loan.remaining_principal.toLocaleString('en-IN')}`);
      } else {
        const accountId = accountIdByLoan.get(loan.loan_account_number);
        await axios.post(
          `${apiUrl}/emis`,
          {
            account_id: accountId,
            loan_name: loan.loan_name,
            loan_type: loan.loan_type,
            bank: loan.bank,
            principal_amount: loan.principal_amount,
            interest_rate: loan.interest_rate,
            tenure_months: loan.tenure_months,
            emi_amount: loan.emi_amount,
            start_date: loan.start_date,
            due_date: loan.due_date,
            remaining_months: loan.remaining_months,
            remaining_principal: loan.remaining_principal,
            last_payment_date: loan.last_payment_date,
            next_payment_date: loan.next_payment_date,
            total_paid: loan.total_paid,
            status: loan.status,
            auto_debit: true
          },
          { headers }
        );
        created++;
        console.log(`✅ Created: ${loan.loan_name} — remaining ₹${loan.remaining_principal.toLocaleString('en-IN')}`);
      }
    } catch (error: any) {
      if (error.response?.status === 422) {
        console.log(`⏭️  Skipped (duplicate): ${loan.loan_name}`);
      } else {
        failed++;
        const msg = error.response?.data?.message || error.message;
        errors.push(`${loan.loan_name}: ${msg}`);
        console.log(`❌ Failed: ${loan.loan_name} - ${msg}`);
      }
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log('✅ Sync completed!');
  console.log(`   Created: ${created}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Failed: ${failed}`);
  if (errors.length > 0) {
    console.log('\n⚠️  Errors:');
    errors.forEach((e) => console.log(`   - ${e}`));
  }
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  syncHomeLoans().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
