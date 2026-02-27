import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type PreviewType = 'transactions' | 'emis' | 'stocks' | 'mutual_funds';

interface DuplicatePreviewResponse {
  success: boolean;
  data?: {
    type: PreviewType;
    total_items: number;
    duplicate_items: number;
    new_items: number;
    results: Array<{
      index: number;
      is_duplicate: boolean;
      match_count: number;
      incoming: Record<string, any>;
      matches: Record<string, any>[];
    }>;
  };
  message?: string;
}

function parseArg(name: string): string | undefined {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : undefined;
}

async function readJson<T = any>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function loadTransactionsItems() {
  const filePath = path.join(__dirname, '../../data/raw-extracts/enriched-transactions.json');
  const data = await readJson<any>(filePath);
  if (!data?.transactions || !Array.isArray(data.transactions)) {
    return { items: [], source: filePath };
  }

  const cardLast4 = data?.metadata?.card_last4 || '0000';
  const bank = data?.metadata?.bank || 'Unknown Bank';

  const items = data.transactions.map((txn: any) => ({
    amount: txn.amount,
    date: txn.date || txn.transaction_date,
    merchant: txn.merchant || null,
    description: txn.description || null,
    transaction_type: txn.transaction_type,
    reference_number: txn.reference_number || `CC_${cardLast4}_${txn.date}_${txn.amount}`,
    account_number: cardLast4,
    bank
  }));

  return { items, source: filePath };
}

async function loadEmiItems() {
  const filePath = path.join(__dirname, '../../data/enriched-emis.json');
  const data = await readJson<any>(filePath);
  if (!data?.emiPlans || !Array.isArray(data.emiPlans)) {
    return { items: [], source: filePath };
  }

  const parseDate = (dateStr?: string) => {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return dateStr;
  };

  const items = data.emiPlans.map((emi: any) => ({
    loan_name: emi.merchant_clean || emi.merchant || emi.loan_name,
    principal_amount: emi.amount_financed ?? emi.principal_amount,
    start_date: parseDate(emi.last_installment_date) || emi.start_date,
    tenure_months: emi.total_installments ?? emi.tenure_months,
    status: emi.status
  }));

  return { items, source: filePath };
}

async function loadStocksItems() {
  const filePath = path.join(__dirname, '../../data/enriched-cdsl.json');
  const data = await readJson<any>(filePath);
  if (!data?.stocks || !Array.isArray(data.stocks)) {
    return { items: [], source: filePath };
  }

  const items = data.stocks.map((stock: any) => ({
    platform: stock.platform || 'CDSL',
    symbol: stock.symbol,
    isin: stock.isin,
    company_name: stock.company_name,
    quantity: stock.quantity,
    current_value: stock.current_value ?? stock.value
  }));

  return { items, source: filePath };
}

async function loadMutualFundItems() {
  // Try MF Central enriched data first, fallback to CDSL
  const mfcPath = path.join(__dirname, '../../data/enriched-mfcentral.json');
  const mfcData = await readJson<any>(mfcPath);
  if (mfcData?.funds && Array.isArray(mfcData.funds) && mfcData.funds.length > 0) {
    const items = mfcData.funds.map((mf: any) => ({
      folio: mf.folio_number,
      folio_number: mf.folio_number,
      fund_name: mf.fund_name,
      amc: mf.amc,
      units: mf.units,
      amount: mf.current_value
    }));
    return { items, source: mfcPath };
  }

  // Fallback to CDSL
  const filePath = path.join(__dirname, '../../data/enriched-cdsl.json');
  const data = await readJson<any>(filePath);
  if (!data?.mutualFunds || !Array.isArray(data.mutualFunds)) {
    return { items: [], source: filePath };
  }

  const items = data.mutualFunds.map((mf: any) => ({
    folio: mf.folio,
    folio_number: mf.folio,
    fund_name: mf.fund_name,
    amc: mf.amc,
    units: mf.units,
    amount: mf.amount
  }));

  return { items, source: filePath };
}

async function postPreview(type: PreviewType, items: any[], apiUrl: string, apiToken: string) {
  const normalizedApiUrl = apiUrl.replace(/\/$/, '');
  const candidateUrls = [
    `${normalizedApiUrl}/duplicates/preview`,
    `${normalizedApiUrl}/api/duplicates/preview`
  ];

  let lastError: any = null;

  for (const url of candidateUrls) {
    try {
      const response = await axios.post<DuplicatePreviewResponse>(
        url,
        { type, items },
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      return response.data;
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.response?.data?.message || error?.message || '';
      const status = error?.response?.status;

      const canTryNextUrl =
        status === 404 ||
        message.toLowerCase().includes('invalid endpoint') ||
        message.toLowerCase().includes('route not found');

      lastError = error;

      if (!canTryNextUrl) {
        throw error;
      }
    }
  }

  throw new Error(
    `Duplicate preview endpoint not available on backend. Tried: ${candidateUrls.join(', ')}. ` +
      `Deploy latest server duplicate controller with /duplicates/preview or point API_URL to the updated server.`
  );
}

async function run() {
  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_TOKEN;

  if (!apiUrl || !apiToken) {
    throw new Error('Missing API_URL or API_TOKEN in .env');
  }

  const requested = (parseArg('type') || 'all').toLowerCase();
  const types: PreviewType[] = requested === 'all'
    ? ['transactions', 'emis', 'stocks', 'mutual_funds']
    : [requested as PreviewType];

  const loaders: Record<PreviewType, () => Promise<{ items: any[]; source: string }>> = {
    transactions: loadTransactionsItems,
    emis: loadEmiItems,
    stocks: loadStocksItems,
    mutual_funds: loadMutualFundItems
  };

  console.log('🔍 Previewing duplicates against DB\n');
  console.log('━'.repeat(60));

  const report: Record<string, any> = {
    generatedAt: new Date().toISOString(),
    apiUrl,
    checks: {}
  };

  for (const type of types) {
    if (!loaders[type]) {
      console.log(`\n⚠️  Skipping unsupported type: ${type}`);
      continue;
    }

    const { items, source } = await loaders[type]();

    console.log(`\n📦 Type: ${type}`);
    console.log(`   Source: ${source}`);
    console.log(`   Items loaded: ${items.length}`);

    if (items.length === 0) {
      report.checks[type] = {
        source,
        total_items: 0,
        duplicate_items: 0,
        new_items: 0,
        note: 'No items found in source file'
      };
      continue;
    }

    const result = await postPreview(type, items, apiUrl, apiToken);

    const summary = {
      source,
      total_items: result.data?.total_items ?? 0,
      duplicate_items: result.data?.duplicate_items ?? 0,
      new_items: result.data?.new_items ?? 0,
      sample_matches: (result.data?.results || [])
        .filter((row) => row.is_duplicate)
        .slice(0, 5)
        .map((row) => ({
          index: row.index,
          match_count: row.match_count,
          incoming: row.incoming,
          first_match: row.matches?.[0] || null
        }))
    };

    report.checks[type] = summary;

    console.log(`   ✅ Duplicate items: ${summary.duplicate_items}`);
    console.log(`   ✅ New items: ${summary.new_items}`);
  }

  const reportPath = path.join(__dirname, '../../data/raw-extracts/duplicate-preview-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log('\n' + '━'.repeat(60));
  console.log(`✅ Report saved: ${reportPath}`);
}

run().catch((error: any) => {
  console.error('\n❌ Duplicate preview failed:', error.response?.data || error.message || error);
  process.exit(1);
});
