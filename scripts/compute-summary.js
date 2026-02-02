const fs = require('fs')
const path = require('path')

const infile = path.join(__dirname, '..', 'data', 'raw-extracts', 'enriched-transactions.json')
if (!fs.existsSync(infile)) {
  console.error('File not found:', infile)
  process.exit(1)
}
const j = JSON.parse(fs.readFileSync(infile, 'utf8'))
const txs = j.transactions || []

const categoryTotals = {}
const categoryCounts = {}
const merchantTotals = {}

txs.forEach(t => {
  if (t.transaction_type === 'expense') {
    categoryTotals[t.category] = (categoryTotals[t.category] || 0) + t.amount
    categoryCounts[t.category] = (categoryCounts[t.category] || 0) + 1
  }
  merchantTotals[t.merchant] = (merchantTotals[t.merchant] || 0) + t.amount
})

const topCategories = Object.entries(categoryTotals).map(([k,v])=>({category:k,amount:v,count:categoryCounts[k]||0})).sort((a,b)=>b.amount-a.amount)
const topMerchants = Object.entries(merchantTotals).map(([k,v])=>({merchant:k,amount:v})).sort((a,b)=>b.amount-a.amount)

console.log('Total transactions:', j.totalTransactions)
console.log('Total expense transactions:', txs.filter(t=>t.transaction_type==='expense').length)
console.log('\nTop categories by spend:')
topCategories.slice(0,8).forEach(c => console.log(`- ${c.category}: ₹${c.amount.toFixed(2)} (${c.count} tx)`))

console.log('\nTop merchants by spend:')
topMerchants.slice(0,10).forEach(m => console.log(`- ${m.merchant}: ₹${m.amount.toFixed(2)}`))
