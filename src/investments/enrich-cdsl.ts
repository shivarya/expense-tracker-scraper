/**
 * Enrich CDSL holdings with metadata and categorization
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE = path.join(__dirname, '../../data/cdsl-holdings.json');
const OUTPUT_FILE = path.join(__dirname, '../../data/enriched-cdsl.json');

interface EnrichedStock {
  isin: string;
  symbol: string;
  company_name: string;
  quantity: number;
  avg_price: number; // estimated from current value
  current_price: number;
  invested_amount: number;
  current_value: number;
  gain_loss_amount: number;
  gain_loss_percent: number;
  platform: string;
  sector?: string;
  market_cap?: string;
  statement_date: string;
  enriched_at: string;
}

interface EnrichedMutualFund {
  folio: string;
  fund_name: string;
  amc: string;
  units: number;
  nav: number;
  amount: number;
  plan_type: 'Direct' | 'Regular' | 'Unknown';
  option_type: 'Growth' | 'Dividend' | 'IDCW' | 'Unknown';
  category?: string;
  statement_date: string;
  enriched_at: string;
}

export async function enrichCDSLHoldings() {
  console.log('🚀 Enriching CDSL Holdings\n');
  console.log('━'.repeat(60));

  // Read raw holdings
  let rawData: any;
  try {
    const content = await fs.readFile(INPUT_FILE, 'utf-8');
    rawData = JSON.parse(content);
  } catch (error) {
    console.error('\n❌ No CDSL holdings found.');
    console.error('   Run: npm run extract:cdsl first');
    process.exit(1);
  }

  console.log(`\n📊 Input Summary:`);
  console.log(`   Stocks: ${rawData.totalStocks}`);
  console.log(`   Mutual Funds: ${rawData.totalMutualFunds}`);

  // Enrich stocks
  const enrichedStocks: EnrichedStock[] = [];
  
  console.log(`\n🔍 Enriching ${rawData.stocks.length} stocks...`);
  for (const stock of rawData.stocks) {
    const avgPrice = stock.quantity > 0 ? stock.value / stock.quantity : stock.price;
    const gainLoss = stock.value - (avgPrice * stock.quantity);
    const gainLossPercent = avgPrice > 0 ? ((stock.price - avgPrice) / avgPrice) * 100 : 0;

    enrichedStocks.push({
      isin: stock.isin,
      symbol: stock.symbol || extractSymbolFromISIN(stock.isin),
      company_name: stock.company_name,
      quantity: stock.quantity,
      avg_price: parseFloat(avgPrice.toFixed(2)),
      current_price: stock.price,
      invested_amount: parseFloat((avgPrice * stock.quantity).toFixed(2)),
      current_value: stock.value,
      gain_loss_amount: parseFloat(gainLoss.toFixed(2)),
      gain_loss_percent: parseFloat(gainLossPercent.toFixed(2)),
      platform: 'CDSL',
      sector: categorizeSector(stock.company_name),
      market_cap: categorizeMarketCap(stock.value),
      statement_date: stock.statement_date,
      enriched_at: new Date().toISOString()
    });

    console.log(`   ✅ ${stock.symbol}: ${stock.quantity} shares @ ₹${stock.price} = ₹${stock.value.toLocaleString('en-IN')}`);
  }

  // Enrich mutual funds
  const enrichedMF: EnrichedMutualFund[] = [];
  
  console.log(`\n🔍 Enriching ${rawData.mutualFunds.length} mutual funds...`);
  for (const mf of rawData.mutualFunds) {
    enrichedMF.push({
      folio: mf.folio,
      fund_name: mf.fund_name,
      amc: mf.amc,
      units: mf.units,
      nav: mf.nav,
      amount: mf.amount,
      plan_type: extractPlanType(mf.fund_name),
      option_type: extractOptionType(mf.fund_name),
      category: categorizeFund(mf.fund_name),
      statement_date: mf.statement_date,
      enriched_at: new Date().toISOString()
    });

    console.log(`   ✅ ${mf.amc}: ${mf.units.toFixed(3)} units @ ₹${mf.nav} = ₹${mf.amount.toLocaleString('en-IN')}`);
  }

  // Calculate summary
  const totalStockValue = enrichedStocks.reduce((sum, s) => sum + s.current_value, 0);
  const totalStockInvested = enrichedStocks.reduce((sum, s) => sum + s.invested_amount, 0);
  const totalMFValue = enrichedMF.reduce((sum, mf) => sum + mf.amount, 0);

  const stockGainLoss = totalStockValue - totalStockInvested;
  const stockGainLossPercent = totalStockInvested > 0 
    ? ((stockGainLoss / totalStockInvested) * 100)
    : 0;

  console.log(`\n\n📊 Enrichment Summary:`);
  console.log(`\n   STOCKS:`);
  console.log(`   Total Holdings: ${enrichedStocks.length}`);
  console.log(`   Invested Amount: ₹${totalStockInvested.toLocaleString('en-IN')}`);
  console.log(`   Current Value: ₹${totalStockValue.toLocaleString('en-IN')}`);
  console.log(`   Gain/Loss: ₹${stockGainLoss.toLocaleString('en-IN')} (${stockGainLossPercent.toFixed(2)}%)`);

  console.log(`\n   MUTUAL FUNDS:`);
  console.log(`   Total Holdings: ${enrichedMF.length}`);
  console.log(`   Current Value: ₹${totalMFValue.toLocaleString('en-IN')}`);

  console.log(`\n   TOTAL PORTFOLIO: ₹${(totalStockValue + totalMFValue).toLocaleString('en-IN')}`);

  // Save output
  const output = {
    enrichedAt: new Date().toISOString(),
    source: 'CDSL eCAS',
    summary: {
      stocks: {
        count: enrichedStocks.length,
        investedAmount: totalStockInvested,
        currentValue: totalStockValue,
        gainLossAmount: stockGainLoss,
        gainLossPercent: parseFloat(stockGainLossPercent.toFixed(2))
      },
      mutualFunds: {
        count: enrichedMF.length,
        currentValue: totalMFValue
      },
      totalPortfolioValue: totalStockValue + totalMFValue
    },
    stocks: enrichedStocks,
    mutualFunds: enrichedMF
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
  console.log('\n' + '━'.repeat(60));

  return output;
}

function extractSymbolFromISIN(isin: string): string {
  // ISIN format: INE[company code][check digit]
  // Extract a reasonable symbol approximation
  return isin?.substring(0, 10) || 'UNKNOWN';
}

function categorizeSector(companyName: string): string {
  const sectors: Record<string, RegExp[]> = {
    'Banking': [/bank/i, /hdfc/i, /icici/i, /sbi/i, /axis/i, /kotak/i],
    'IT': [/infosys/i, /tcs/i, /tech/i, /wipro/i, /software/i],
    'Pharma': [/pharma/i, /healthcare/i, /cipla/i, /sun pharma/i, /dr reddy/i],
    'Auto': [/motor/i, /auto/i, /tata motors/i, /maruti/i, /bajaj/i],
    'FMCG': [/hindustan/i, /itc/i, /britannia/i, /nestle/i],
    'Energy': [/power/i, /energy/i, /reliance/i, /ongc/i, /ntpc/i],
    'Telecom': [/bharti/i, /airtel/i, /jio/i, /telecom/i]
  };

  for (const [sector, patterns] of Object.entries(sectors)) {
    if (patterns.some(pattern => pattern.test(companyName))) {
      return sector;
    }
  }

  return 'Other';
}

function categorizeMarketCap(value: number): string {
  // Rough estimate based on holding value
  // (This is not accurate without total shares outstanding data)
  if (value > 1000000) return 'Large Cap';
  if (value > 100000) return 'Mid Cap';
  return 'Small Cap';
}

function extractPlanType(fundName: string): 'Direct' | 'Regular' | 'Unknown' {
  if (/direct/i.test(fundName)) return 'Direct';
  if (/regular/i.test(fundName)) return 'Regular';
  return 'Unknown';
}

function extractOptionType(fundName: string): 'Growth' | 'Dividend' | 'IDCW' | 'Unknown' {
  if (/growth/i.test(fundName)) return 'Growth';
  if (/dividend/i.test(fundName)) return 'Dividend';
  if (/idcw/i.test(fundName)) return 'IDCW';
  return 'Unknown';
}

function categorizeFund(fundName: string): string {
  const categories: Record<string, RegExp[]> = {
    'Equity - Large Cap': [/large cap/i, /bluechip/i, /top 100/i],
    'Equity - Mid Cap': [/mid cap/i, /midcap/i],
    'Equity - Small Cap': [/small cap/i, /smallcap/i],
    'Equity - Multi Cap': [/multi cap/i, /multicap/i, /flexi cap/i],
    'Equity - Sectoral': [/banking/i, /pharma/i, /it/i, /infrastructure/i, /psu/i],
    'Equity - Index': [/index/i, /nifty/i, /sensex/i],
    'Debt - Liquid': [/liquid/i, /overnight/i],
    'Debt - Short Duration': [/short/i, /ultra short/i],
    'Debt - Medium Duration': [/medium/i, /dynamic bond/i],
    'Debt - Long Duration': [/long/i, /gilt/i],
    'Hybrid': [/hybrid/i, /balanced/i, /aggressive/i, /conservative/i]
  };

  for (const [category, patterns] of Object.entries(categories)) {
    if (patterns.some(pattern => pattern.test(fundName))) {
      return category;
    }
  }

  return 'Other';
}

// CLI execution
const isDirectRun = !!process.argv[1] && __filename === path.resolve(process.argv[1]);

if (isDirectRun) {
  enrichCDSLHoldings().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  });
}
