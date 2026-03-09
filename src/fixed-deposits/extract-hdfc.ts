import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { PDFParse } from 'pdf-parse';
import { fileURLToPath } from 'url';

dotenv.config();

const METADATA_FILE = path.join(process.cwd(), 'data', 'hdfc-fd-statement.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'hdfc-fd-raw.json');

function monthNumberFromName(value: string): string | null {
  const map: Record<string, string> = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  };
  return map[value.toLowerCase()] || null;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[₹,\s]/g, '');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toInt(value: unknown): number | null {
  const n = toNumber(value, Number.NaN);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function toIsoDate(value: unknown): string | null {
  if (!value) return null;

  if (typeof value === 'string') {
    const v = value.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return v;
    }

    const slash = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (slash) {
      const dd = slash[1].padStart(2, '0');
      const mm = slash[2].padStart(2, '0');
      const yearRaw = slash[3];
      const yyyy = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
      return `${yyyy}-${mm}-${dd}`;
    }

    const monthName = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (monthName) {
      const dd = monthName[1].padStart(2, '0');
      const mm = monthNumberFromName(monthName[2]);
      if (mm) {
        return `${monthName[3]}-${mm}-${dd}`;
      }
    }

    const dt = new Date(v);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString().split('T')[0];
    }
  }

  return null;
}

function normalizeStatus(value: unknown): 'active' | 'matured' | 'premature_withdrawal' {
  const s = String(value || '').toLowerCase();
  if (s.includes('premature') || s.includes('closed')) return 'premature_withdrawal';
  if (s.includes('matured') || s.includes('maturity') || s.includes('closed')) return 'matured';
  return 'active';
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'enabled', 'on', 'auto'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'disabled', 'off', 'manual'].includes(s)) return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

async function parsePDF(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text, pages: result.total };
  } finally {
    await parser.destroy();
  }
}

function buildPrompt(captureMode: string): string {
  return `You extract HDFC fixed deposit holdings from ${captureMode === 'pdf' ? 'PDF statement text' : 'web table snapshot JSON'}.

Return ONLY valid JSON with this exact shape:
{
  "customer_name": "string",
  "as_of_date": "YYYY-MM-DD",
  "deposits": [
    {
      "fd_number": "string",
      "account_number": "string or null",
      "principal_amount": number,
      "interest_rate": number,
      "tenure_months": number,
      "start_date": "YYYY-MM-DD",
      "maturity_date": "YYYY-MM-DD",
      "maturity_value": number,
      "status": "active|matured|premature_withdrawal",
      "auto_renewal": true,
      "notes": "string"
    }
  ]
}

Rules:
1. Include every fixed deposit row/entry you can find.
2. Keep numeric values as numbers only (no commas/currency symbols).
3. tenure_months must be integer months.
4. If status is not explicit, use "active" unless clearly matured.
5. If auto renewal is not visible, set false.
6. If some field is missing, infer only when obvious, otherwise use null for strings/dates and 0 for numbers.
7. Do not include markdown code fences.`;
}

function createOpenAIClient() {
  const hasAzure = !!process.env.AZURE_OPENAI_ENDPOINT;

  if (hasAzure) {
    if (!process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_DEPLOYMENT) {
      throw new Error('Azure OpenAI configured partially. Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT.');
    }

    return {
      client: new OpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseURL: process.env.AZURE_OPENAI_ENDPOINT,
      }),
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY (or Azure OpenAI configuration) in .env');
  }

  return {
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    model: process.env.OPENAI_MODEL || 'gpt-4-turbo',
  };
}

