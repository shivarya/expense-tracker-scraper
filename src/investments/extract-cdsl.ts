/**
 * Extract stocks and mutual funds from CDSL PDF using AI
 */

import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { PDFParse } from 'pdf-parse';
import { fileURLToPath } from 'url';

dotenv.config();

const INPUT_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'cdsl-holdings.json');

// Load PDF passwords
let pdfPasswords: string[] = [];
try {
  const passwordsPath = path.join(process.cwd(), 'src', 'config', 'pdf-passwords.json');
  const passwordsData = await fs.readFile(passwordsPath, 'utf-8');
  pdfPasswords = JSON.parse(passwordsData);
} catch (error) {
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

async function parsePDFWithAI(pdfText: string, filename: string): Promise<any> {
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

  const systemPrompt = `You are a financial data extraction assistant. Extract ALL holdings from CDSL consolidated account statements (eCAS) containing BOTH stocks and mutual funds.

Return ONLY a JSON object (no markdown, no code blocks):

{
  "account_number": "DP ID or Client ID",
  "investor_name": "investor name",
  "statement_date": "YYYY-MM-DD",
  "stocks": [
    {
      "isin": "ISIN code (mandatory - e.g., INE002A01018)",
      "company_name": "company name",
      "symbol": "stock symbol if available",
      "quantity": number (current/closing balance),
      "price": number (market/closing price),
      "value": number (market value)
    }
  ],
  "mutual_funds": [
    {
      "folio": "folio number (mandatory)",
      "fund_name": "complete scheme name",
      "amc": "AMC name (e.g., HDFC, ICICI Prudential)",
      "units": number (closing balance units),
      "nav": number (NAV per unit),
      "amount": number (closing balance amount)
    }
  ]
}

CRITICAL:
1. Extract CURRENT holdings only (not transactions)
2. For stocks: Look for "Equity Statement", "Demat Holdings" sections
3. For mutual funds: Look for "Mutual Fund", "MF Folios" sections
4. ISIN is mandatory for stocks, Folio is mandatory for mutual funds
5. Extract ALL holdings - don't skip any
6. If section missing, return empty array`;

  const userPrompt = `File: ${filename}\n\nExtract all holdings:\n\n${pdfText.substring(0, 25000)}`;

  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      max_completion_tokens: 5000
    });

    const content = response.choices[0].message.content?.trim() || '{}';
    
    // Remove markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : content;
    
    return JSON.parse(jsonStr);
  } catch (error: any) {
    console.error(`❌ AI parsing failed: ${error.message}`);
    return { stocks: [], mutual_funds: [] };
  }
}

async function extractCDSL() {
  console.log('🚀 Extracting CDSL Holdings from PDF\n');
  console.log('━'.repeat(60));

  // Find latest CDSL PDF
  const files = await fs.readdir(INPUT_DIR);
  const cdslFiles = files
    .filter(f => f.startsWith('cdsl_') && f.endsWith('.pdf'))
    .sort()
    .reverse();

  if (cdslFiles.length === 0) {
    console.error('\n❌ No CDSL PDF files found in data/raw-extracts/');
    console.error('   Run: npm run cdsl:download first');
    process.exit(1);
  }

  const pdfFile = cdslFiles[0];
  const pdfPath = path.join(INPUT_DIR, pdfFile);
  
  console.log(`\n📄 Processing: ${pdfFile}`);

  let pdfData = await fs.readFile(pdfPath);
  let pdfText = '';

  // Try to parse PDF
  try {
    const result = await parsePDF(pdfData);
    pdfText = result.text;
    console.log(`   ✅ Extracted ${result.text.length} characters from ${result.pages} pages`);
  } catch (pdfError: any) {
    // Check if encrypted
    if (pdfError.message?.includes('Encrypted') || pdfError.message?.includes('password')) {
      console.log(`   🔒 PDF is encrypted, attempting decryption...`);

      const { decrypt } = await import('node-qpdf2');
      let decrypted = false;
      const decryptedPath = pdfPath.replace('.pdf', '_decrypted.pdf');

      for (const pwd of pdfPasswords) {
        try {
          console.log(`   🔑 Trying password: ${pwd}`);
          await decrypt({
            input: pdfPath,
            output: decryptedPath,
            password: pwd
          });

          console.log(`   ✅ Decrypted successfully`);
          
          pdfData = await fs.readFile(decryptedPath);
          const result = await parsePDF(pdfData);
          pdfText = result.text;
          await fs.unlink(decryptedPath).catch(() => {});
          decrypted = true;
          break;
        } catch {
          continue;
        }
      }

      if (!decrypted) {
        console.error(`   ❌ All decryption attempts failed`);
        console.error(`   Add correct password to src/config/pdf-passwords.json`);
        process.exit(1);
      }
    } else {
      throw pdfError;
    }
  }

  // Parse with AI
  console.log(`\n🤖 Analyzing with AI...`);
  const parsed = await parsePDFWithAI(pdfText, pdfFile);

  const stocks = parsed.stocks || [];
  const mutualFunds = parsed.mutual_funds || [];

  console.log(`   ✅ Found ${stocks.length} stocks`);
  console.log(`   ✅ Found ${mutualFunds.length} mutual funds`);

  // Save output
  const output = {
    extractedAt: new Date().toISOString(),
    source: 'CDSL eCAS',
    sourceFile: pdfFile,
    totalStocks: stocks.length,
    totalMutualFunds: mutualFunds.length,
    stocks: stocks.map((s: any) => ({
      isin: s.isin || '',
      symbol: s.symbol || s.isin?.substring(0, 10) || 'UNKNOWN',
      company_name: s.company_name || s.name || '',
      quantity: s.quantity || 0,
      price: s.price || 0,
      value: s.value || (s.quantity * s.price),
      platform: 'CDSL',
      statement_date: parsed.statement_date || new Date().toISOString().split('T')[0]
    })),
    mutualFunds: mutualFunds.map((mf: any) => ({
      folio: mf.folio || 'UNKNOWN',
      fund_name: mf.fund_name || mf.name || '',
      amc: mf.amc || extractAMC(mf.fund_name || mf.name || ''),
      units: mf.units || 0,
      nav: mf.nav || 0,
      amount: mf.amount || (mf.units * mf.nav),
      statement_date: parsed.statement_date || new Date().toISOString().split('T')[0]
    }))
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
  
  console.log(`\n📊 Summary:`);
  console.log(`   Total Stocks: ${output.totalStocks}`);
  console.log(`   Total Mutual Funds: ${output.totalMutualFunds}`);
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
  console.log('\n' + '━'.repeat(60));

  return output;
}

function extractAMC(fundName: string): string {
  const amcPatterns: Record<string, RegExp> = {
    'HDFC': /HDFC/i,
    'ICICI Prudential': /ICICI/i,
    'SBI': /SBI/i,
    'Axis': /Axis/i,
    'Kotak': /Kotak/i,
    'Nippon India': /Nippon/i,
    'UTI': /UTI/i,
    'Aditya Birla Sun Life': /Aditya Birla/i,
    'DSP': /DSP/i,
    'Franklin Templeton': /Franklin/i,
    'Mirae Asset': /Mirae/i,
    'Tata': /Tata/i,
    'Motilal Oswal': /Motilal/i,
    'Parag Parikh': /Parag Parikh/i,
    'Edelweiss': /Edelweiss/i
  };

  for (const [amc, pattern] of Object.entries(amcPatterns)) {
    if (pattern.test(fundName)) {
      return amc;
    }
  }

  return 'Other';
}

// CLI execution
const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  extractCDSL().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  });
}
