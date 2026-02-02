const fs = require('fs');
const path = require('path');

const RAW_PATH = path.join(__dirname, '..', '..', 'data', 'raw-extracts', 'raw-transactions.json');
const OUT_PATH = path.join(__dirname, '..', '..', 'data', 'raw-extracts', 'enriched-transactions-3m.json');

function loadRaw() {
  if (!fs.existsSync(RAW_PATH)) {
    console.error('Raw transactions file not found:', RAW_PATH);
    process.exit(2);
  }
  const txt = fs.readFileSync(RAW_PATH, 'utf8');
  return JSON.parse(txt);
}

const CATEGORY_KEYWORDS = [
  {cat: 'Food & Dining', kws: ['SWIGGY','ZOMATO','RESTAURANT','CAF','CAFE','DOMINOS','PIZZA','BURGER','HOTEL','RESTAURANT','FOOD','MAIZ','MC DONALD','BOOKMYSHOW','CINEPOLIS']},
  {cat: 'Groceries', kws: ['GROCERY','BIGBASKET','SPAR','DMART','RELIANCE FRESH','MORE','HYPER MARKET','ROLLA']},
  {cat: 'Shopping', kws: ['AMAZON','FLIPKART','MALL','CLOTHING','APPAREL','STORE','WESTSIDE','LIFE STYLE','THE SOULED','METRO BRANDS']},
  {cat: 'Transport', kws: ['UBER','OLA','TRAVEL','TAXI','RAIL','AIRLINES','INDIGO','FLIGHT']},
  {cat: 'Entertainment', kws: ['BOOKMYSHOW','NETFLIX','MOVIE','CINEPOLIS','ENTERTAINMENT']},
  {cat: 'Bills & Utilities', kws: ['ELECTRICITY','BILL','AIRTEL','JIO','INTERNET','RECHARGE','BBPS']},
  {cat: 'Health', kws: ['PHARMA','HOSPITAL','CLINIC','GMR HOSPITALITY']},
  {cat: 'Travel', kws: ['HOTEL','BOOKING','MAKEMYTRIP','CLEARTRIP','DAIWIK']},
  {cat: 'Finance', kws: ['EMI','LOAN','INSURANCE','PAYMENT','CASH']},
  {cat: 'Others', kws: []}
];

function detectCategory(merchantRaw) {
  if (!merchantRaw) return {category: 'Others', confidence: 'Low'};
  const m = merchantRaw.toUpperCase();
  for (const entry of CATEGORY_KEYWORDS) {
    for (const kw of entry.kws) {
      if (m.includes(kw)) return {category: entry.cat, confidence: 'High'};
    }
  }
  if (/ATM|PAYMENT RECEIVED|BBPS/.test(m)) return {category: 'Finance', confidence: 'Medium'};
  return {category: 'Others', confidence: 'Low'};
}

function normalizeMerchant(raw) {
  if (!raw) return '';
  return raw.replace(/\s{2,}/g,' ').trim();
}

function enrich(rawJson) {
  const results = [];
  for (const stmt of rawJson) {
    const baseMeta = {
      statement_file: stmt.filename || null,
      card_last4: stmt.cardLast4 || null,
      bank: stmt.bank || null,
      statement_period: stmt.statementPeriod || null
    };
    const enrichedTx = (stmt.transactions || []).map((t, idx) => {
      const merchant = normalizeMerchant(t.rawText || t.description || '');
      const {category, confidence} = detectCategory(merchant);
      const transaction_type = (t.type && String(t.type).toLowerCase() === 'credit') ? 'credit' : 'expense';
      const id = `${baseMeta.card_last4||'NA'}-${idx}-${(new Date(t.date || Date.now())).toISOString().slice(0,10)}`;
      return {
        id,
        date: t.date,
        raw_text: t.rawText || t.description || merchant,
        amount: t.amount || t.value || 0,
        original_type: t.type || 'debit',
        transaction_type,
        merchant: merchant || null,
        description: merchant || null,
        category,
        categoryConfidence: confidence,
        payment_method: baseMeta.card_last4 ? (`Card *${baseMeta.card_last4}`) : null,
        source: 'web_scrape',
        source_data: Object.assign({}, t, {filename: stmt.filename})
      };
    });
    results.push({metadata: baseMeta, transactions: enrichedTx});
  }
  return results;
}

function summarize(all) {
  const summary = {total_transactions:0, net_spending:0, spending_by_category:{}};
  for (const block of all) {
    for (const t of block.transactions) {
      summary.total_transactions += 1;
      if (t.transaction_type === 'expense') summary.net_spending += Number(t.amount || 0);
      summary.spending_by_category[t.category] = (summary.spending_by_category[t.category] || 0) + Number(t.amount || 0);
    }
  }
  return summary;
}

function main() {
  const raw = loadRaw();
  const enriched = enrich(raw);
  fs.writeFileSync(OUT_PATH, JSON.stringify({generatedAt: new Date().toISOString(), enriched}, null, 2), 'utf8');
  const summary = summarize(enriched);
  console.log('Enrichment complete. Output:', OUT_PATH);
  console.log('Total transactions:', summary.total_transactions);
  console.log('Net spending (expenses):', summary.net_spending);
  console.log('Spending by category:', summary.spending_by_category);
}

main();
