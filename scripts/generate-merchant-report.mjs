import fs from 'fs'
import path from 'path'

const aliasesPath = path.join(path.resolve(), 'config', 'merchant_aliases.csv')
const enrichedPath = path.join(path.resolve(), 'data', 'raw-extracts', 'enriched-transactions.json')

const aliases = new Map()
if (fs.existsSync(aliasesPath)) {
  const s = fs.readFileSync(aliasesPath, 'utf8')
  for (const line of s.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('alias')) continue
    const parts = line.split(',')
    if (parts.length >= 2) aliases.set(parts[0].trim().toUpperCase(), parts[1].trim())
  }
}

if (!fs.existsSync(enrichedPath)) {
  console.error('Enriched transactions not found. Run: npm run enrich:cc')
  process.exit(1)
}

const j = JSON.parse(fs.readFileSync(enrichedPath, 'utf8'))
const txs = j.transactions || []

const merchantCounts = {}
const unmapped = new Set()

for (const t of txs) {
  const raw = (t.merchant || '').toUpperCase()
  const canonical = t.merchant_canonical || ''
  merchantCounts[canonical || raw] = (merchantCounts[canonical || raw] || 0) + 1
  // Check whether canonical came from aliases; if canonical is title-cased fallback, suggest mapping
  let matched = false
  for (const [a, c] of aliases.entries()) {
    if (raw.includes(a)) { matched = true; break }
  }
  if (!matched) unmapped.add(raw)
}

console.log('Top merchants by count:')
Object.entries(merchantCounts).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([m,c])=>console.log(`${c.toString().padStart(4)} tx  - ${m}`))

console.log('\nSample unmapped merchant names (suggest adding to config/merchant_aliases.csv):')
Array.from(unmapped).slice(0,40).forEach(u=>console.log('- ' + u))

console.log('\nAlias file path:', aliasesPath)
console.log('Edit the CSV (alias,canonical) and rerun `npm run enrich:cc`')
