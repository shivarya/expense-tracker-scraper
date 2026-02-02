import fs from 'fs'
import path from 'path'

function levenshtein(a, b) {
  // simple iterative implementation
  const m = a.length, n = b.length
  const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0))
  for (let i=0;i<=m;i++) dp[i][0]=i
  for (let j=0;j<=n;j++) dp[0][j]=j
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost)
    }
  }
  return dp[m][n]
}

const aliasesPath = path.join(path.resolve(), 'config', 'merchant_aliases.csv')
const enrichedPath = path.join(path.resolve(), 'data', 'raw-extracts', 'enriched-transactions.json')

if (!fs.existsSync(enrichedPath)) {
  console.error('Enriched transactions not found. Run: npm run enrich:cc')
  process.exit(1)
}

const aliasMap = new Map()
if (fs.existsSync(aliasesPath)) {
  const s = fs.readFileSync(aliasesPath, 'utf8')
  for (const line of s.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('alias')) continue
    const [a,c] = line.split(',').map(x=>x.trim())
    if (a && c) aliasMap.set(a.toUpperCase(), c)
  }
}

const enriched = JSON.parse(fs.readFileSync(enrichedPath, 'utf8'))
const txs = enriched.transactions || []

const counts = {}
const rawSet = new Set()
for (const t of txs) {
  const raw = (t.merchant || '').toUpperCase()
  rawSet.add(raw)
  counts[raw] = (counts[raw] || 0) + 1
}

const canonicalList = Array.from(new Set(Array.from(aliasMap.values())))

const suggestions = []
for (const raw of Array.from(rawSet)) {
  if (!raw) continue
  // skip if raw already present as alias
  if (aliasMap.has(raw)) continue
  // compute best canonical by Levenshtein ratio
  let best = null
  let bestScore = Infinity
  for (const c of canonicalList) {
    const dist = levenshtein(raw, c.toUpperCase())
    const norm = dist / Math.max(raw.length, c.length)
    if (norm < bestScore) { bestScore = norm; best = c }
  }
  if (best && bestScore <= 0.4) { // threshold
    suggestions.push({raw, count: counts[raw]||0, suggestion: best, score: bestScore})
  }
}

if (suggestions.length === 0) {
  console.log('No good fuzzy suggestions found (increase threshold if needed)')
  process.exit(0)
}

console.log('Fuzzy suggestions (norm distance <= 0.4):')
console.table(suggestions.sort((a,b)=>b.count-a.count).slice(0,80))

// Write suggestions to file for review
const outPath = path.join(path.resolve(), 'config', 'merchant_alias_suggestions.json')
fs.writeFileSync(outPath, JSON.stringify(suggestions.sort((a,b)=>b.count-a.count), null, 2), 'utf8')
console.log('\nWrote suggestions to', outPath)
