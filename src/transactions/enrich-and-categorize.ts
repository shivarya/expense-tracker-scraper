import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

type RawTx = {
  date: string
  description: string
  amount: number
  type: 'debit' | 'credit'
}

type EnrichedTx = {
  date: string
  raw_text: string
  amount: number
  original_type: string
  transaction_type: 'expense' | 'credit'
  merchant: string
  merchant_canonical?: string
  description: string
  category: string
  payment_method: string
  source: string
  transaction_hash: string
  source_data: {
    merchant_category?: string
    is_emi?: boolean
    is_recurring?: boolean
    location?: string
    raw_description: string
    purpose?: string
    categoryConfidence?: string
    categoryConfidenceScore?: number
  }
}

function cleanMerchant(raw: string) {
  const s = raw.replace(/UPI-\d+-/i, '').replace(/\s{2,}/g, ' ').trim()
  // remove trailing IN, IND, INDIA tokens
  return s.replace(/\b(INDIA|IND|IN)\b/gi, '').replace(/[\*\,\.|\(\)]/g, '').trim()
}

let MERCHANT_CANONICAL_MAP: Record<string, string> = {
  'SWIGGY': 'Swiggy',
  'SWIGG': 'Swiggy',
  'BLINKIT': 'Blinkit',
  'MILKBASET': 'Milkbasket',
  'MILKBASKET': 'Milkbasket',
  'AMAZON PAY': 'Amazon Pay',
  'AMAZON': 'Amazon',
  'MAKE MY TRIP': 'MakeMyTrip',
  'MAKEMYTRIP': 'MakeMyTrip',
  'INDIGO': 'Indigo',
  'GITHUB': 'GitHub',
  'URBANCLAP': 'UrbanClap',
  'URBAN CLAP': 'UrbanClap'
}

function loadMerchantAliasesFromCSV(baseDir?: string) {
  const csvPath = baseDir ? path.resolve(baseDir, '../../config/merchant_aliases.csv') : path.resolve(process.cwd(), 'config', 'merchant_aliases.csv')
  if (!fs.existsSync(csvPath)) return
  try {
    const s = fs.readFileSync(csvPath, 'utf8')
    for (const line of s.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('alias')) continue
      const parts = line.split(',')
      if (parts.length < 2) continue
      const alias = parts[0].trim().toUpperCase()
      const canonical = parts[1].trim()
      if (alias && canonical) MERCHANT_CANONICAL_MAP[alias] = canonical
    }
  } catch (e) {
    console.warn('Could not load merchant_aliases.csv', e)
  }
}

function normalizeMerchantName(name: string) {
  const n = name.replace(/[^a-zA-Z0-9 ]+/g, '').trim().toUpperCase()
  for (const [k, v] of Object.entries(MERCHANT_CANONICAL_MAP)) {
    if (n.includes(k)) return v
  }
  // Fallback: Title case cleaned name
  return name.split(' ').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(' ').trim()
}

function extractLocation(raw: string): string | undefined {
  const r = raw.toUpperCase()
  // Common city patterns
  const cities = ['BANGALORE', 'MUMBAI', 'DELHI', 'CHENNAI', 'HYDERABAD', 'PUNE', 'KOLKATA', 'RAMESWARAM', 'MADURAI']
  for (const city of cities) {
    if (r.includes(city)) return city.charAt(0) + city.slice(1).toLowerCase()
  }
  // State codes
  if (r.includes('TAM')) return 'Tamil Nadu'
  if (r.includes('KAR')) return 'Karnataka'
  if (r.includes('MAH')) return 'Maharashtra'
  return undefined
}

function isEMI(raw: string): boolean {
  return /EMI|AMORTIZATION|INSTALLMENT/i.test(raw)
}

function isRecurring(raw: string): boolean {
  return /SUBSCRIPTION|NETFLIX|SPOTIFY|GITHUB|PREMIUM|INSURANCE/i.test(raw)
}

