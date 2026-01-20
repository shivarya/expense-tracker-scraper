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

  try {
    // Sync stocks
    if (data.stocks.length > 0) {
      console.log(`  → Syncing ${data.stocks.length} stocks...`);
      const response = await axios.post(`${API_URL}/sync/stocks`, {
        stocks: data.stocks
      });
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
      });
      if (response.data.success) {
        results.mutualFunds = response.data.data;
        console.log(`    ✓ Created: ${results.mutualFunds.created}, Updated: ${results.mutualFunds.updated}`);
      }
    }

    // Sync transactions
    if (data.transactions.length > 0) {
      console.log(`  → Syncing ${data.transactions.length} transactions...`);
      const response = await axios.post(`${API_URL}/sync/transactions`, {
        transactions: data.transactions
      });
      if (response.data.success) {
        results.transactions = response.data.data;
        console.log(`    ✓ Created: ${results.transactions.created}, Updated: ${results.transactions.updated}`);
      }
    }

    return results;
  } catch (error: any) {
    console.error('  ✗ Sync error:', error.message);
    throw error;
  }
}
