import 'dotenv/config';
import { scrapeStocks } from './scrapers/stocks.js';
import { scrapeMutualFunds } from './scrapers/mutualFunds.js';
import { parseSMS } from './parsers/smsParser.js';
import { syncToBackend } from './sync.js';

async function main() {
  console.log('🚀 Expense Tracker Scraper Started');
  console.log('===================================\n');

  const results = {
    stocks: [],
    mutualFunds: [],
    transactions: []
  };

  try {
    // 1. Scrape stock data from Zerodha/Groww
    if (process.env.SYNC_STOCKS === 'true') {
      console.log('📊 Scraping stocks...');
      results.stocks = await scrapeStocks();
      console.log(`✅ Found ${results.stocks.length} stocks\n`);
    }

    // 2. Download mutual fund statements from Gmail
    if (process.env.SYNC_MUTUAL_FUNDS === 'true') {
      console.log('📈 Fetching mutual fund data...');
      results.mutualFunds = await scrapeMutualFunds();
      console.log(`✅ Found ${results.mutualFunds.length} mutual funds\n`);
    }

    // 3. Parse SMS for transactions
    if (process.env.SYNC_TRANSACTIONS === 'true') {
      console.log('💬 Parsing SMS transactions...');
      results.transactions = await parseSMS();
      console.log(`✅ Parsed ${results.transactions.length} transactions\n`);
    }

    // 4. Sync all data to backend
    console.log('🔄 Syncing to backend...');
    await syncToBackend(results);
    console.log('\n✅ Sync complete!');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
