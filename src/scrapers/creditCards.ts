import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import OpenAI from 'openai';
import { creditCardSenders } from '../config/senders';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const gmail = google.gmail('v1');

// Load PDF passwords
let pdfPasswords: string[] = [];
try {
  const passwordsPath = path.join(process.cwd(), 'src', 'config', 'pdf-passwords.json');
  const passwordsData = await fs.readFile(passwordsPath, 'utf-8');
  pdfPasswords = JSON.parse(passwordsData);
} catch (error) {
  console.warn('⚠️  Could not load pdf-passwords.json for credit card statements');
}

async function parsePDF(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result;
}

function extractPasswordFromEmail(body: string, subject: string): string | null {
  const patterns = [
    /password[:\s]+([A-Za-z0-9]+)/i,
    /pwd[:\s]+([A-Za-z0-9]+)/i,
    /pass[:\s]+([A-Za-z0-9]+)/i,
    /protected with[:\s]+([A-Za-z0-9]+)/i,
    /open with[:\s]+([A-Za-z0-9]+)/i,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

async function parseStatementWithAI(pdfText: string, subject: string): Promise<any> {
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

  const systemPrompt = `You are a financial data extraction assistant. Extract credit card transactions from the statement.

Return ONLY a JSON object (no markdown, no code blocks) with this structure:
{
  "card_number": "last 4 digits",
  "card_holder": "name on card",
  "statement_date": "YYYY-MM-DD",
  "statement_period": "MMM YYYY - MMM YYYY",
  "bank": "bank name (e.g., HDFC, ICICI, SBI, Axis, etc.)",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "merchant/transaction description",
      "amount": number (positive for debits/expenses, negative for credits/refunds),
      "type": "debit" or "credit",
      "reference": "reference number if available",
      "category": "category hint from description (optional)"
    }
  ]
}

Important:
- Extract ALL transactions from the statement
- Use positive amounts for debits (expenses) and negative amounts for credits (refunds/reversals)
- Parse dates to YYYY-MM-DD format
- Include reference numbers when available
- Clean up merchant names (remove extra spaces, codes)`;

  const userPrompt = `Subject: ${subject}\n\nCredit Card Statement:\n${pdfText.substring(0, 12000)}`;

  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      max_completion_tokens: 3000
    });

    const content = response.choices[0].message.content?.trim() || '{}';
    const parsed = JSON.parse(content);

    return parsed;
  } catch (error: any) {
    console.error(`    ✗ AI parsing failed: ${error.message}`);
    return { transactions: [] };
  }
}

