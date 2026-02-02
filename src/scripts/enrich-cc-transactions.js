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
  {cat: 'Food & Dining', kws: ['SWIGGY','ZOMATO','RESTAURANT','CAF','CAFE','DOMINOS','PIZZA','BURGER','HOTEL','RESTAURANT','FOOD']},
  {cat: 'Groceries', kws: ['GROCERY','BIGBASKET','SPAR','DMART','RELIANCE FRESH','MORE']},
  {cat: 'Shopping', kws: ['AMAZON','FLIPKART','MALL','CLOTHING','APPAREL','STORE','SHOP','MARKET','CART']},
  {cat: 'Transport', kws: ['UBER','OLA','TRAVEL','TAXI','INRIGO','RAIL','AIR','AIRLINES','INDIGO','SPICEJET','GOAIR','FLIGHT']},
  {cat: 'Entertainment', kws: ['BOOKMYSHOW','NETFLIX','SPOTIFY','MOVIE','EVENT','STREAMING']},
  {cat: 'Bills & Utilities', kws: ['ELECTRICITY','BILL','PAYMENT','AIRTEL','JIO','BSNL','INTERNET','RECHARGE']},
  {cat: 'Health', kws: ['PHARMA','HOSPITAL','CLINIC','MEDICINE','HEALTH']},
  {cat: 'Travel', kws: ['HOTEL','AIRLINE','BOOKING.COM','MAKEMYTRIP','CLEARTRIP','AGODA']},
  {cat: 'Finance', kws: ['EMI','LOAN','INSURANCE','BANK']},
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
  // fallback heuristics
  if (/\d{4}\s*INR/.test(m) || /ATM/.test(m)) return {category: 'Finance', confidence: 'Medium'};
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
      filename: stmt.filename || null,
      cardLast4: stmt.cardLast4 || null,
      bank: stmt.bank || null,
      statementPeriod: stmt.statementPeriod || null
    };
    const enrichedTx = (stmt.transactions || []).map((t, idx) => {
      const merchant = normalizeMerchant(t.rawText || t.description || '');
      const {category, confidence} = detectCategory(merchant);
      const transaction_type = (t.type && t.type.toLowerCase() === 'credit') ? 'credit' : 'expense';
      const id = `${baseMeta.cardLast4||'NA'}-${idx}-${(new Date(t.date || Date.now())).toISOString().slice(0,10)}`;
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
        payment_method: baseMeta.cardLast4 ? (`Card *${baseMeta.cardLast4}`) : null,
        source: 'web_scrape',
        source_data: Object.assign({}, t, {filename: stmt.filename})
      };
    });
    results.push({metadata: baseMeta, transactions: enrichedTx});
  }
  return results;
}

function summarize(all) {
  const summary = {total_transactions:0, net_spending:0, by_category:{}};
  for (const block of all) {
    for (const t of block.transactions) {
      summary.total_transactions += 1;
      if (t.transaction_type === 'expense') summary.net_spending += Number(t.amount || 0);
      summary.by_category[t.category] = (summary.by_category[t.category] || 0) + Number(t.amount || 0);
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
  console.log('Spending by category:', summary.by_category);
}

main();
