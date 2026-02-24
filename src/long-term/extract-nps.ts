import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { PDFParse } from 'pdf-parse';
import { fileURLToPath } from 'url';

dotenv.config();

const INPUT_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'nps-raw.json');

let pdfPasswords: string[] = [];
try {
  const passwordsPath = path.join(process.cwd(), 'src', 'config', 'pdf-passwords.json');
  const passwordsData = await fs.readFile(passwordsPath, 'utf-8');
  pdfPasswords = JSON.parse(passwordsData);
} catch {
  pdfPasswords = [];
}

async function parsePDF(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return {
      text: result.text,
      pages: result.total
    };
  } finally {
    await parser.destroy();
  }
}

async function parseNpsWithAI(pdfText: string, filename: string): Promise<any> {
  const isAzure = !!process.env.AZURE_OPENAI_ENDPOINT;

  const openai = new OpenAI(
    isAzure
      ? {
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseURL: process.env.AZURE_OPENAI_ENDPOINT,
      }
      : {
        apiKey: process.env.OPENAI_API_KEY
      }
  );

  const model = isAzure
    ? process.env.AZURE_OPENAI_DEPLOYMENT!
    : (process.env.OPENAI_MODEL || 'gpt-4-turbo');

  const systemPrompt = `You extract NPS statement data from India NPS account statements.

Return ONLY valid JSON with this exact shape:
{
  "account_name": "string",
  "pran_number": "string",
  "account_number": "string",
  "tier": "Tier I|Tier II|Unknown",
  "statement_period": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
  "as_on_date": "YYYY-MM-DD",
  "opening_balance": number,
  "total_contribution": number,
  "employee_contribution": number,
  "employer_contribution": number,
  "interest_earned": number,
  "closing_balance": number,
  "current_value": number,
  "last_contribution_date": "YYYY-MM-DD",
  "status": "active|matured|closed"
}

Rules:
1. Use 0 for missing numeric values.
2. Use empty string for unknown text fields.
3. Normalize dates to YYYY-MM-DD when possible; otherwise empty string.
4. If both closing balance and current value are present, set both.
5. Avoid markdown/code fences.`;

  const userPrompt = `File: ${filename}\n\nExtract NPS statement values:\n\n${pdfText.substring(0, 28000)}`;

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0,
    max_completion_tokens: 3000
  });

  const content = response.choices[0].message.content?.trim() || '{}';
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : content;
  return JSON.parse(jsonStr);
}

async function extractNps() {
  console.log('🚀 Extracting NPS statement\n');
  console.log('━'.repeat(60));

  const files = await fs.readdir(INPUT_DIR);
  const npsFiles = files
    .filter((f) => f.startsWith('nps_') && f.endsWith('.pdf'))
    .sort()
    .reverse();

  if (npsFiles.length === 0) {
    throw new Error('No NPS PDF found in data/raw-extracts. Run: npm run nps:download');
  }

  const pdfFile = npsFiles[0];
  const pdfPath = path.join(INPUT_DIR, pdfFile);
  console.log(`📄 Processing: ${pdfFile}`);

  let pdfData = await fs.readFile(pdfPath);
  let pdfText = '';

  try {
    const result = await parsePDF(pdfData);
    pdfText = result.text;
    console.log(`✅ Parsed ${result.pages} page(s), ${result.text.length} characters`);
  } catch (pdfError: any) {
    if (pdfError.message?.includes('Encrypted') || pdfError.message?.includes('password')) {
      console.log('🔒 PDF encrypted, trying configured passwords...');
      const { decrypt } = await import('node-qpdf2');
      const decryptedPath = pdfPath.replace('.pdf', '_decrypted.pdf');
      let decrypted = false;

      for (const pwd of pdfPasswords) {
        try {
          await decrypt({ input: pdfPath, output: decryptedPath, password: pwd });
          const decryptedData = await fs.readFile(decryptedPath);
          const result = await parsePDF(decryptedData);
          pdfText = result.text;
          await fs.unlink(decryptedPath).catch(() => {});
          decrypted = true;
          console.log('✅ Decrypted and parsed successfully');
          break;
        } catch {
          continue;
        }
      }

      if (!decrypted) {
        throw new Error('Unable to decrypt NPS PDF with configured passwords');
      }
    } else {
      throw pdfError;
    }
  }

  console.log('🤖 Extracting NPS fields with AI...');
  const parsed = await parseNpsWithAI(pdfText, pdfFile);

  const output = {
    extractedAt: new Date().toISOString(),
    source: 'NPS Statement Email',
    sourceSender: 'nps-statements@mailer.proteantech.in',
    sourceFile: pdfFile,
    nps: {
      account_name: parsed.account_name || '',
      pran_number: parsed.pran_number || '',
      account_number: parsed.account_number || '',
      tier: parsed.tier || 'Unknown',
      statement_period: {
        from: parsed.statement_period?.from || '',
        to: parsed.statement_period?.to || ''
      },
      as_on_date: parsed.as_on_date || '',
      opening_balance: Number(parsed.opening_balance || 0),
      total_contribution: Number(parsed.total_contribution || 0),
      employee_contribution: Number(parsed.employee_contribution || 0),
      employer_contribution: Number(parsed.employer_contribution || 0),
      interest_earned: Number(parsed.interest_earned || 0),
      closing_balance: Number(parsed.closing_balance || 0),
      current_value: Number(parsed.current_value || parsed.closing_balance || 0),
      last_contribution_date: parsed.last_contribution_date || '',
      status: parsed.status || 'active'
    }
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`✅ Saved: ${OUTPUT_FILE}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  extractNps().catch((error: any) => {
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
  });
}