function categorize(raw: string): { merchant: string; category: string; purpose: string; confidence: 'High'|'Medium'|'Low'; merchantCategory?: string; location?: string } {
  const r = raw.toUpperCase()
  const merchant = cleanMerchant(raw)
  const location = extractLocation(raw)
  
  // Patterns
  if (/SWIGG|SWIGGY/.test(r)) return { merchant: 'Swiggy', category: 'Food & Dining', purpose: 'Food Delivery', confidence: 'High', merchantCategory: 'food_delivery', location }
  if (/BLINKIT|MILK|GROCERY|SUPERMARKET|ADISHWAR|MILKBASET|MILKBASKET/.test(r)) return { merchant: merchant, category: 'Groceries', purpose: 'Grocery Shopping', confidence: 'High', merchantCategory: 'grocery', location }
  if (/MAKEMYTRIP|CLEARTRIP|INDIGO|IRCTC|BOOKMYSHOW|YOM|MAKEMYTRIP COM|MAKE MY TRIP/.test(r)) return { merchant: merchant, category: 'Travel', purpose: 'Travel Booking', confidence: 'High', merchantCategory: 'travel_booking', location }
  if (/AMAZON|FLIPCART|AJIO|MYNTRA|THEHOME|THELUXURY|CART|LUGGAGE/.test(r)) return { merchant: merchant, category: 'Shopping', purpose: 'Online Shopping', confidence: 'High', merchantCategory: 'retail_shopping', location }
  if (/HOTEL|RESORT|DAIWI|DAIWIK|GRAND|HOSPITALITY/.test(r)) return { merchant: merchant, category: 'Travel', purpose: 'Hotel Stay', confidence: 'High', merchantCategory: 'hotel', location }
  if (/MC DONAL|MCDONALD|DOMINOS|PIZZA|ZOMATO|DUNKIN|RESTAURANT|CAFE|TANDOORI/.test(r)) return { merchant: merchant, category: 'Food & Dining', purpose: 'Dining Out', confidence: 'High', merchantCategory: 'restaurant', location }
  if (/PHARMACY|MEDICAL|MEDICALS|DRUGS|APOTHEC|PHARMA/.test(r)) return { merchant: merchant, category: 'Healthcare', purpose: 'Medical Purchase', confidence: 'High', merchantCategory: 'pharmacy', location }
  if (/POLICYBAZAAR|INSURANC|PREMIUM/.test(r)) return { merchant: merchant, category: 'Bills & Utilities', purpose: 'Insurance Premium', confidence: 'High', merchantCategory: 'insurance', location }
  if (/GITHUB|MICROSOFT|ADOBE|SUBSCRIPTION|NETFLIX|SPOTIFY|HOTSTAR|PRIMEVIDEO/.test(r)) return { merchant: merchant, category: 'Entertainment', purpose: 'Subscription Service', confidence: 'High', merchantCategory: 'subscription', location }
  if (/URBANCLAP|URBAN CLAP/.test(r)) return { merchant: 'UrbanClap', category: 'Services', purpose: 'Home Services', confidence: 'High', merchantCategory: 'home_services', location }
  if (/UPI-\d+-/.test(raw)) {
    const m = raw.match(/UPI-\d+-([A-Z0-9 \-\\.]+)/i)
    if (m) return { merchant: cleanMerchant(m[1]), category: 'Miscellaneous', purpose: 'UPI Payment', confidence: 'Medium', merchantCategory: 'upi_payment', location }
  }
  return { merchant: merchant, category: 'Other', purpose: 'Other Transaction', confidence: 'Low', merchantCategory: 'other', location }
}

function toISO(dateStr: string) {
  // pdf-parse dates typically DD/MM/YYYY
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  // try DD-MM-YYYY
  const n = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/)
  if (n) return `${n[3]}-${n[2]}-${n[1]}`
  return dateStr
}

