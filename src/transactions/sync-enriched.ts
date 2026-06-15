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
    // Per-transaction card identity (stamped by enrich-and-categorize). Authoritative
    // for account resolution — never fall back to the batch's primary card silently.
    bank?: string;
    card_last4?: string;
    card_type?: string;
    statement_period?: string;
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

  // Resolve each transaction's OWN card identity. Historically every row was forced
  // onto metadata.card_last4 (the first card in a multi-card batch), which attributed
  // one card's statement lines to another card's account. Prefer the per-transaction
  // identity stamped during enrichment, then source_data, and only then metadata.
  const resolveCardIdentity = (txn: EnrichedTransaction): { bank: string; cardLast4: string; ownIdentity: boolean } => {
    const ownCardLast4 = txn.card_last4 ?? txn.source_data?.card_last4;
    const ownBank = txn.bank ?? txn.source_data?.bank;
    return {
      bank: String(ownBank ?? typedData.metadata.bank ?? '').trim(),
      cardLast4: String(ownCardLast4 ?? typedData.metadata.card_last4 ?? '').trim(),
      ownIdentity: ownCardLast4 != null && String(ownCardLast4).trim() !== '',
    };
  };

  const identities = typedData.transactions.map(resolveCardIdentity);

  // Regression guard: refuse to sync if any row lacks a concrete card identity.
  // Silently defaulting to the batch's primary card is exactly what caused the
  // cross-card duplication bug, so fail loudly rather than mis-attribute.
  const unresolved = identities.filter(id => !id.cardLast4 || id.cardLast4.toUpperCase() === 'XXXX').length;
  if (unresolved > 0) {
    throw new Error(
      `Refusing to sync: ${unresolved}/${identities.length} transaction(s) have no resolvable card_last4. ` +
      `Re-run "npm run enrich:cc" so each transaction carries its own bank/card_last4.`
    );
  }

  // A multi-card batch must carry per-transaction identity. If the file lists more
  // than one card but the rows fall back to the single batch metadata, we cannot tell
  // which card each row belongs to — refuse rather than collapse them onto one card.
  const knownCards = Array.isArray(typedData.metadata.cards) ? typedData.metadata.cards : [];
  const distinctKnownCards = new Set(knownCards.map((c: any) => `${c?.bank}__${c?.card_last4}`));
  if (distinctKnownCards.size > 1 && identities.some(id => !id.ownIdentity)) {
    throw new Error(
      `Refusing to sync: this batch spans ${distinctKnownCards.size} cards but some transactions lack their own ` +
      `card identity, so they would be mis-attributed to the primary card. Re-run "npm run enrich:cc".`
    );
  }

  const distinctCards = new Set(identities.map(id => `${id.bank} *${id.cardLast4}`));
  if (distinctCards.size > 1) {
    console.log(`💳 Batch spans ${distinctCards.size} cards: ${[...distinctCards].join(', ')}`);
    console.log('   → each transaction will be synced under its own card account.\n');
  }

  const transactionsForSync: TransactionForSync[] = typedData.transactions.map((txn: EnrichedTransaction, idx: number) => {
    const { bank, cardLast4 } = identities[idx];
    const mergedSourceData = {
      ...(txn.source_data || {}),
      sync_origin: 'credit_card_scraper_ai',
      bank,
      card_last4: cardLast4,
      statement_period: txn.source_data?.statement_period ?? txn.statement_period ?? typedData.metadata.statement_period,
      original_merchant: txn.merchant || null,
    };

    return {
      bank,
      account_number: cardLast4,
      transaction_type: txn.transaction_type,
      amount: txn.amount,
      merchant: txn.merchant,
      description: txn.description,
      date: txn.date,
      category: txn.category,
      category_id: txn.category_id,
      reference_number: buildStableReference(cardLast4, {
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
