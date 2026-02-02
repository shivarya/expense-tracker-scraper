/**
 * Sync enriched EMI plans to server
 * This reads the enriched EMI data and syncs to production
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function syncEMIs() {
  console.log('🚀 Syncing Enriched EMI Plans to Server\n');
  console.log('━'.repeat(60));

  // Read enriched EMI data
  const enrichedPath = path.join(__dirname, '../../data/enriched-emis.json');
  
  try {
    const content = await fs.readFile(enrichedPath, 'utf-8');
    const data = JSON.parse(content);

    console.log(`\n📊 Loaded ${data.summary.totalPlans} EMI plans`);
    console.log(`✅ Active: ${data.summary.activePlans}`);
    console.log(`✅ Completed: ${data.summary.completedPlans}`);
    console.log(`💰 Total Monthly Burden: ₹${data.summary.totalMonthlyBurden.toLocaleString('en-IN')}`);
    console.log(`💸 Total Remaining Cost: ₹${data.summary.totalRemainingCost.toLocaleString('en-IN')}\n`);

    // Prepare for sync
    const apiUrl = process.env.API_URL;
    const apiToken = process.env.API_TOKEN;

    if (!apiUrl || !apiToken) {
      throw new Error('Missing API_URL or API_TOKEN in .env');
    }

    // First, get or create bank account for credit cards
    // We'll need to query the server to get account IDs
    
    // Convert EMI plans to server format for emis table
    const emisForSync = data.emiPlans.map((emi: any) => {
      // Parse dates (DD/MM/YYYY to YYYY-MM-DD)
      const parseDate = (dateStr: string) => {
        if (!dateStr) return null;
        const parts = dateStr.split('/');
        if (parts.length === 3) {
          return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
        return null;
      };

      // Get the oldest (start) and newest (most recent) installment dates
      const startDate = parseDate(emi.last_installment_date); // Oldest
      const mostRecentPayment = emi.installments[0] ? parseDate(emi.installments[0].date) : null;

      return {
        card_last4: emi.card_last4, // For mapping to account_id
        loan_name: emi.merchant_clean || emi.merchant,
        loan_type: emi.category || 'Shopping',
        bank: emi.card_bank,
        principal_amount: emi.amount_financed,
        // PHP's empty() treats 0 as empty, so use 0.01 for zero-interest EMIs
        interest_rate: parseFloat(emi.effective_interest_rate) || 0.01,
        tenure_months: emi.total_installments,
        emi_amount: emi.monthly_emi,
        start_date: startDate,
        due_date: mostRecentPayment ? parseInt(mostRecentPayment.split('-')[2]) : 1,
        remaining_months: emi.remaining_installments,
        remaining_principal: emi.cost_analysis.remaining_cost,
        last_payment_date: mostRecentPayment,
        next_payment_date: emi.status === 'active' && emi.estimated_completion_date ? parseDate(emi.estimated_completion_date) : null,
        total_paid: emi.amount_financed - emi.cost_analysis.remaining_cost,
        status: emi.status,
        auto_debit: true
      };
    });

    console.log('📤 Syncing to server...\n');

    // Get existing bank accounts
    const uniqueCards = [...new Set(data.emiPlans.map((e: any) => `${e.card_bank}-${e.card_last4}`))];
    const accountMap = new Map<string, number>();

    try {
      const accountsResponse = await axios.get(
        `${apiUrl}/accounts`,
        {
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const accounts = accountsResponse.data.data || [];
      
      // Map existing accounts
      for (const account of accounts) {
        const bankName = (account.bank || '').toLowerCase().replace(/\s+/g, '-');
        const last4 = account.account_number.slice(-4);
        const key = `${bankName}-${last4}`;
        accountMap.set(key, account.id);
      }

      console.log(`📋 Mapped ${accountMap.size} existing bank accounts\n`);

    } catch (error: any) {
      console.error('⚠️  Could not fetch bank accounts:', error.response?.data || error.message);
      console.log('Continuing without account mapping...\n');
    }

    // Sync each EMI individually
    let created = 0;
    let duplicates = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const emi of emisForSync) {
      try {
        // Bank names in EMIs are like "ICICI Bank", "HDFC Bank" 
        // but in accounts they're stored as "icici", "hdfc"
        // So we take the first word and lowercase it
        const bankName = (emi.bank || '').split(' ')[0].toLowerCase();
        const cardKey = `${bankName}-${emi.card_last4}`;
        const accountId = accountMap.get(cardKey);


        const emiData: any = {
          loan_name: emi.loan_name,
          loan_type: emi.loan_type,
          bank: emi.bank,
          principal_amount: emi.principal_amount,
          interest_rate: emi.interest_rate,
          tenure_months: emi.tenure_months,
          emi_amount: emi.emi_amount,
          start_date: emi.start_date,
          due_date: emi.due_date,
          remaining_months: emi.remaining_months,
          remaining_principal: emi.remaining_principal,
          last_payment_date: emi.last_payment_date,
          next_payment_date: emi.next_payment_date,
          total_paid: emi.total_paid,
          status: emi.status,
          auto_debit: emi.auto_debit
        };

        // Add account_id if available
        if (accountId) {
          emiData.account_id = accountId;
        }

        const response = await axios.post(
          `${apiUrl}/emis`,
          emiData,
          {
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        );

        created++;
        console.log(`✅ Created EMI: ${emi.loan_name} (${emi.status})`);

      } catch (error: any) {
        if (error.response?.status === 422) {
          duplicates++;
          if (error.response?.data?.errors?.duplicate) {
            console.log(`⏭️  Skipped: ${emi.loan_name} (already exists)`);
          } else {
            const errorDetails = error.response?.data?.errors || error.response?.data?.error || 'Validation error';
            console.log(`⚠️  Validation error: ${emi.loan_name}`);
            console.log(`   ${JSON.stringify(errorDetails)}`);
          }
        } else {
          failed++;
          const errorMsg = error.response?.data?.message || error.message;
          errors.push(`${emi.loan_name}: ${errorMsg}`);
          console.log(`❌ Failed: ${emi.loan_name} - ${errorMsg}`);
        }
      }
    }

    try {
      console.log('\n✅ Sync completed!');
      console.log(`   Created: ${created}`);
      console.log(`   Duplicates Skipped: ${duplicates}`);
      console.log(`   Failed: ${failed}`);

      if (errors.length > 0) {
        console.log('\n⚠️  Errors:');
        errors.forEach((err: string) => console.log(`   - ${err}`));
      }

      // Display summary of synced EMIs
      console.log('\n📋 Synced EMI Summary:');
      console.log('━'.repeat(60));
      
      const activeEMIs = data.emiPlans.filter((e: any) => e.status === 'active');
      if (activeEMIs.length > 0) {
        console.log('\n🔄 Active EMIs:');
        activeEMIs.forEach((emi: any, i: number) => {
          console.log(`\n${i + 1}. ${emi.merchant_clean} (${emi.card_bank})`);
          console.log(`   Progress: ${emi.completion_percentage}%`);
          console.log(`   Monthly: ₹${emi.monthly_emi.toLocaleString('en-IN')}`);
          console.log(`   Remaining: ₹${emi.cost_analysis.remaining_cost.toLocaleString('en-IN')}`);
          console.log(`   Priority: ${emi.priority_score}/100`);
        });
      }

      const completedEMIs = data.emiPlans.filter((e: any) => e.status === 'completed');
      if (completedEMIs.length > 0) {
        console.log('\n\n✅ Completed EMIs:');
        completedEMIs.forEach((emi: any) => {
          console.log(`   - ${emi.merchant_clean}: ₹${emi.total_amount.toLocaleString('en-IN')}`);
        });
      }

      console.log('\n' + '━'.repeat(60));

    } catch (error: any) {
      if (error.response) {
        console.error('\n❌ Sync failed:', error.response.data);
        console.error('Status:', error.response.status);
        console.error('Headers:', error.response.headers);
      } else if (error.request) {
        console.error('\n❌ No response from server');
        console.error('Request:', error.request);
      } else {
        console.error('\n❌ Error:', error.message);
      }
      throw error;
    }

  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.error('\n❌ File not found:', enrichedPath);
      console.error('\n💡 Run this first: npm run enrich:cc:emis');
    } else {
      console.error('\n❌ Error:', error.message);
    }
    throw error;
  }
}

// Run
syncEMIs().catch(console.error);