async function main() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  // Load CSV overrides now that __dirname is available
  loadMerchantAliasesFromCSV(__dirname)
  const root = path.resolve(__dirname, '../../data/raw-extracts')
  const infile = path.join(root, 'pdf-parse-extractions.json')
  const outfile = path.join(root, 'enriched-transactions.json')

  if (!fs.existsSync(infile)) {
    console.error('Input file not found:', infile)
    process.exit(1)
  }

  const raw = JSON.parse(fs.readFileSync(infile, 'utf8'))
  const enriched: any[] = []
  const categoryTotals: Record<string, number> = {}
  const merchantTotals: Record<string, number> = {}
  const cards: Array<{ filename: string; bank: string; card_type: string; card_last4: string }> = []

  for (const file of raw.extractions || []) {
    // Extract card info from filename
    const cardMatch = file.filename.match(/(\d{4}).*?(\w+)_NORM/) || file.filename.match(/xxxx-xxxx-xx-xxxx(\d{2})/)
    const cardLast4 = cardMatch ? cardMatch[1] : 'XXXX'
    const cardType = file.filename.includes('Rubyx') ? 'Rubyx' : 
                     file.filename.includes('Amazon') ? 'Amazon Pay' : 'Credit Card'
    const bank = file.filename.includes('6529') ? 'ICICI Bank' :
                 file.filename.includes('4315') ? 'ICICI Bank' :
                 file.filename.includes('xxxx-xxxx') ? 'RBL Bank' : 'Bank'
    // record card info
    cards.push({ filename: file.filename, bank, card_type: cardType, card_last4: cardLast4 })
    
    for (const t of file.transactions as RawTx[]) {
      const cat = categorize(t.description)
      const canonical = normalizeMerchantName(cat.merchant)
      const txPartial: Omit<EnrichedTx, 'transaction_hash' | 'source_data'> = {
        date: toISO(t.date),
        raw_text: t.description,
        amount: t.amount,
        original_type: t.type,
        transaction_type: t.type === 'debit' ? 'expense' : 'credit',
        merchant: cat.merchant,
        merchant_canonical: canonical,
        description: `${cat.purpose} at ${canonical}`,
        category: cat.category,
        payment_method: `${bank} Card *${cardLast4}`,
        source: 'web_scrape'
      }

      const hash = crypto.createHash('sha256').update(`${txPartial.date}|${txPartial.amount}|${canonical}|${t.description}`).digest('hex')

      const tx: EnrichedTx = Object.assign({}, txPartial, { transaction_hash: hash, source_data: {
        merchant_category: cat.merchantCategory,
        is_emi: isEMI(t.description),
        // will set is_recurring later based on counts
        is_recurring: false,
        location: cat.location,
        raw_description: t.description,
        purpose: cat.purpose,
        categoryConfidence: cat.confidence,
        categoryConfidenceScore: cat.confidence === 'High' ? 0.9 : cat.confidence === 'Medium' ? 0.65 : 0.4
      }})

      enriched.push(tx)
      
      // Track totals & counts
      if (t.type === 'debit') {
        categoryTotals[cat.category] = (categoryTotals[cat.category] || 0) + t.amount
        merchantTotals[cat.merchant] = (merchantTotals[cat.merchant] || 0) + t.amount
      }
    }
  }

  // After building enriched, detect recurring merchants (>=3 occurrences) and update source_data
  const merchantCounts: Record<string, number> = {}
  for (const tx of enriched) {
    const m = tx.merchant_canonical || tx.merchant
    merchantCounts[m] = (merchantCounts[m] || 0) + 1
  }
  for (const tx of enriched) {
    const m = tx.merchant_canonical || tx.merchant
    if (merchantCounts[m] >= 3) tx.source_data.is_recurring = true
  }

  // derive metadata: statement period and primary card
  const dates = enriched.map(t => t.date).filter(Boolean)
  const minDate = dates.length ? dates.reduce((a,b)=> a < b ? a : b) : undefined
  const maxDate = dates.length ? dates.reduce((a,b)=> a > b ? a : b) : undefined
  const statement_period = minDate && maxDate ? `${minDate} to ${maxDate}` : undefined

  const primaryCard = cards.length ? cards[0] : { filename: '', bank: '', card_type: '', card_last4: 'XXXX' }

  // Compute analysis summary
  const topCategories = Object.entries(categoryTotals)
    .map(([k, v]) => ({ category: k, amount: v }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
  
  const topMerchants = Object.entries(merchantTotals)
    .map(([k, v]) => ({ merchant: k, amount: v }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)

  const summary = {
    enrichedAt: new Date().toISOString(),
    totalTransactions: enriched.length,
    transactions: enriched,
    metadata: {
      bank: primaryCard.bank,
      card_type: primaryCard.card_type,
      card_last4: primaryCard.card_last4,
      statement_period: statement_period,
      cards: cards
    },
    analysis_summary: {
      total_transactions: enriched.length,
      expense_transactions: enriched.filter(t => t.transaction_type === 'expense').length,
      credit_transactions: enriched.filter(t => t.transaction_type === 'credit').length,
      net_spending: enriched.filter(t => t.transaction_type === 'expense').reduce((sum, t) => sum + t.amount, 0),
      spending_by_category: categoryTotals,
      top_categories: topCategories,
      top_merchants: topMerchants
    }
  }

  fs.writeFileSync(outfile, JSON.stringify(summary, null, 2), 'utf8')
  console.log('\n✅ Enrichment Complete!')
  console.log('📄 Output:', outfile)
  console.log('📊 Total transactions:', enriched.length)
  console.log('💳 Expense transactions:', summary.analysis_summary.expense_transactions)
  console.log('💰 Net spending: ₹' + summary.analysis_summary.net_spending.toFixed(2))
  console.log('\n📈 Top 3 Categories:')
  topCategories.slice(0, 3).forEach((c, i) => {
    console.log(`   ${i + 1}. ${c.category}: ₹${c.amount.toFixed(2)}`)
  })
}

main().catch(err => { console.error(err); process.exit(1) })
