const fs = require('fs');

const data = JSON.parse(fs.readFileSync('./data/raw-extracts/enriched-transactions.json', 'utf8'));
const txns = data.transactions;

// Group by (date, merchant, amount) to find local duplicates
const grouped = {};

txns.forEach((txn, idx) => {
  const merchant = (txn.merchant || '').toLowerCase().trim();
  const key = `${txn.date}|${merchant}|${txn.amount}`;
  
  if (!grouped[key]) {
    grouped[key] = [];
  }
  grouped[key].push({
    index: idx,
    date: txn.date,
    merchant: txn.merchant,
    amount: txn.amount,
    description: txn.description
  });
});

// Find duplicates (appear more than once)
const duplicates = Object.entries(grouped).filter(([k, v]) => v.length > 1);

console.log('LOCAL DUPLICATE ANALYSIS');
console.log('========================\n');
console.log(`Total transactions: ${txns.length}`);
console.log(`Unique (date+merchant+amount) combinations: ${Object.keys(grouped).length}`);
console.log(`Local duplicate groups found: ${duplicates.length}\n`);

if (duplicates.length > 0) {
  console.log('DUPLICATE GROUPS:');
  console.log('-----------------\n');
  
  let totalDupCount = 0;
  duplicates.slice(0, 20).forEach(([key, items]) => {
    const [date, merchant, amount] = key.split('|');
    totalDupCount += items.length;
    console.log(`Date: ${date} | Merchant: ${merchant} | Amount: ₹${amount}`);
    console.log(`  Appears ${items.length}x at indices: ${items.map(i => i.index).join(', ')}`);
    console.log();
  });
  
  console.log(`\n[Showing first 20 groups of ${duplicates.length} total]\n`);
  
  // Count total duplicate transactions (excluding first occurrence)
  const totalDupTxns = duplicates.reduce((sum, [k, items]) => sum + (items.length - 1), 0);
  console.log(`Total duplicate transaction instances to remove: ${totalDupTxns}`);
}
