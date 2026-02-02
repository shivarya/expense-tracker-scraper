import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function cleanMerchant(raw: string) {
  if (!raw) return 'Unknown';
  let s = raw.toUpperCase();
  // Remove UPI IDs, numbers, excessive punctuation
  s = s.replace(/UPI-[0-9-]+/g, '');
  s = s.replace(/\d{5,}/g, '');
  s = s.replace(/\*/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  s = s.replace(/[^A-Z0-9 &.()-]/g, ' ');
  s = s.trim();

  // Common consolidations
  if (/SWIGGY/.test(s)) return 'Swiggy';
  if (/ZOMATO/.test(s)) return 'Zomato';
  if (/BLINKIT|GROCE RY|MILKBA?SK?ET|GROCERY/.test(s)) return 'Grocery / Delivery';
  if (/MAKEMYTRIP|CLEARTRIP|INDIGO|GOAIR|SPICEJET|AIR INDIA|BOOKMYSHOW/.test(s)) return 'Travel';
  if (/GITHUB|GIT HUB|GITHUB INC/.test(s)) return 'GitHub';
  if (/AMAZON/.test(s)) return 'Amazon';
  if (/PAYTM|PHONEPE|BHARATPE|UPI/.test(s)) return 'Payments';
  if (/MC DONALDS|MCDONALDS|MACDONALD|MC DONAL DS/.test(s)) return "McDonald's";

  // Take first 3 words as merchant
  const parts = s.split(' ');
  return parts.slice(0, 3).join(' ').trim();
}

function categorize(merchant: string, description: string) {
  const m = (merchant || '').toLowerCase();
  const d = (description || '').toLowerCase();

  if (/swiggy|zomato|dominos|pizza/.test(m) || /swiggy|zomato|dominos|pizza|restaurant|cafe/.test(d)) return { category: 'Food & Dining', purpose: 'Food', confidence: 'High' };
  if (/blinkit|grocery|milkbask|grocer|super market|supermarket/.test(m) || /grocery|supermarket|grocer/.test(d)) return { category: 'Shopping', purpose: 'Groceries', confidence: 'High' };
  if (/make mytrip|makemytrip|cleartrip|indigo|airline|flight/.test(m) || /make mytrip|flight|airline|hotel|booking/.test(d)) return { category: 'Travel', purpose: 'Travel', confidence: 'High' };
  if (/github|stripe|paypal|google|netflix|spotify/.test(m) || /subscription|annual|monthly|membership/.test(d)) return { category: 'Bills & Utilities', purpose: 'Subscription', confidence: 'Medium' };
  if (/medicine|pharma|hospital|clinic|medical|doctor/.test(d) || /medical|pharmacy|dr\b/.test(m)) return { category: 'Health', purpose: 'Medical', confidence: 'High' };
  if (/fuel|petrol|gas/.test(d)) return { category: 'Transport', purpose: 'Fuel', confidence: 'High' };

  return { category: 'Other', purpose: 'General', confidence: 'Low' };
}

async function main() {
  const srcPath = path.join(__dirname, '../../data/transactions/credit-cards.json');
  const outDir = path.join(__dirname, '../../data/raw-extracts');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'enriched-transactions.json');

  const content = await fs.readFile(srcPath, 'utf-8');
  const cards = JSON.parse(content);

  // Pick the latest card entry (last one with transactions)
  let chosen: any = null;
  for (let i = cards.length - 1; i >= 0; i--) {
    if (cards[i].transactions && cards[i].transactions.length > 0) {
      chosen = cards[i];
      break;
    }
  }

  if (!chosen) {
    console.error('No transactions found in credit-cards.json');
    process.exit(1);
  }

  const metadata = {
    statement_file: 'unknown',
    bank: chosen.bankName || 'Unknown',
    card_type: 'Credit Card',
    card_last4: chosen.cardNumber || '----',
    statement_period: `${chosen.statementMonth || ''} ${chosen.statementYear || ''}`.trim() || 'Unknown'
  };

  const transactions = chosen.transactions.map((t: any, idx: number) => {
    const merchant = cleanMerchant(t.description || t.rawText || 'Unknown');
    const cat = categorize(merchant, t.rawText || t.description || '');
    const txnType = (t.type || 'debit').toLowerCase() === 'debit' ? 'expense' : 'credit';

    return {
      id: idx + 1,
      date: t.date,
      raw_text: t.rawText || t.description,
      amount: t.amount,
      original_type: t.type || 'debit',
      transaction_type: txnType,
      merchant,
      description: (t.description || '').trim(),
      category: cat.category,
      categoryConfidence: cat.confidence,
      purpose: cat.purpose,
      payment_method: `${metadata.bank} Card *${metadata.card_last4}`,
      source: 'web_scrape',
      source_data: {
        raw_description: t.rawText || t.description,
        is_emi: false,
        is_recurring: false,
        merchant_category: cat.category.toLowerCase().replace(/\s+/g, '_')
      }
    };
  });

  const out = {
    metadata,
    transactions,
    analysis_summary: {
      total_transactions: transactions.length,
      net_spending: transactions.reduce((s: number, x: any) => s + (x.transaction_type === 'expense' ? Number(x.amount || 0) : 0), 0),
      spending_by_category: {} as Record<string, number>
    }
  };

  // build spending_by_category
  for (const tx of transactions) {
    const key = String(tx.category || 'Unknown');
    out.analysis_summary.spending_by_category[key] = (out.analysis_summary.spending_by_category[key] || 0) + Number(tx.amount || 0);
  }

  await fs.writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`✅ Enriched ${transactions.length} transactions -> ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
