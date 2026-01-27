import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:8000';

export interface SyncResult {
  stocks: any[];
  mutualFunds: any[];
  transactions: any[];
}

export async function syncToBackend(data: SyncResult) {
  const results = {
    stocks: { created: 0, updated: 0, failed: 0 },
    mutualFunds: { created: 0, updated: 0, failed: 0 },
    transactions: { created: 0, updated: 0, failed: 0 }
  };

  // Check for API token
  if (!process.env.API_TOKEN) {
    console.warn('  ⚠️  No API_TOKEN found in .env - sync requests may fail');
  }

  // Common headers with authentication
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.API_TOKEN && { 'Authorization': `Bearer ${process.env.API_TOKEN}` })
  };

  try {
    // Sync stocks
    if (data.stocks.length > 0) {
      console.log(`  → Syncing ${data.stocks.length} stocks...`);
      const response = await axios.post(`${API_URL}/sync/stocks`, {
        stocks: data.stocks
      }, { headers });
      if (response.data.success) {
        results.stocks = response.data.data;
        console.log(`    ✓ Created: ${results.stocks.created}, Updated: ${results.stocks.updated}`);
      }
    }

    // Sync mutual funds
    if (data.mutualFunds.length > 0) {
      console.log(`  → Syncing ${data.mutualFunds.length} mutual funds...`);
      const response = await axios.post(`${API_URL}/sync/mutual-funds`, {
        funds: data.mutualFunds
      }, { headers });
      if (response.data.success) {
        results.mutualFunds = response.data.data;
        console.log(`    ✓ Created: ${results.mutualFunds.created}, Updated: ${results.mutualFunds.updated}`);
      }
    }

    // Sync transactions
    if (data.transactions.length > 0) {
      console.log(`  → Syncing ${data.transactions.length} transactions...`);
      
      // Format for SMS parser endpoint
      const smsMessages = data.transactions.map(t => ({
        sender: t.source_data?.sender || `${t.bank}-BANK`,
        body: t.source_data?.body || `Transaction: ${t.merchant || 'Unknown'} - Rs.${t.amount}`,
        date: t.date || new Date().toISOString()
      }));
      
      const response = await axios.post(`${API_URL}/parse/sms`, {
        messages: smsMessages
      }, { headers });
      
      if (response.data.success) {
        results.transactions.created = response.data.data.saved_transactions || 0;
        results.transactions.updated = response.data.data.skipped_duplicates || 0;
        console.log(`    ✓ Saved: ${results.transactions.created}, Skipped: ${results.transactions.updated}`);
      }
    }

    return results;
  } catch (error: any) {
    console.error('  ✗ Sync error:', error.message);
    throw error;
  }
}
