import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const INPUT_FILE = path.join(process.cwd(), 'data', 'hdfc-fd-raw.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'enriched-hdfc-fd.json');

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[₹,\s]/g, '');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseIsoDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toIsoDateString(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().split('T')[0];
}

function addMonths(base: Date, months: number): Date {
  const copy = new Date(base.getTime());
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function monthDiff(start: Date, end: Date): number {
  const years = end.getFullYear() - start.getFullYear();
  const months = end.getMonth() - start.getMonth();
  const raw = years * 12 + months;
  return Math.max(1, raw);
}

function normalizeStatus(value: unknown): 'active' | 'matured' | 'premature_withdrawal' {
  const s = String(value || '').toLowerCase();
  if (s.includes('premature') || s.includes('closed')) return 'premature_withdrawal';
  if (s.includes('matured') || s.includes('maturity')) return 'matured';
  return 'active';
}

function normalizeAccountNumber(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, '');
  return cleaned || null;
}

function normalizeFdNumber(value: unknown, principal: number, maturityDate: string, index: number): string {
  const raw = String(value || '').trim();
  if (raw) return raw;
  const principalPart = Math.round(principal || 0);
  return `HDFC-FD-${maturityDate || 'NA'}-${principalPart}-${index + 1}`;
}

function estimateMaturityValue(principal: number, interestRate: number, tenureMonths: number): number {
  if (principal <= 0 || interestRate <= 0 || tenureMonths <= 0) {
    return principal;
  }

  const years = tenureMonths / 12;
  const quarterlyRate = interestRate / 100 / 4;
  const quarters = Math.max(1, Math.round(years * 4));
  const value = principal * Math.pow(1 + quarterlyRate, quarters);
  return Math.round(value * 100) / 100;
}

function weightedAverageRate(items: Array<{ principal_amount: number; interest_rate: number }>): number {
  const total = items.reduce((sum, i) => sum + i.principal_amount, 0);
  if (total <= 0) return 0;
  const weighted = items.reduce((sum, i) => sum + i.principal_amount * i.interest_rate, 0);
  return Math.round((weighted / total) * 100) / 100;
}

async function enrichHdfcFd() {
  console.log('Enriching HDFC fixed deposit data');

  const rawJson = await fs.readFile(INPUT_FILE, 'utf-8').catch(() => '');
  if (!rawJson) {
    throw new Error('No raw FD file found. Run npm run fd:extract first.');
  }

  const raw = JSON.parse(rawJson) as {
    deposits?: any[];
    source?: string;
    customer_name?: string;
    as_of_date?: string | null;
  };

  const deposits = Array.isArray(raw.deposits) ? raw.deposits : [];
  if (deposits.length === 0) {
    throw new Error('No deposits found in hdfc-fd-raw.json');
  }

  const today = new Date();
  const normalized = [] as Array<{
    bank: 'hdfc';
    fd_number: string;
    account_number: string | null;
    principal_amount: number;
    interest_rate: number;
    tenure_months: number;
    start_date: string;
    maturity_date: string;
    maturity_value: number;
    status: 'active' | 'matured' | 'premature_withdrawal';
    auto_renewal: boolean;
  }>;

  const skipped: Array<{ index: number; reason: string }> = [];

  for (let index = 0; index < deposits.length; index++) {
    const fd = deposits[index];

    const principalAmount = Math.round(toNumber(fd.principal_amount, 0) * 100) / 100;
    if (principalAmount <= 0) {
      skipped.push({ index, reason: 'principal_amount missing or invalid' });
      continue;
    }

    const interestRate = Math.max(0, Math.round(toNumber(fd.interest_rate, 0) * 100) / 100);
    const status = normalizeStatus(fd.status);

    // v1 scope: keep only active records.
    if (status !== 'active') {
      skipped.push({ index, reason: `status=${status} filtered out (active-only)` });
      continue;
    }

    let startDate = parseIsoDate(fd.start_date);
    let maturityDate = parseIsoDate(fd.maturity_date);

    let tenureMonths = Number.isFinite(Number(fd.tenure_months))
      ? Math.max(1, Math.round(Number(fd.tenure_months)))
      : 0;

    if (!tenureMonths && startDate && maturityDate) {
      tenureMonths = monthDiff(startDate, maturityDate);
    }

    if (!startDate && maturityDate && tenureMonths > 0) {
      startDate = addMonths(maturityDate, -tenureMonths);
    }

    if (!maturityDate && startDate && tenureMonths > 0) {
      maturityDate = addMonths(startDate, tenureMonths);
    }

    if (!startDate) {
      startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    }

    if (!tenureMonths) {
      tenureMonths = 12;
    }

    if (!maturityDate) {
      maturityDate = addMonths(startDate, tenureMonths);
    }

    const startDateIso = toIsoDateString(startDate);
    const maturityDateIso = toIsoDateString(maturityDate);

    if (!startDateIso || !maturityDateIso) {
      skipped.push({ index, reason: 'unable to derive valid start/maturity dates' });
      continue;
    }

    const maturityValueRaw = fd.maturity_value === null || fd.maturity_value === undefined
      ? null
      : Math.round(toNumber(fd.maturity_value, 0) * 100) / 100;

    const maturityValue = maturityValueRaw && maturityValueRaw > 0
      ? maturityValueRaw
      : estimateMaturityValue(principalAmount, interestRate, tenureMonths);

    const accountNumber = normalizeAccountNumber(fd.account_number);
    const fdNumber = normalizeFdNumber(fd.fd_number, principalAmount, maturityDateIso, index);

    const autoRenewal = typeof fd.auto_renewal === 'boolean'
      ? fd.auto_renewal
      : String(fd.auto_renewal || '').toLowerCase() === 'true';

    normalized.push({
      bank: 'hdfc',
      fd_number: fdNumber,
      account_number: accountNumber,
      principal_amount: principalAmount,
      interest_rate: interestRate,
      tenure_months: tenureMonths,
      start_date: startDateIso,
      maturity_date: maturityDateIso,
      maturity_value: Math.round(maturityValue * 100) / 100,
      status,
      auto_renewal: autoRenewal,
    });
  }

  if (normalized.length === 0) {
    throw new Error('No active FD records available after enrichment/filtering');
  }

  normalized.sort((a, b) => a.maturity_date.localeCompare(b.maturity_date));

  const totalPrincipal = normalized.reduce((sum, fd) => sum + fd.principal_amount, 0);
  const totalMaturity = normalized.reduce((sum, fd) => sum + fd.maturity_value, 0);

  const output = {
    enrichedAt: new Date().toISOString(),
    source: raw.source || 'hdfc_deposits_portal',
    customer_name: raw.customer_name || '',
    as_of_date: raw.as_of_date || null,
    summary: {
      totalExtracted: deposits.length,
      totalActiveSynced: normalized.length,
      skippedCount: skipped.length,
      totalPrincipal: Math.round(totalPrincipal * 100) / 100,
      totalMaturity: Math.round(totalMaturity * 100) / 100,
      weightedAverageRate: weightedAverageRate(normalized),
    },
    skipped,
    fixed_deposits: normalized,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`Active FDs ready for sync: ${normalized.length}`);
  console.log(`Total principal: ${totalPrincipal.toLocaleString('en-IN')}`);
  console.log(`Total maturity: ${totalMaturity.toLocaleString('en-IN')}`);
  console.log(`Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  enrichHdfcFd().catch((error: any) => {
    console.error('Error:', error.message || error);
    process.exit(1);
  });
}
