import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

// Initialize OpenAI client (supports both OpenAI and Azure OpenAI)
const openai = new OpenAI(
  process.env.AZURE_OPENAI_ENDPOINT
    ? {
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseURL: process.env.AZURE_OPENAI_ENDPOINT,
      }
    : {
        apiKey: process.env.OPENAI_API_KEY
      }
);

interface ParsedTransaction {
  bank: string;
  account_number: string;
  transaction_type: 'debit' | 'credit';
  amount: number;
  merchant?: string;
  category?: string;
  date: string;
  reference_number?: string;
}

interface SyncState {
  lastSyncTimestamp: string;
  processedMessageIds: string[];
}

const SYNC_STATE_FILE = './data/sync-state.json';

async function loadSyncState(): Promise<SyncState> {
  try {
    const data = await fs.readFile(SYNC_STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return { lastSyncTimestamp: '2026-01-01T00:00:00Z', processedMessageIds: [] };
  }
}

async function saveSyncState(state: SyncState): Promise<void> {
  await fs.mkdir(path.dirname(SYNC_STATE_FILE), { recursive: true });
  await fs.writeFile(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

export async function parseSMS(): Promise<any[]> {
  const transactions: any[] = [];

  try {
    // Load sync state to avoid re-processing
    const syncState = await loadSyncState();
    const lastSync = new Date(syncState.lastSyncTimestamp);
    console.log(`  → Last sync: ${lastSync.toISOString()}`);

    // Load SMS from file or ADB
    const smsSource = process.env.SMS_SOURCE || 'file';
    let smsMessages: any[] = [];

    if (smsSource === 'file') {
      const filePath = process.env.SMS_FILE_PATH || './data/sms-export.json';
      console.log(`  → Reading SMS from ${filePath}...`);
      const data = await fs.readFile(filePath, 'utf-8');
      smsMessages = JSON.parse(data);
    } else {
      // TODO: Read from Android via ADB
      console.log('  → ADB SMS reading not yet implemented');
      return transactions;
    }

    // Filter bank SMS and exclude already processed
    const bankSMS = smsMessages.filter((msg: any) => {
      const sender = msg.address?.toLowerCase() || '';
      const isBank = sender.includes('hdfc') || 
                     sender.includes('sbi') || 
                     sender.includes('icici') ||
                     sender.includes('idfc') ||
                     sender.includes('rbl');
      
      if (!isBank) return false;

      // Only process new messages (after last sync)
      const msgDate = new Date(msg.date);
      if (msgDate <= lastSync) return false;

      // Skip if already processed (by message ID)
      const msgId = `${msg.address}-${msg.date}-${msg.body.substring(0, 50)}`;
      if (syncState.processedMessageIds.includes(msgId)) return false;

      return true;
    });

    console.log(`  → Found ${bankSMS.length} NEW bank SMS messages`);

    if (bankSMS.length === 0) {
      console.log('  ✓ No new messages to process');
      return transactions;
    }

    // Parse using AI (batch processing)
    const batchSize = 10;
    const newProcessedIds: string[] = [];

    for (let i = 0; i < bankSMS.length; i += batchSize) {
      const batch = bankSMS.slice(i, i + batchSize);
      console.log(`  → Parsing batch ${i / batchSize + 1}/${Math.ceil(bankSMS.length / batchSize)}...`);

      const prompt = `Extract transaction details from these bank SMS messages. Return JSON object with 'transactions' array containing: bank, account_number, transaction_type (debit/credit), amount, merchant, category, date, reference_number.

SMS Messages:
${batch.map((msg: any, idx: number) => `${idx + 1}. From: ${msg.address}, Body: ${msg.body}`).join('\n')}

Return ONLY valid JSON object with transactions array, no markdown.`;

      try {
        const model = process.env.AZURE_OPENAI_ENDPOINT 
          ? process.env.AZURE_OPENAI_DEPLOYMENT! // Azure uses deployment name
          : (process.env.OPENAI_MODEL || 'gpt-4-turbo'); // OpenAI uses model name
        
        const response = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: 'You are a banking SMS parser. Extract transaction data accurately. Return JSON with transactions array.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        });

        const parsed = JSON.parse(response.choices[0].message.content || '{}');
        if (Array.isArray(parsed.transactions)) {
          // Track message IDs for this batch
          batch.forEach((msg: any) => {
            const msgId = `${msg.address}-${msg.date}-${msg.body.substring(0, 50)}`;
            newProcessedIds.push(msgId);
          });

          transactions.push(...parsed.transactions.map((t: ParsedTransaction) => ({
            ...t,
            source: 'sms',
            source_data: { /* original SMS */ }
          })));
        }
      } catch (error: any) {
        console.error(`    ✗ Parse error: ${error.message}`);
      }
    }

    console.log(`  ✓ Parsed ${transactions.length} transactions`);

    // Update sync state with new processed messages
    if (newProcessedIds.length > 0) {
      syncState.processedMessageIds.push(...newProcessedIds);
      syncState.lastSyncTimestamp = new Date().toISOString();
      
      // Keep only last 1000 message IDs to prevent file bloat
      if (syncState.processedMessageIds.length > 1000) {
        syncState.processedMessageIds = syncState.processedMessageIds.slice(-1000);
      }
      
      await saveSyncState(syncState);
      console.log(`  ✓ Sync state updated (${newProcessedIds.length} new messages tracked)`);
    }

  } catch (error: any) {
    console.error('  ✗ SMS parsing error:', error.message);
  }

  return transactions;
}
