import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const INPUT_FILE = path.join(process.cwd(), 'data', 'mfcentral-raw.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'enriched-mfcentral.json');

function cleanFundName(name: string): string {
  let cleaned = name;
  // Remove ISIN codes
  cleaned = cleaned.replace(/\s*ISIN:\s*[A-Z0-9]+/gi, '');
  // Remove "(Advisor: ...)" blocks
  cleaned = cleaned.replace(/\s*\(Advisor:\s*[^)]*\)/gi, '');
  // Remove "(formerly ...)" / "(erstwhile ...)" blocks — closed or truncated
  cleaned = cleaned.replace(/\s*\((formerly|erstwhile)\s[^)]*\)?/gi, '');
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  // Remove trailing commas or dashes
  cleaned = cleaned.replace(/[,\-\s]+$/, '').trim();
  return cleaned;
}

function normalizePlanType(planType: string, fundName: string): string {
  const pt = (planType || '').toLowerCase();
  if (pt === 'direct' || pt === 'regular') return pt;
  // Fallback: detect from fund name
  if (/direct/i.test(fundName)) return 'direct';
  if (/regular/i.test(fundName)) return 'regular';
  return 'direct';
}

function normalizeOptionType(optionType: string, fundName: string): string {
  const ot = (optionType || '').toLowerCase();
  if (ot === 'growth') return 'growth';
  if (ot === 'idcw' || ot === 'dividend') return 'idcw';
  // Fallback: detect from fund name
  if (/growth/i.test(fundName)) return 'growth';
  if (/idcw|dividend/i.test(fundName)) return 'idcw';
  return 'growth';
}

async function enrichMfcentral() {
  console.log('🚀 Enriching MF Central data\n');
  console.log('━'.repeat(60));

  const raw = JSON.parse(await fs.readFile(INPUT_FILE, 'utf-8'));
  const funds = raw.funds || [];

  if (!Array.isArray(funds) || funds.length === 0) {
    throw new Error('No funds found in mfcentral-raw.json. Run mfc:extract first.');
  }

  console.log(`📦 Processing ${funds.length} scheme(s)...`);

  const enrichedFunds = funds.map((f: any) => {
    const units = Number(f.units || 0);
    const nav = Number(f.nav || 0);
    const investedAmount = Number(f.invested_amount || 0);
    let currentValue = Number(f.current_value || 0);

    // If current_value is 0 but we have units and NAV, compute it
    if (currentValue === 0 && units > 0 && nav > 0) {
      currentValue = Math.round(units * nav * 100) / 100;
    }

    return {
      fund_name: cleanFundName(String(f.fund_name || '')),
      folio_number: String(f.folio_number || '').trim(),
      amc: String(f.amc || '').trim(),
      units,
      nav,
      invested_amount: investedAmount,
      current_value: currentValue,
      plan_type: normalizePlanType(f.plan_type, f.fund_name),
      option_type: normalizeOptionType(f.option_type, f.fund_name),
      portal_url: 'https://app.mfcentral.com',
    };
  });

  // Compute summary
  const totalInvested = enrichedFunds.reduce((s: number, f: any) => s + f.invested_amount, 0);
  const totalCurrent = enrichedFunds.reduce((s: number, f: any) => s + f.current_value, 0);
  const gainLoss = Math.round((totalCurrent - totalInvested) * 100) / 100;
  const gainLossPct = totalInvested > 0 ? Math.round((gainLoss / totalInvested) * 10000) / 100 : 0;

  // Group by AMC for summary
  const amcMap: Record<string, { count: number; invested: number; current: number }> = {};
  for (const f of enrichedFunds) {
    const amc = f.amc || 'Unknown';
    if (!amcMap[amc]) amcMap[amc] = { count: 0, invested: 0, current: 0 };
    amcMap[amc].count++;
    amcMap[amc].invested += f.invested_amount;
    amcMap[amc].current += f.current_value;
  }

  const output = {
    enrichedAt: new Date().toISOString(),
    source: 'MF Central CAS',
    investor_name: raw.investor_name || '',
    pan: raw.pan || '',
    summary: {
      totalSchemes: enrichedFunds.length,
      totalInvested: Math.round(totalInvested * 100) / 100,
      totalCurrent: Math.round(totalCurrent * 100) / 100,
      gainLoss,
      gainLossPct,
      amcBreakdown: Object.entries(amcMap).map(([amc, data]) => ({
        amc,
        schemes: data.count,
        invested: Math.round(data.invested * 100) / 100,
        current: Math.round(data.current * 100) / 100,
      })),
    },
    funds: enrichedFunds,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // Print summary
  console.log(`\n✅ Enrichment complete — ${enrichedFunds.length} scheme(s)`);
  console.log(`   Total Invested: ₹${totalInvested.toLocaleString('en-IN')}`);
  console.log(`   Total Current:  ₹${totalCurrent.toLocaleString('en-IN')}`);
  console.log(`   Gain/Loss:      ₹${gainLoss.toLocaleString('en-IN')} (${gainLossPct}%)`);
  console.log(`\n📊 AMC Breakdown:`);
  for (const [amc, data] of Object.entries(amcMap)) {
    console.log(`   ${amc}: ${data.count} scheme(s), ₹${data.current.toLocaleString('en-IN')}`);
  }
  console.log(`\n💾 Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  enrichMfcentral().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
