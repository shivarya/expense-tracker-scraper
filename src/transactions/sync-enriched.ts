/**
 * Sync enriched transactions to server
 * This reads the AI-analyzed data and syncs to production
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeDatePart(value: string | undefined): string {
  if (!value) {
    return 'unknown-date';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 10);
  }

  return parsed.toISOString().slice(0, 10);
}

function normalizeAmountPart(amount: number): string {
  return Number(amount).toFixed(2);
}

function buildStableReference(
  cardLast4: string,
  txn: {
    date: string;
    amount: number;
    transaction_type: string;
    merchant?: string;
    description?: string;
    source_data?: any;
  }
): string {
  const datePart = normalizeDatePart(txn.date);
  const amountPart = normalizeAmountPart(txn.amount);
  const typePart = (txn.transaction_type || 'txn').toLowerCase();
  const merchantPart = (txn.merchant || '').trim();
  const descriptionPart = (txn.description || '').trim();

  const externalRefRaw = String(
    txn.source_data?.reference_number
      ?? txn.source_data?.rrn
      ?? txn.source_data?.txn_ref
      ?? ''
  );
  const externalRef = externalRefRaw.replace(/[^a-zA-Z0-9]/g, '').slice(-12);

  if (externalRef) {
    return `CC_${cardLast4}_${datePart}_${amountPart}_${typePart}_${externalRef}`;
  }

  const fingerprint = createHash('sha1')
    .update(`${datePart}|${amountPart}|${typePart}|${merchantPart}|${descriptionPart}`)
    .digest('hex')
    .slice(0, 10);

  return `CC_${cardLast4}_${datePart}_${amountPart}_${typePart}_${fingerprint}`;
}

interface DuplicatePreviewResultItem {
  index: number;
  is_duplicate: boolean;
  duplicate_confidence?: number;
}

async function filterLikelyDuplicatesFromServer(
  apiUrl: string,
  apiToken: string,
  transactions: Array<Record<string, any>>
): Promise<{ filtered: Array<Record<string, any>>; skippedAsDuplicates: number }> {
  if (transactions.length === 0) {
    return { filtered: transactions, skippedAsDuplicates: 0 };
  }

  try {
    const previewResponse = await axios.post(
      `${apiUrl}/api/duplicates/preview`,
      {
        type: 'transactions',
        items: transactions,
      },
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const results = previewResponse.data?.data?.results as DuplicatePreviewResultItem[] | undefined;
    if (!Array.isArray(results)) {
      return { filtered: transactions, skippedAsDuplicates: 0 };
    }

    const skipIndexes = new Set<number>();
    for (const row of results) {
      const confidence = Number(row.duplicate_confidence ?? 0);
      if (row.is_duplicate && confidence >= 45) {
        skipIndexes.add(Number(row.index));
      }
    }

    if (skipIndexes.size === 0) {
      return { filtered: transactions, skippedAsDuplicates: 0 };
    }

    const filtered = transactions.filter((_, idx) => !skipIndexes.has(idx));
    return { filtered, skippedAsDuplicates: skipIndexes.size };
  } catch (error: any) {
    console.warn('⚠️  Duplicate preview failed, continuing with full payload:', error?.message || error);
    return { filtered: transactions, skippedAsDuplicates: 0 };
  }
}

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
    category_id?: number;
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
    category_id?: number;
    reference_number: string;
    source?: string;
    payment_method?: string;
    source_data?: any;
  }

  const typedData = data as EnrichedData;

  const transactionsForSync: TransactionForSync[] = typedData.transactions.map((txn: EnrichedTransaction) => {
    const mergedSourceData = {
      ...(txn.source_data || {}),
      sync_origin: 'credit_card_scraper_ai',
      card_last4: typedData.metadata.card_last4,
      statement_period: typedData.metadata.statement_period,
      original_merchant: txn.merchant || null,
    };

    return {
      bank: typedData.metadata.bank,
      account_number: typedData.metadata.card_last4,
      transaction_type: txn.transaction_type,
      amount: txn.amount,
      merchant: txn.merchant,
      description: txn.description,
      date: txn.date,
      category: txn.category,
      category_id: txn.category_id,
      reference_number: buildStableReference(typedData.metadata.card_last4, {
        date: txn.date,
        amount: txn.amount,
        transaction_type: txn.transaction_type,
        merchant: txn.merchant,
        description: txn.description,
        source_data: txn.source_data,
      }),
      source: txn.source,
      payment_method: txn.payment_method,
      source_data: mergedSourceData
    };
  });

  const dedupeResult = await filterLikelyDuplicatesFromServer(apiUrl, apiToken, transactionsForSync);
  const transactionsToSync = dedupeResult.filtered;

  if (dedupeResult.skippedAsDuplicates > 0) {
    console.log(`🛡️  Filtered ${dedupeResult.skippedAsDuplicates} likely duplicates via server preview before sync`);
  }

  console.log(`📦 Final payload size: ${transactionsToSync.length}`);

  if (transactionsToSync.length === 0) {
    console.log('✅ Nothing to sync after duplicate filtering.');
    return;
  }

  console.log('📤 Syncing to server...\n');

  try {
    const response = await axios.post(
      `${apiUrl}/sync/transactions`,
      {
        source: 'credit_card_scraper_ai',
        transactions: transactionsToSync
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
    console.log(`   Duplicates Skipped: ${response.data.data?.skipped_duplicates || response.data.data?.skipped || 0}`);
    console.log(`   Possible Duplicates Flagged: ${response.data.data?.flagged_possible_duplicates || 0}`);
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