async function extractWithAI(sourceText: string, sourceName: string, captureMode: string): Promise<any> {
  const { client, model } = createOpenAIClient();
  const systemPrompt = buildPrompt(captureMode);
  const maxChars = 90000;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Source: ${sourceName}\nMode: ${captureMode}\n\nExtract HDFC FD holdings from this input:\n\n${sourceText.substring(0, maxChars)}`,
      },
    ],
    temperature: 0,
    max_completion_tokens: 12000,
  });

  const content = response.choices[0].message.content?.trim() || '{}';
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonStr = jsonMatch ? jsonMatch[1] : content;

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error('AI returned invalid JSON while extracting HDFC FD data');
  }
}

async function parsePdfWithPasswordFallback(pdfPath: string): Promise<{ text: string; pages: number }> {
  const pdfBuffer = await fs.readFile(pdfPath);

  try {
    return await parsePDF(pdfBuffer);
  } catch (error: any) {
    const msg = String(error?.message || '').toLowerCase();
    if (!msg.includes('encrypted') && !msg.includes('password')) {
      throw error;
    }

    const passwordsPath = path.join(process.cwd(), 'src', 'config', 'pdf-passwords.json');
    let passwords: string[] = [];

    try {
      passwords = JSON.parse(await fs.readFile(passwordsPath, 'utf-8')) as string[];
    } catch {
      passwords = [];
    }

    if (passwords.length === 0) {
      throw new Error('PDF is encrypted and src/config/pdf-passwords.json has no passwords');
    }

    const { decrypt } = await import('node-qpdf2');
    const decryptedPath = pdfPath.replace(/\.pdf$/i, '') + '_decrypted.pdf';

    for (const password of passwords) {
      try {
        await decrypt({ input: pdfPath, output: decryptedPath, password });
        const decryptedData = await fs.readFile(decryptedPath);
        const parsed = await parsePDF(decryptedData);
        await fs.unlink(decryptedPath).catch(() => {});
        return parsed;
      } catch {
        await fs.unlink(decryptedPath).catch(() => {});
      }
    }

    throw new Error('Unable to decrypt HDFC FD PDF with configured passwords');
  }
}

function monthsBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const years = end.getUTCFullYear() - start.getUTCFullYear();
  const months = end.getUTCMonth() - start.getUTCMonth();
  return Math.max(1, years * 12 + months);
}

function extractFromDashboardSnapshot(snapshot: any) {
  const rows = Array.isArray(snapshot?.openDeposits) ? snapshot.openDeposits : [];

  const deposits = rows.map((row: any) => {
    const startDate = toIsoDate(row.deposit_date || row.transaction_date);
    const maturityDate = toIsoDate(row.maturity_date);
    const maturityInstruction = String(row.maturity_instruction || '').trim();
    const notes = [
      maturityInstruction ? `instruction=${maturityInstruction}` : '',
      row.pre_mature_yn ? `pre_mature=${String(row.pre_mature_yn).trim()}` : '',
      row.fdr_document?.document_id ? `fdr_doc=${row.fdr_document.document_id}` : '',
      row.daf_document?.document_id ? `daf_doc=${row.daf_document.document_id}` : '',
    ].filter(Boolean).join('; ');

    return {
      bank: 'hdfc',
      fd_number: String(row.deposit_no || '').trim() || null,
      account_number: String(row.bank_deposit_no || '').trim() || null,
      principal_amount: toNumber(row.deposit_amount, 0),
      interest_rate: toNumber(String(row.rate_of_interest || '').replace(/%/g, ''), 0),
      tenure_months: monthsBetween(startDate, maturityDate),
      start_date: startDate,
      maturity_date: maturityDate,
      maturity_value: toNumber(row.maturity_amount, 0),
      status: 'active',
      auto_renewal: /renew/i.test(maturityInstruction),
      notes: notes || null,
    };
  });

  return {
    customer_name: String(snapshot?.profile?.customer_name || '').trim(),
    as_of_date: new Date().toISOString().split('T')[0],
    deposits,
  };
}

async function extractHdfcFd() {
  console.log('Extracting HDFC fixed deposit data');

  const metadataRaw = await fs.readFile(METADATA_FILE, 'utf-8').catch(() => '');
  if (!metadataRaw) {
    throw new Error('Missing hdfc-fd-statement.json. Run npm run fd:fetch first.');
  }

  const metadata = JSON.parse(metadataRaw) as {
    captureMode?: 'pdf' | 'table_snapshot' | 'dashboard_table';
    pdfPath?: string | null;
    pdfPaths?: string[];
    snapshotPath?: string | null;
    source?: string;
  };

  const captureMode = metadata.captureMode || 'pdf';
  const preferredSnapshotPath = metadata.snapshotPath || path.join(process.cwd(), 'data', 'raw-extracts', 'hdfc-fd-table-snapshot.json');

  let sourceText = '';
  let sourceName = '';
  let pageCount: number | null = null;
  let extracted: any = null;

  try {
    const snapshotRaw = await fs.readFile(preferredSnapshotPath, 'utf-8');
    const snapshot = JSON.parse(snapshotRaw);
    if (snapshot?.tableType === 'dashboard' && Array.isArray(snapshot?.openDeposits) && snapshot.openDeposits.length > 0) {
      sourceName = path.basename(preferredSnapshotPath);
      extracted = extractFromDashboardSnapshot(snapshot);
      console.log(`Using dashboard snapshot directly: ${sourceName}`);
    }
  } catch {
    // Snapshot is optional here; continue with captureMode-specific handling.
  }

  if (!extracted && captureMode === 'pdf') {
    const pdfPath = metadata.pdfPath || metadata.pdfPaths?.[0] || null;
    if (!pdfPath) {
      throw new Error('Capture mode is pdf but no pdfPath found in metadata.');
    }

    await fs.access(pdfPath).catch(() => {
      throw new Error(`PDF not found at ${pdfPath}`);
    });

    const parsedPdf = await parsePdfWithPasswordFallback(pdfPath);
    sourceText = parsedPdf.text;
    sourceName = path.basename(pdfPath);
    pageCount = parsedPdf.pages;

    console.log(`Parsed PDF pages: ${pageCount}`);
  } else if (!extracted) {
    const snapshotPath = preferredSnapshotPath;
    await fs.access(snapshotPath).catch(() => {
      throw new Error(`Snapshot JSON not found at ${snapshotPath}`);
    });

    const snapshotRaw = await fs.readFile(snapshotPath, 'utf-8');
    sourceName = path.basename(snapshotPath);

    const snapshot = JSON.parse(snapshotRaw);
    if (snapshot?.tableType === 'dashboard' && Array.isArray(snapshot?.openDeposits)) {
      extracted = extractFromDashboardSnapshot(snapshot);
    } else {
      sourceText = snapshotRaw;
    }
  }

  if (!extracted && (!sourceText || sourceText.trim().length < 40)) {
    throw new Error('Source text is too short to extract FD data');
  }

  if (!extracted) {
    extracted = await extractWithAI(sourceText, sourceName, captureMode);
  }

  const deposits = Array.isArray(extracted.deposits) ? extracted.deposits : [];

  const normalizedDeposits = deposits.map((fd: any, index: number) => {
    const principal = toNumber(fd.principal_amount, 0);
    const maturityValueRaw = fd.maturity_value === null || fd.maturity_value === undefined
      ? null
      : toNumber(fd.maturity_value, 0);

    return {
      bank: 'hdfc',
      fd_number: String(fd.fd_number || '').trim() || null,
      account_number: fd.account_number ? String(fd.account_number).trim() : null,
      principal_amount: principal,
      interest_rate: toNumber(fd.interest_rate, 0),
      tenure_months: toInt(fd.tenure_months),
      start_date: toIsoDate(fd.start_date),
      maturity_date: toIsoDate(fd.maturity_date),
      maturity_value: maturityValueRaw,
      status: normalizeStatus(fd.status),
      auto_renewal: toBoolean(fd.auto_renewal),
      notes: fd.notes ? String(fd.notes).trim() : null,
      source_index: index,
    };
  });

  const output = {
    extractedAt: new Date().toISOString(),
    source: metadata.source || 'hdfc_deposits_portal',
    sourceName,
    captureMode,
    pageCount,
    customer_name: extracted.customer_name || '',
    as_of_date: toIsoDate(extracted.as_of_date),
    totalExtracted: normalizedDeposits.length,
    deposits: normalizedDeposits,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  const totalPrincipal = normalizedDeposits.reduce((sum: number, fd: { principal_amount: number }) => {
    return sum + (fd.principal_amount || 0);
  }, 0);
  console.log(`Extracted deposits: ${normalizedDeposits.length}`);
  console.log(`Total principal (raw): ${totalPrincipal.toLocaleString('en-IN')}`);
  console.log(`Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  extractHdfcFd().catch((error: any) => {
    console.error('Error:', error.message || error);
    process.exit(1);
  });
}
