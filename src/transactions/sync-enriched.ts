/**
 * Sync enriched transactions to server
 * This reads the AI-analyzed data and syncs to production
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function syncEnrichedTransactions() {
  console.log('🚀 Syncing AI-Enriched Transactions to Server\n');
  console.log('━'.repeat(60));

  // Read enriched data
  const enrichedPath = path.join(__dirname, '../../data/raw-extracts/enriched-transactions.json');
  const content = await fs.readFile(enrichedPath, 'utf-8');
  const data = JSON.parse(content);

  console.log(`\n📊 Loaded ${data.transactions.length} enriched transactions`);
  console.log(`💳 Card: ${data.metadata.bank} ${data.metadata.card_type} ending ${data.metadata.card_last4}`);
  console.log(`📅 Statement Period: ${data.metadata.statement_period}\n`);

  // Prepare for sync
  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_TOKEN;

  if (!apiUrl || !apiToken) {
    throw new Error('Missing API_URL or API_TOKEN in .env');
  }

  // Convert to server format
  interface EnrichedMetadata {
    bank: string;
    card_type: string;
    card_last4: string;
    statement_period: string;
    [key: string]: any;
  }

  interface EnrichedTransaction {
    transaction_type: string;
    amount: number;
    merchant?: string;
    description?: string;
    date: string;
    category?: string;
    source?: string;
    payment_method?: string;
    source_data?: any;
    [key: string]: any;
  }

  interface EnrichedData {
    metadata: EnrichedMetadata;
    transactions: EnrichedTransaction[];
    [key: string]: any;
  }

  interface TransactionForSync {
    bank: string;
    account_number: string;
    transaction_type: string;
    amount: number;
    merchant?: string;
    description?: string;
    date: string;
    category?: string;
    reference_number: string;
    source?: string;
    payment_method?: string;
    source_data?: any;
  }

  const typedData = data as EnrichedData;

  const transactionsForSync: TransactionForSync[] = typedData.transactions.map((txn: EnrichedTransaction) => ({
    bank: typedData.metadata.bank,
    account_number: typedData.metadata.card_last4,
    transaction_type: txn.transaction_type,
    amount: txn.amount,
    merchant: txn.merchant,
    description: txn.description,
    date: txn.date,
    category: txn.category,
    reference_number: `CC_${typedData.metadata.card_last4}_${txn.date}_${txn.amount}`,
    source: txn.source,
    payment_method: txn.payment_method,
    source_data: txn.source_data
  }));

  console.log('📤 Syncing to server...\n');

  try {
    const response = await axios.post(
      `${apiUrl}/sync/transactions`,
      {
        source: 'credit_card_scraper_ai',
        transactions: transactionsForSync
      },
      {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('\n✅ Sync successful!');
    console.log(`   Created: ${response.data.data?.created || 0}`);
    console.log(`   Duplicates Skipped: ${response.data.data?.duplicates || 0}`);
    console.log(`   Failed: ${response.data.data?.failed || 0}`);

    if (response.data.data?.errors && response.data.data.errors.length > 0) {
      console.log('\n⚠️  Errors:');
      response.data.data.errors.forEach((err: string) => console.log(`   - ${err}`));
    }

  } catch (error: any) {
    console.error('\n❌ Sync failed:', error.response?.data || error.message);
    throw error;
  }
}

// Run
syncEnrichedTransactions().catch(console.error);
