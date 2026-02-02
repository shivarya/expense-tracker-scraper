/**
 * Zerodha Stock Scraper
 * 
 * Scrapes stock portfolio from Zerodha Kite using Playwright.
 * Requires manual 2FA/PIN entry.
 * Outputs data to: data/stocks/zerodha.json
 */

import { chromium, Browser, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

export interface ZerodhaStock {
  symbol: string;
  company_name: string;
  quantity: number;
  average_price: number;
  current_price: number;
  invested_amount: number;
  current_value: number;
  platform: 'zerodha';
}

interface ScraperResult {
  success: boolean;
  data: ZerodhaStock[];
  error?: string;
  scraped_at: string;
}

/**
 * Basic schema validation
 */
function validateStock(stock: any): stock is ZerodhaStock {
  return (
    typeof stock.symbol === 'string' &&
    typeof stock.quantity === 'number' &&
    typeof stock.average_price === 'number' &&
    typeof stock.current_price === 'number'
  );
}

/**
 * Scrape Zerodha holdings
 */
export async function fetchZerodhaStocks(): Promise<ScraperResult> {
  const result: ScraperResult = {
    success: false,
    data: [],
    scraped_at: new Date().toISOString()
  };
  
  let browser: Browser | null = null;
  
  try {
    console.log('🔍 Zerodha Stock Scraper');
    console.log('  → Launching browser...');
    
    browser = await chromium.launch({ 
      headless: false,
      timeout: 60000 
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Check for credentials
    if (!process.env.ZERODHA_USER_ID || !process.env.ZERODHA_PASSWORD) {
      throw new Error('Missing ZERODHA_USER_ID or ZERODHA_PASSWORD in .env');
    }
    
    console.log('  → Navigating to Zerodha Kite...');
    await page.goto('https://kite.zerodha.com/', { waitUntil: 'networkidle' });
    
    // Login
    console.log('  → Logging in...');
    await page.fill('input[type="text"][placeholder*="ID"]', process.env.ZERODHA_USER_ID);
    await page.fill('input[type="password"][placeholder*="Password"]', process.env.ZERODHA_PASSWORD);
    await page.click('button[type="submit"]');
    
    // Wait for 2FA/PIN
    console.log('  ⏳ Please enter PIN/2FA in browser (waiting up to 2 minutes)...');
    
    try {
      await page.waitForURL('**/dashboard', { timeout: 120000 });
      console.log('  ✓ Login successful');
    } catch {
      throw new Error('Login timeout - PIN/2FA not completed within 2 minutes');
    }
    
    // Navigate to holdings
    console.log('  → Navigating to holdings...');
    await page.goto('https://kite.zerodha.com/holdings', { waitUntil: 'networkidle' });
    
    // Wait for holdings table
    await page.waitForSelector('.holdings-table, [data-holdings], table.instruments', { timeout: 30000 });
    
    // Extract holdings data
    console.log('  → Extracting stock data...');
    
    const holdings = await page.evaluate(() => {
      const stocks: ZerodhaStock[] = [];
      
      // Try multiple possible selectors
      const rows = document.querySelectorAll(
        '.holdings-table tbody tr, [data-holdings] tr, table.instruments tbody tr'
      );
      
      rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) return;
        
        const symbol = cells[0]?.textContent?.trim() || '';
        const companyName = cells[1]?.textContent?.trim() || symbol;
        const quantity = parseFloat(cells[2]?.textContent?.replace(/,/g, '') || '0');
        const avgPrice = parseFloat(cells[3]?.textContent?.replace(/,|₹/g, '') || '0');
        const currentPrice = parseFloat(cells[4]?.textContent?.replace(/,|₹/g, '') || '0');
        
        if (symbol && quantity > 0) {
          stocks.push({
            symbol,
            company_name: companyName,
            quantity,
            average_price: avgPrice,
            current_price: currentPrice || avgPrice,
            invested_amount: quantity * avgPrice,
            current_value: quantity * (currentPrice || avgPrice),
            platform: 'zerodha'
          });
        }
      });
      
      return stocks;
    });
    
    // Validate
    const validStocks = holdings.filter(validateStock);
    
    if (validStocks.length === 0) {
      console.log('  ⚠️  No stocks found (holdings may be empty or selectors need update)');
    } else {
      console.log(`  ✓ Found ${validStocks.length} stocks`);
    }
    
    result.success = true;
    result.data = validStocks;
    
    // Save to file
    const outputPath = path.join(process.cwd(), 'data', 'stocks', 'zerodha.json');
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`  ✓ Saved to ${outputPath}`);
    
  } catch (error: any) {
    console.error('  ✗ Scraping failed:', error.message);
    result.error = error.message;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  return result;
}

// CLI command handler
if (process.argv[1].includes('zerodha.ts') || process.argv[2] === 'zerodha') {
  fetchZerodhaStocks()
    .then((result) => {
      if (result.success) {
        console.log(`\n✓ Scraping complete: ${result.data.length} stocks`);
        process.exit(0);
      } else {
        console.error(`\n✗ Scraping failed: ${result.error}`);
        process.exit(1);
      }
    });
}