export async function scrapeCreditCards(oauth2Client: any) {
  console.log('  → Fetching credit card statements from Gmail...');

  const transactions = [];

  try {
    google.options({ auth: oauth2Client });

    // Check last sync date
    const syncStateFile = './data/sync-state.json';
    let lastCCSync = new Date('2025-01-01');
    try {
      const state = JSON.parse(await fs.readFile(syncStateFile, 'utf-8'));
      if (state.lastCCStatementSyncTimestamp) {
        lastCCSync = new Date(state.lastCCStatementSyncTimestamp);
      }
    } catch (e) {
      console.log('  → No previous credit card sync state, fetching all emails');
    }

    console.log(`  → Last CC statement sync: ${lastCCSync.toISOString()}`);
    const dateFilter = `after:${Math.floor(lastCCSync.getTime() / 1000)}`;

    // Build query for credit card statements
    const ccQuery = `${creditCardSenders.map(s => `from:${s}`).join(' OR ')} (subject:statement OR subject:"credit card") has:attachment ${dateFilter}`;
    console.log('  → Gmail query:', ccQuery);

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: ccQuery,
      maxResults: 50
    });

    const messages = response.data.messages || [];
    console.log(`  → Found ${messages.length} credit card statement emails`);

    for (const message of messages.slice(0, 10)) {
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: message.id!,
          format: 'full'
        });

        // Extract email body and subject
        let emailBody = '';
        let subject = '';

        const headers = msg.data.payload?.headers || [];
        for (const header of headers) {
          if (header.name === 'Subject') {
            subject = header.value || '';
          }
        }

        const payload = msg.data.payload;
        if (payload?.body?.data) {
          emailBody = Buffer.from(payload.body.data, 'base64').toString('utf-8');
        } else if (payload?.parts) {
          for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
              emailBody += Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
          }
        }

        const password = extractPasswordFromEmail(emailBody, subject);
        if (password) {
          console.log(`    → Found password hint: ${password}`);
        }

        // Look for PDF attachments
        const parts = msg.data.payload?.parts || [];
        for (const part of parts) {
          if (part.filename && part.filename.toLowerCase().endsWith('.pdf') && part.body?.attachmentId) {
            console.log(`  → Processing ${part.filename}...`);

            const attachment = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: message.id!,
              id: part.body.attachmentId
            });

            const data = Buffer.from(attachment.data.data!, 'base64');
            const pdfPath = path.join(process.cwd(), 'data', 'cc-statements', part.filename);
            await fs.mkdir(path.dirname(pdfPath), { recursive: true });
            await fs.writeFile(pdfPath, data);

            console.log(`    ✓ Saved to ${pdfPath}`);

            try {
              let pdfText = '';

              try {
                const result = await parsePDF(data);
                pdfText = result.text;
              } catch (pdfError: any) {
                if (pdfError.message.includes('Encrypted') || pdfError.message.includes('password')) {
                  console.log(`    → PDF is encrypted, attempting decryption...`);

                  const passwordsToTry = password ? [password, ...pdfPasswords] : pdfPasswords;
                  let decrypted = false;
                  const { decrypt } = require('node-qpdf2');
                  const decryptedPath = pdfPath.replace('.pdf', '_decrypted.pdf');

                  for (const pwd of passwordsToTry) {
                    try {
                      console.log(`    → Trying password: ${pwd}`);
                      await decrypt({
                        input: pdfPath,
                        output: decryptedPath,
                        password: pwd
                      });

                      console.log(`    ✓ PDF decrypted successfully with password: ${pwd}`);

                      const decryptedData = await fs.readFile(decryptedPath);
                      const result = await parsePDF(decryptedData);
                      pdfText = result.text;
                      await fs.unlink(decryptedPath).catch(() => { });
                      decrypted = true;
                      break;
                    } catch (decryptError: any) {
                      continue;
                    }
                  }

                  if (!decrypted) {
                    console.error(`    ✗ All decryption attempts failed (tried ${passwordsToTry.length} passwords)`);
                    throw pdfError;
                  }
                } else {
                  throw pdfError;
                }
              }

              console.log(`    → Extracted ${pdfText.length} characters from PDF`);

              // Parse with AI
              console.log(`    → Parsing with AI...`);
              const statementData = await parseStatementWithAI(pdfText, subject);

              if (statementData.transactions && statementData.transactions.length > 0) {
                console.log(`    ✓ Found ${statementData.transactions.length} transactions`);

                for (const txn of statementData.transactions) {
                  transactions.push({
                    date: txn.date,
                    amount: Math.abs(txn.amount), // Ensure positive
                    type: txn.type === 'credit' ? 'credit' : 'debit',
                    merchant: txn.description,
                    category: txn.category || 'Other',
                    bank: statementData.bank || 'Unknown',
                    account_number: `CC-${statementData.card_number || 'XXXX'}`,
                    reference_number: txn.reference || null,
                    source: 'credit_card_statement',
                    source_data: {
                      statement_file: part.filename,
                      statement_period: statementData.statement_period,
                      card_holder: statementData.card_holder
                    }
                  });
                }
              } else {
                console.log(`    ⚠️  No transactions found in statement`);
              }
            } catch (pdfError: any) {
              console.error(`    ✗ PDF parsing error: ${pdfError.message}`);
            }
          }
        }
      } catch (error: any) {
        console.error(`  ✗ Error processing message: ${error.message}`);
      }
    }

    // Update sync state
    try {
      let state: any = {};
      try {
        state = JSON.parse(await fs.readFile(syncStateFile, 'utf-8'));
      } catch (e) {
        // File doesn't exist, create new state
      }
      state.lastCCStatementSyncTimestamp = new Date().toISOString();
      await fs.writeFile(syncStateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('  ✗ Error updating sync state:', error);
    }

  } catch (error: any) {
    console.error('  ✗ Gmail error:', error.message);
  }

  return transactions;
}
