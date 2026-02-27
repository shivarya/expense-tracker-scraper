/**
 * Extract EMI (Equated Monthly Installment) information from credit card transactions
 * Identifies EMI plans, tracks installments, calculates totals
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Transaction {
  date: string;
  description: string;
  amount: number;
  type: 'debit' | 'credit';
}

interface PDFExtraction {
  filename: string;
  pdfPath: string;
  transactions: Transaction[];
}

interface EMIInstallment {
  date: string;
  installment_number: number;
  total_installments: number;
  principal: number;
  interest: number;
  gst: number;
  total_amount: number;
}

interface EMIPlan {
  merchant: string;
  card_last4: string;
  card_bank: string;
  total_installments: number;
  amount_financed: number;
  total_interest: number;
  total_gst: number;
  total_amount: number;
  monthly_emi: number;
  installments_paid: number;
  remaining_installments: number;
  installments: EMIInstallment[];
  status: 'active' | 'completed';
  first_installment_date: string;
  last_installment_date?: string;
}

interface EMIInstallmentRecord {
  date: string;
  merchant: string;
  installment: number;
  total: number;
  principal: number;
  interest: number;
  gst: number;
  txIndex: number;
}

function extractCardInfo(filename: string): { bank: string; last4: string } {
  // Extract card info from filename
  // Examples: "6529XXXXXXXX7003_...", "4315XXXXXXXX2003_...", "xxxx-xxxx-xx-xxxx89_..."
  
  if (filename.includes('6529')) {
    return { bank: 'ICICI Bank', last4: '7003' };
  } else if (filename.includes('4315')) {
    return { bank: 'ICICI Bank', last4: '2003' };
  } else if (filename.includes('xxxx')) {
    const match = filename.match(/xxxx(\d{2})_/);
    return { bank: 'RBL Bank', last4: match ? match[1] : 'XX89' };
  }
  
  return { bank: 'Unknown Bank', last4: '****' };
}

function parseEMITransaction(description: string): { 
  type: 'interest' | 'principal' | 'gst' | null;
  merchant: string | null;
  installment: number | null;
  total: number | null;
} {
  const desc = description.toUpperCase();
  
  // Check for Interest
  // Format: "Interest Amount Amortization - <4/6>MERCHANT NAME"
  // Where <4/6> means: 4th installment out of 6 total installments
  if (desc.includes('INTEREST AMOUNT AMORTIZATION')) {
    const match = description.match(/<(\d+)\/(\d+)>(.+)/i);
    if (match) {
      return {
        type: 'interest',
        merchant: match[3].trim(),
        installment: parseInt(match[1]), // Current installment number (e.g., 4)
        total: parseInt(match[2])        // Total installments in plan (e.g., 6)
      };
    }
  }
  
  // Check for Principal
  // Format: "Principal Amount Amortization - <4/6>MERCHANT NAME"
  // Where <4/6> means: 4th installment out of 6 total installments
  if (desc.includes('PRINCIPAL AMOUNT AMORTIZATION')) {
    const match = description.match(/<(\d+)\/(\d+)>(.+)/i);
    if (match) {
      return {
        type: 'principal',
        merchant: match[3].trim(),
        installment: parseInt(match[1]), // Current installment number (e.g., 4)
        total: parseInt(match[2])        // Total installments in plan (e.g., 6)
      };
    }
  }
  
  // Check for GST/IGST
  if (desc.includes('IGST') || desc.includes('GST')) {
    return {
      type: 'gst',
      merchant: null,
      installment: null,
      total: null
    };
  }
  
  return { type: null, merchant: null, installment: null, total: null };
}

async function extractEMIs() {
  console.log('💳 EMI Extraction Tool\n');
  console.log('━'.repeat(60));
  
  // Read pdf-parse extractions
  const extractionsPath = path.join(__dirname, '../../data/raw-extracts/pdf-parse-extractions.json');
  const content = await fs.readFile(extractionsPath, 'utf-8');
  const data = JSON.parse(content);
  
  const emiPlans: Map<string, EMIPlan> = new Map();
  
  // Process each PDF
  for (const extraction of data.extractions) {
    const cardInfo = extractCardInfo(extraction.filename);
    const transactions = extraction.transactions;
    
    console.log(`\n📄 Processing: ${extraction.filename}`);
    
    // Build installment-level EMI records first (interest/gst/principal may appear in any order)
    const installmentRecords = new Map<string, EMIInstallmentRecord>();

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const parsed = parseEMITransaction(tx.description);

      if ((parsed.type === 'interest' || parsed.type === 'principal') && parsed.merchant && parsed.installment && parsed.total) {
        const recordKey = `${tx.date}|${parsed.merchant}|${parsed.installment}/${parsed.total}`;

        if (!installmentRecords.has(recordKey)) {
          installmentRecords.set(recordKey, {
            date: tx.date,
            merchant: parsed.merchant,
            installment: parsed.installment,
            total: parsed.total,
            principal: 0,
            interest: 0,
            gst: 0,
            txIndex: i
          });
        }

        const record = installmentRecords.get(recordKey)!;
        record.txIndex = i;

        if (parsed.type === 'interest') {
          record.interest += tx.amount;
        } else {
          record.principal += tx.amount;
        }
      } else if (parsed.type === 'gst') {
        // IGST rows don't include merchant/installment token; assign to nearest EMI record on same date.
        const sameDateCandidates = Array.from(installmentRecords.values())
          .filter(r => r.date === tx.date && r.gst === 0)
          .sort((a, b) => Math.abs(a.txIndex - i) - Math.abs(b.txIndex - i));

        if (sameDateCandidates.length > 0) {
          sameDateCandidates[0].gst = tx.amount;
        }
      }
    }

    for (const emiRecord of installmentRecords.values()) {
      addEMIInstallment(emiPlans, {
        date: emiRecord.date,
        merchant: emiRecord.merchant,
        installment: emiRecord.installment,
        total: emiRecord.total,
        principal: emiRecord.principal,
        interest: emiRecord.interest,
        gst: emiRecord.gst
      }, cardInfo);
    }
  }
  
  // Convert map to array and calculate totals
  const emiList: EMIPlan[] = Array.from(emiPlans.values()).map(plan => {
    // Calculate totals
    plan.amount_financed = plan.installments.reduce((sum, inst) => sum + inst.principal, 0);
    plan.total_interest = plan.installments.reduce((sum, inst) => sum + inst.interest, 0);
    plan.total_gst = plan.installments.reduce((sum, inst) => sum + inst.gst, 0);
    plan.total_amount = plan.amount_financed + plan.total_interest + plan.total_gst;
    
    // Calculate average EMI from observed installments
    plan.monthly_emi = plan.installments.length > 0 
      ? plan.installments.reduce((sum, inst) => sum + inst.total_amount, 0) / plan.installments.length
      : 0;

    const maxInstallmentSeen = plan.installments.reduce((max, inst) => Math.max(max, inst.installment_number), 0);
    plan.installments_paid = maxInstallmentSeen;
    plan.remaining_installments = Math.max(0, plan.total_installments - plan.installments_paid);
    
    // Determine status
    plan.status = plan.remaining_installments === 0 ? 'completed' : 'active';
    
    // Set dates
    plan.installments.sort((a, b) => parseIndianDate(a.date).getTime() - parseIndianDate(b.date).getTime());
    plan.first_installment_date = plan.installments[0]?.date;
    plan.last_installment_date = plan.installments[plan.installments.length - 1]?.date;
    
    return plan;
  });
  
  // Save to file
  const outputPath = path.join(__dirname, '../../data/raw-extracts/emi-plans.json');
  const output = {
    extractedAt: new Date().toISOString(),
    totalEMIPlans: emiList.length,
    activeEMIs: emiList.filter(e => e.status === 'active').length,
    completedEMIs: emiList.filter(e => e.status === 'completed').length,
    totalAmountFinanced: emiList.reduce((sum, e) => sum + e.amount_financed, 0),
    totalInterestPaid: emiList.reduce((sum, e) => sum + e.total_interest, 0),
    totalGSTPaid: emiList.reduce((sum, e) => sum + e.total_gst, 0),
    emiPlans: emiList.sort((a, b) => b.amount_financed - a.amount_financed)
  };
  
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  
  console.log('\n' + '━'.repeat(60));
  console.log(`\n✅ EMI Extraction Complete!`);
  console.log(`📊 Total EMI Plans: ${output.totalEMIPlans}`);
  console.log(`   Active: ${output.activeEMIs}`);
  console.log(`   Completed: ${output.completedEMIs}`);
  console.log(`\n💰 Financial Summary:`);
  console.log(`   Amount Financed: ₹${output.totalAmountFinanced.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  console.log(`   Interest Paid: ₹${output.totalInterestPaid.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  console.log(`   GST Paid: ₹${output.totalGSTPaid.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  console.log(`   Total Cost: ₹${(output.totalAmountFinanced + output.totalInterestPaid + output.totalGSTPaid).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  
  console.log(`\n📄 Saved to: ${outputPath}`);
  
  // Print individual EMI details
  console.log(`\n📋 EMI Plans:\n`);
  for (const plan of emiList) {
    console.log(`   ${plan.merchant}`);
    console.log(`   ${plan.card_bank} Card *${plan.card_last4}`);
    console.log(`   ₹${plan.amount_financed.toLocaleString('en-IN')} @ ${plan.installments_paid}/${plan.total_installments} installments`);
    console.log(`   Monthly EMI: ₹${plan.monthly_emi.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
    console.log(`   Status: ${plan.status === 'active' ? '🟢 Active' : '✅ Completed'}`);
    console.log('');
  }
}

function addEMIInstallment(
  emiPlans: Map<string, EMIPlan>,
  emiData: { date: string; merchant: string; installment: number; total: number; principal: number; interest: number; gst: number },
  cardInfo: { bank: string; last4: string }
) {
  const baseKey = `${cardInfo.last4}_${emiData.merchant}_${emiData.total}`;

  // Support multiple concurrent EMI plans for same merchant+card+tenure.
  const candidateKeys = Array.from(emiPlans.keys()).filter(k => k.startsWith(`${baseKey}_`));
  const emiDate = parseIndianDate(emiData.date);
  let keyToUse: string | null = null;

  for (const candidateKey of candidateKeys) {
    const plan = emiPlans.get(candidateKey)!;
    const maxInstallmentSeen = plan.installments.reduce((max, inst) => Math.max(max, inst.installment_number), 0);
    const lastDate = plan.installments.length > 0
      ? parseIndianDate(plan.installments[plan.installments.length - 1].date)
      : null;
    const dateGap = lastDate ? Math.abs(daysBetween(lastDate, emiDate)) : 999;

    const canAppend =
      emiData.installment > maxInstallmentSeen &&
      dateGap >= 20;

    if (canAppend) {
      keyToUse = candidateKey;
      break;
    }
  }

  if (!keyToUse) {
    const nextSequence = candidateKeys.length + 1;
    keyToUse = `${baseKey}_${nextSequence}`;
  }

  const key = keyToUse;

  if (!emiPlans.has(key)) {
    emiPlans.set(key, {
      merchant: emiData.merchant,
      card_last4: cardInfo.last4,
      card_bank: cardInfo.bank,
      total_installments: emiData.total,
      amount_financed: 0,
      total_interest: 0,
      total_gst: 0,
      total_amount: 0,
      monthly_emi: 0,
      installments_paid: emiData.installment,
      remaining_installments: emiData.total,
      installments: [],
      status: 'active',
      first_installment_date: emiData.date
    });
  }
  
  const plan = emiPlans.get(key)!;
  
  plan.installments.push({
    date: emiData.date,
    installment_number: emiData.installment,
    total_installments: emiData.total,
    principal: emiData.principal,
    interest: emiData.interest,
    gst: emiData.gst,
    total_amount: emiData.principal + emiData.interest + emiData.gst
  });

  plan.installments.sort((a, b) => parseIndianDate(a.date).getTime() - parseIndianDate(b.date).getTime());
  plan.installments_paid = plan.installments.reduce((max, inst) => Math.max(max, inst.installment_number), 0);
  plan.remaining_installments = Math.max(0, plan.total_installments - plan.installments_paid);
}

function parseIndianDate(dateStr: string): Date {
  const [day, month, year] = dateStr.split('/').map(n => parseInt(n, 10));
  return new Date(year, month - 1, day);
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Run extraction
extractEMIs().catch(console.error);
