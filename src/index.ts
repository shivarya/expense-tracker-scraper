import 'dotenv/config';
import { scrapeStocks } from './scrapers/stocks.js';
import { scrapeMutualFunds, authenticateGmail } from './scrapers/mutualFunds.js';
import { scrapeCreditCards } from './scrapers/creditCards.js';
import { parseSMS } from './parsers/smsParser.js';
import { syncToBackend } from './sync.js';

// Parse command-line arguments
const args = process.argv.slice(2);
const mode = args[0]?.toLowerCase(); // stocks, mf, cc, sms, all

async function main() {
  console.log('🚀 Expense Tracker Scraper Started');
  console.log('===================================\n');

  // Determine what to run based on mode
  const shouldRun = {
    stocks: mode === 'stocks' || mode === 'all' || !mode,
    mutualFunds: mode === 'mf' || mode === 'mutual-funds' || mode === 'all' || !mode,
    creditCards: mode === 'cc' || mode === 'credit-cards' || mode === 'all' || !mode,
    sms: mode === 'sms' || mode === 'all' || !mode
  };

  // Show usage if invalid mode
  if (mode && !['stocks', 'mf', 'mutual-funds', 'cc', 'credit-cards', 'sms', 'all'].includes(mode)) {
    console.log('Usage: npm run dev [mode]');
    console.log('');
    console.log('Modes:');
    console.log('  stocks, mf, cc, sms  - Run specific scraper only');
    console.log('  all (or no argument) - Run all scrapers');
    console.log('');
    console.log('Examples:');
    console.log('  npm run dev          # Run all scrapers');
    console.log('  npm run dev cc       # Credit cards only');
    console.log('  npm run dev mf       # Mutual funds only');
    console.log('  npm run dev sms      # SMS only');
    process.exit(1);
  }

  if (mode) {
    console.log(`📌 Mode: ${mode.toUpperCase()}\n`);
  }

  const results = {
    stocks: [] as any[],
    mutualFunds: [] as any[],
    transactions: [] as any[]
  };

  try {
    // 1. Scrape stock data from Zerodha/Groww
    if (shouldRun.stocks && process.env.SYNC_STOCKS === 'true') {
      console.log('📊 Scraping stocks...');
      results.stocks = await scrapeStocks();
      console.log(`✅ Found ${results.stocks.length} stocks\n`);
    }

    // 2. Download mutual fund statements from Gmail
    if (shouldRun.mutualFunds && process.env.SYNC_MUTUAL_FUNDS === 'true') {
      console.log('📈 Fetching mutual fund data...');
      results.mutualFunds = await scrapeMutualFunds();
      console.log(`✅ Found ${results.mutualFunds.length} mutual funds\n`);
    }

    // 2b. Download credit card statements from Gmail
    if (shouldRun.creditCards) {
      console.log('💳 Fetching credit card statements...');
      const gmailAuth = await authenticateGmail();
      const ccTransactions = await scrapeCreditCards(gmailAuth);
      results.transactions.push(...ccTransactions);
      console.log(`✅ Found ${ccTransactions.length} credit card transactions\n`);
    }

    // 3. Parse SMS for transactions
    if (shouldRun.sms && process.env.SYNC_TRANSACTIONS === 'true') {
      console.log('💬 Parsing SMS transactions...');
      const smsTransactions = await parseSMS();
      results.transactions.push(...smsTransactions);
      console.log(`✅ Parsed ${smsTransactions.length} SMS transactions\n`);
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
