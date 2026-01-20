import { chromium } from 'playwright';

export async function scrapeStocks() {
  console.log('  → Launching browser...');
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const stocks = [];

  try {
    // Example: Scrape from Zerodha Console
    if (process.env.ZERODHA_USER_ID && process.env.ZERODHA_PASSWORD) {
      console.log('  → Logging into Zerodha...');
      await page.goto('https://kite.zerodha.com/');
      
      // Login flow (simplified - needs actual selectors)
      await page.fill('input[type="text"]', process.env.ZERODHA_USER_ID);
      await page.fill('input[type="password"]', process.env.ZERODHA_PASSWORD);
      await page.click('button[type="submit"]');
      
      // Wait for 2FA/PIN
      console.log('  ⏳ Waiting for 2FA/PIN...');
      await page.waitForTimeout(30000); // Manual 2FA entry
      
      // Navigate to holdings
      await page.goto('https://kite.zerodha.com/holdings');
      await page.waitForSelector('[data-holdings]');
      
      // Extract stock data
      const holdings = await page.$$eval('[data-holdings] tr', (rows) => {
        return rows.map((row) => {
          const cells = row.querySelectorAll('td');
          return {
            symbol: cells[0]?.textContent?.trim(),
            quantity: parseFloat(cells[1]?.textContent?.trim() || '0'),
            avg_price: parseFloat(cells[2]?.textContent?.trim() || '0'),
            current_price: parseFloat(cells[3]?.textContent?.trim() || '0'),
            platform: 'zerodha'
          };
        });
      });
      
      stocks.push(...holdings);
      console.log(`  ✓ Scraped ${holdings.length} stocks from Zerodha`);
    }

    // Example: Groww scraper would go here
    // Similar flow for Groww platform

  } catch (error: any) {
    console.error('  ✗ Scraping error:', error.message);
  } finally {
    await browser.close();
  }

  return stocks;
}
