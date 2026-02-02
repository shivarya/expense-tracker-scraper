import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type EMIPlan = {
  merchant: string
  card_last4: string
  card_bank: string
  total_installments: number
  amount_financed: number
  total_interest: number
  total_gst: number
  total_amount: number
  monthly_emi: number
  installments_paid: number
  remaining_installments: number
  installments: Array<{
    date: string
    installment_number: number
    total_installments: number
    principal: number
    interest: number
    gst: number
    total_amount: number
  }>
  status: 'active' | 'completed'
  first_installment_date: string
  last_installment_date: string
}

type EnrichedEMIPlan = EMIPlan & {
  merchant_clean: string
  category: string
  purpose?: string
  effective_interest_rate: number
  interest_percentage: number
  gst_percentage: number
  payment_status: string
  completion_percentage: number
  estimated_completion_date?: string
  priority_score: number
  recommendations: string[]
  cost_analysis: {
    total_cost: number
    principal_ratio: number
    interest_ratio: number
    gst_ratio: number
    monthly_burden: number
    remaining_cost: number
  }
}

// Clean merchant name
function cleanMerchant(merchant: string): string {
  return merchant
    .replace(/\bPVT\s+LT\b/gi, '')
    .replace(/\bPRIVATE\s+LIMITED\b/gi, '')
    .replace(/\bLIMITED\b/gi, '')
    .replace(/\bIND\*\b/gi, '')
    .replace(/\bINDIA\b/gi, '')
    .replace(/\bCOM\b$/gi, '')
    .replace(/[*,.\(\)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Categorize EMI based on merchant
function categorizeEMI(merchant: string): { category: string; purpose?: string } {
  const m = merchant.toLowerCase()
  
  if (m.includes('amazon') || m.includes('flipkart') || m.includes('myntra')) {
    return { category: 'Shopping', purpose: 'E-commerce Purchase' }
  }
  if (m.includes('makemytrip') || m.includes('goibibo') || m.includes('indigo') || m.includes('airasia')) {
    return { category: 'Travel', purpose: 'Flight/Hotel Booking' }
  }
  if (m.includes('apple') || m.includes('samsung') || m.includes('oneplus') || m.includes('mi')) {
    return { category: 'Electronics', purpose: 'Mobile/Gadget Purchase' }
  }
  if (m.includes('bajaj') || m.includes('hdfc') || m.includes('icici')) {
    return { category: 'Finance', purpose: 'Loan/EMI' }
  }
  if (m.includes('swiggy') || m.includes('zomato') || m.includes('blinkit')) {
    return { category: 'Food & Groceries', purpose: 'Food Delivery' }
  }
  if (m.includes('netflix') || m.includes('prime') || m.includes('hotstar') || m.includes('spotify')) {
    return { category: 'Entertainment', purpose: 'Subscription' }
  }
  
  return { category: 'Others', purpose: 'General Purchase' }
}

// Calculate effective annual interest rate
function calculateEffectiveRate(emi: EMIPlan): number {
  if (emi.total_interest === 0 || emi.amount_financed === 0) {
    return 0
  }
  
  // Simple approximation: (Total Interest / Principal) / (Months / 12) * 100
  const years = emi.total_installments / 12
  if (years === 0) return 0
  
  const effectiveRate = (emi.total_interest / emi.amount_financed / years) * 100
  return Math.round(effectiveRate * 100) / 100
}

// Calculate completion percentage
function calculateCompletion(emi: EMIPlan): number {
  return Math.round((emi.installments_paid / emi.total_installments) * 100)
}

// Estimate completion date
function estimateCompletionDate(emi: EMIPlan): string | undefined {
  if (emi.status === 'completed') return undefined
  if (emi.remaining_installments === 0) return undefined
  
  try {
    // Parse the last installment date
    const lastDate = parseDate(emi.last_installment_date)
    if (!lastDate) return undefined
    
    // Add remaining months
    const completionDate = new Date(lastDate)
    completionDate.setMonth(completionDate.getMonth() + emi.remaining_installments)
    
    return formatDate(completionDate)
  } catch {
    return undefined
  }
}

// Parse date in DD/MM/YYYY format
function parseDate(dateStr: string): Date | null {
  const parts = dateStr.split('/')
  if (parts.length !== 3) return null
  
  const day = parseInt(parts[0])
  const month = parseInt(parts[1]) - 1 // Month is 0-indexed
  const year = parseInt(parts[2])
  
  return new Date(year, month, day)
}

// Format date as DD/MM/YYYY
function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  return `${day}/${month}/${year}`
}

// Calculate priority score (higher = should pay off sooner)
function calculatePriority(emi: EMIPlan, effectiveRate: number): number {
  let score = 0
  
  // High interest rate = higher priority
  if (effectiveRate > 15) score += 40
  else if (effectiveRate > 10) score += 30
  else if (effectiveRate > 5) score += 20
  else if (effectiveRate > 0) score += 10
  
  // Nearly complete = higher priority (finish it off)
  const completion = calculateCompletion(emi)
  if (completion > 80) score += 30
  else if (completion > 60) score += 20
  else if (completion > 40) score += 10
  
  // Small remaining amount = easier to close
  if (emi.remaining_installments <= 2) score += 20
  else if (emi.remaining_installments <= 4) score += 10
  
  // Higher monthly burden = might want to close
  if (emi.monthly_emi > 5000) score += 10
  
  return score
}

// Generate recommendations
function generateRecommendations(emi: EnrichedEMIPlan): string[] {
  const recs: string[] = []
  
  if (emi.status === 'completed') {
    recs.push('✅ EMI completed')
    return recs
  }
  
  if (emi.effective_interest_rate > 15) {
    recs.push(`⚠️ High interest rate (${emi.effective_interest_rate.toFixed(2)}%) - consider prepayment`)
  }
  
  if (emi.completion_percentage > 80) {
    recs.push(`🎯 Almost done (${emi.completion_percentage}%) - complete it soon`)
  }
  
  if (emi.remaining_installments <= 2) {
    recs.push('🏁 Only a few installments left - easy to close')
  }
  
  if (emi.monthly_emi > 10000) {
    recs.push('💰 High monthly burden - consider as closure priority')
  }
  
  if (emi.effective_interest_rate === 0) {
    recs.push('✨ Zero interest EMI - no rush to prepay')
  } else if (emi.effective_interest_rate < 5) {
    recs.push('👍 Low interest rate - prepayment not urgent')
  }
  
  if (emi.priority_score >= 60) {
    recs.push('🔥 High priority for closure')
  } else if (emi.priority_score >= 40) {
    recs.push('⭐ Medium priority for closure')
  } else {
    recs.push('⏳ Low priority - can continue as scheduled')
  }
  
  if (emi.estimated_completion_date) {
    recs.push(`📅 Estimated completion: ${emi.estimated_completion_date}`)
  }
  
  return recs
}

// Calculate cost analysis
function analyzeCosts(emi: EMIPlan): EnrichedEMIPlan['cost_analysis'] {
  const totalCost = emi.total_amount
  const principalRatio = (emi.amount_financed / totalCost) * 100
  const interestRatio = (emi.total_interest / totalCost) * 100
  const gstRatio = (emi.total_gst / totalCost) * 100
  
  const remainingCost = emi.monthly_emi * emi.remaining_installments
  
  return {
    total_cost: totalCost,
    principal_ratio: Math.round(principalRatio * 100) / 100,
    interest_ratio: Math.round(interestRatio * 100) / 100,
    gst_ratio: Math.round(gstRatio * 100) / 100,
    monthly_burden: emi.monthly_emi,
    remaining_cost: Math.round(remainingCost * 100) / 100
  }
}

// Enrich a single EMI plan
function enrichEMI(emi: EMIPlan): EnrichedEMIPlan {
  const merchantClean = cleanMerchant(emi.merchant)
  const { category, purpose } = categorizeEMI(merchantClean)
  const effectiveRate = calculateEffectiveRate(emi)
  const completionPct = calculateCompletion(emi)
  const estimatedCompletion = estimateCompletionDate(emi)
  const priorityScore = calculatePriority(emi, effectiveRate)
  const costAnalysis = analyzeCosts(emi)
  
  const interestPct = emi.amount_financed > 0 
    ? Math.round((emi.total_interest / emi.amount_financed) * 10000) / 100 
    : 0
  const gstPct = emi.total_amount > 0 
    ? Math.round((emi.total_gst / emi.total_amount) * 10000) / 100 
    : 0
  
  const enriched: EnrichedEMIPlan = {
    ...emi,
    merchant_clean: merchantClean,
    category,
    purpose,
    effective_interest_rate: effectiveRate,
    interest_percentage: interestPct,
    gst_percentage: gstPct,
    payment_status: emi.status === 'completed' ? 'Fully Paid' : `${emi.installments_paid}/${emi.total_installments} Paid`,
    completion_percentage: completionPct,
    estimated_completion_date: estimatedCompletion,
    priority_score: priorityScore,
    recommendations: [],
    cost_analysis: costAnalysis
  }
  
  enriched.recommendations = generateRecommendations(enriched)
  
  return enriched
}

// Main enrichment function
async function enrichEMIs() {
  const inputPath = path.join(__dirname, '../../data/raw-extracts/emi-plans.json')
  const outputPath = path.join(__dirname, '../../data/enriched-emis.json')
  
  console.log('📖 Reading EMI plans from:', inputPath)
  
  if (!fs.existsSync(inputPath)) {
    console.error('❌ EMI plans file not found. Run: npm run extract:cc:emis first')
    process.exit(1)
  }
  
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'))
  const plans: EMIPlan[] = data.emiPlans || []
  
  console.log(`\n✨ Enriching ${plans.length} EMI plans...\n`)
  
  const enriched = plans.map(enrichEMI)
  
  // Sort by priority score (descending)
  enriched.sort((a, b) => b.priority_score - a.priority_score)
  
  // Calculate summary
  const summary = {
    enrichedAt: new Date().toISOString(),
    totalPlans: enriched.length,
    activePlans: enriched.filter(e => e.status === 'active').length,
    completedPlans: enriched.filter(e => e.status === 'completed').length,
    totalMonthlyBurden: Math.round(enriched.filter(e => e.status === 'active').reduce((sum, e) => sum + e.monthly_emi, 0) * 100) / 100,
    totalRemainingCost: Math.round(enriched.filter(e => e.status === 'active').reduce((sum, e) => sum + e.cost_analysis.remaining_cost, 0) * 100) / 100,
    averageInterestRate: Math.round(enriched.filter(e => e.effective_interest_rate > 0).reduce((sum, e) => sum + e.effective_interest_rate, 0) / enriched.filter(e => e.effective_interest_rate > 0).length * 100) / 100 || 0,
    categoryBreakdown: enriched.reduce((acc, e) => {
      acc[e.category] = (acc[e.category] || 0) + 1
      return acc
    }, {} as Record<string, number>),
    highPriorityClosures: enriched.filter(e => e.priority_score >= 60 && e.status === 'active').length
  }
  
  const output = {
    summary,
    emiPlans: enriched
  }
  
  // Ensure output directory exists
  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2))
  
  console.log('📊 Enrichment Summary:')
  console.log('━'.repeat(60))
  console.log(`Total Plans:              ${summary.totalPlans}`)
  console.log(`Active Plans:             ${summary.activePlans}`)
  console.log(`Completed Plans:          ${summary.completedPlans}`)
  console.log(`Total Monthly Burden:     ₹${summary.totalMonthlyBurden.toLocaleString('en-IN')}`)
  console.log(`Total Remaining Cost:     ₹${summary.totalRemainingCost.toLocaleString('en-IN')}`)
  console.log(`Average Interest Rate:    ${summary.averageInterestRate.toFixed(2)}%`)
  console.log(`High Priority Closures:   ${summary.highPriorityClosures}`)
  console.log()
  console.log('Category Breakdown:')
  Object.entries(summary.categoryBreakdown).forEach(([cat, count]) => {
    console.log(`  ${cat.padEnd(20)} ${count}`)
  })
  console.log('━'.repeat(60))
  console.log()
  
  // Display top priority EMIs
  const activeEMIs = enriched.filter(e => e.status === 'active')
  if (activeEMIs.length > 0) {
    console.log('🎯 Top Priority EMIs for Closure:')
    console.log('━'.repeat(60))
    activeEMIs.slice(0, 3).forEach((e, i) => {
      console.log(`\n${i + 1}. ${e.merchant_clean} (${e.card_bank})`)
      console.log(`   Priority Score:    ${e.priority_score}/100`)
      console.log(`   Monthly EMI:       ₹${e.monthly_emi.toLocaleString('en-IN')}`)
      console.log(`   Remaining Cost:    ₹${e.cost_analysis.remaining_cost.toLocaleString('en-IN')}`)
      console.log(`   Interest Rate:     ${e.effective_interest_rate.toFixed(2)}%`)
      console.log(`   Progress:          ${e.completion_percentage}%`)
      console.log(`   Recommendations:`)
      e.recommendations.forEach(r => console.log(`     ${r}`))
    })
    console.log('━'.repeat(60))
  }
  
  console.log(`\n✅ Enriched EMI data saved to: ${outputPath}`)
  console.log(`\n💡 Next step: Review the enriched data and use insights for financial planning`)
}

enrichEMIs().catch(console.error)
