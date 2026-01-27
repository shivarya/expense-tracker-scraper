import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import url from 'url';
import open from 'open';
import { createRequire } from 'module';
import OpenAI from 'openai';
import { fromSenders } from '../config/senders';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

// Load PDF passwords from JSON file
let pdfPasswords: string[] = [];
try {
  const passwordsPath = path.join(process.cwd(), 'src', 'config', 'pdf-passwords.json');
  const passwordsData = await fs.readFile(passwordsPath, 'utf-8');
  pdfPasswords = JSON.parse(passwordsData);
} catch (error) {
  console.warn('⚠️  Could not load pdf-passwords.json, will only try email-extracted passwords');
}

async function parsePDF(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result;
}

const gmail = google.gmail('v1');

export async function authenticateGmail(): Promise<any> {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
  );

  const tokenPath = path.join(process.cwd(), 'gmail-token.json');

  // Try to load existing token
  try {
    const token = await fs.readFile(tokenPath, 'utf-8');
    const credentials = JSON.parse(token);
    oauth2Client.setCredentials(credentials);

    // Test if token is valid
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      await gmail.users.getProfile({ userId: 'me' });

      // Set up automatic token refresh
      oauth2Client.on('tokens', async (tokens) => {
        if (tokens.refresh_token) {
          credentials.refresh_token = tokens.refresh_token;
        }
        credentials.access_token = tokens.access_token;
        credentials.expiry_date = tokens.expiry_date;
        await fs.writeFile(tokenPath, JSON.stringify(credentials, null, 2));
      });

      return oauth2Client;
    } catch (error: any) {
      if (error.code === 401 || error.message?.includes('invalid_grant')) {
        console.log('  ⚠️  Token expired, re-authenticating...');
        await fs.unlink(tokenPath).catch(() => { });
      } else {
        throw error;
      }
    }
  } catch (error) {
    // No token found or invalid
  }

  // Start OAuth flow
  console.log('  🔐 Gmail authorization required...');

  const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url!, true);

        if (parsedUrl.pathname === '/oauth2callback') {
          const code = parsedUrl.query.code as string;

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>❌ Authorization failed</h1>');
            server.close();
            reject(new Error('No authorization code received'));
            return;
          }

          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 50px; text-align: center;">
                <h1>✅ Gmail Authorization Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);

          console.log('  ✓ Gmail authenticated successfully');
          server.close();
          resolve(oauth2Client);
        }
      } catch (error: any) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>❌ Error: ${error.message}</h1>`);
        server.close();
        reject(error);
      }
    });

    server.listen(3000, () => {
      console.log('  → Opening browser for Gmail authorization...');
      open(authUrl).catch(() => {
        console.log(`  → Please open this URL in your browser:\n     ${authUrl}`);
      });
    });
  });
}

function extractPasswordFromEmail(body: string, subject: string): string | null {
  // Common password patterns in CAMS/KFintech emails
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

  // Check subject line too
  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

async function parsePDFWithAI(pdfText: string, subject: string): Promise<any> {
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

  const systemPrompt = `You are a financial data extraction assistant. Extract holdings from statements (stocks or mutual funds).

Detect the statement type and return ONLY a JSON object (no markdown, no code blocks):

For STOCK statements (CDSL/NSDL eCAS with ISIN codes):
{
  "type": "stocks",
  "account_number": "DP ID or account number",
  "investor_name": "name",
  "statement_date": "YYYY-MM-DD",
  "holdings": [
    {
      "isin": "ISIN code",
      "name": "company/security name",
      "quantity": number,
      "price": number,
      "value": number
    }
  ]
}

For MUTUAL FUND statements (CAMS/KFintech):
{
  "type": "mutual_funds",
  "account_number": "folio number",
  "investor_name": "name",
  "statement_date": "YYYY-MM-DD",
  "holdings": [
    {
      "name": "fund name",
      "units": number,
      "nav": number,
      "purchase_value": number,
      "current_value": number
    }
  ]
}`;

  const userPrompt = `Subject: ${subject}\n\nStatement Content:\n${pdfText.substring(0, 8000)}`;

  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      max_completion_tokens: 2000
    });

    const content = response.choices[0].message.content?.trim() || '{}';
    const parsed = JSON.parse(content);

    return parsed;
  } catch (error: any) {
    console.error(`    ✗ AI parsing failed: ${error.message}`);
    return { type: 'unknown', holdings: [] };
  }
}

export async function scrapeMutualFunds() {
  console.log('  → Authenticating with Gmail...');

  const mutualFunds = [];

  try {
    // Check last sync date to avoid re-downloading
    const syncStateFile = './data/sync-state.json';
    let lastMFSync = new Date('2025-01-01');
    try {
      const state = JSON.parse(await fs.readFile(syncStateFile, 'utf-8'));
      if (state.lastMFSyncTimestamp) {
        lastMFSync = new Date(state.lastMFSyncTimestamp);
      }
    } catch (e) {
      console.log('  → No previous sync state found, fetching all emails');
    }

    console.log(`  → Last MF sync: ${lastMFSync.toISOString()}`);
    let messages = [];
    interface GmailListMessage {
      id?: string;
      threadId?: string;
    }

    interface PdfParseResult {
      text: string;
      [key: string]: any;
    }

    interface Holding {
      name: string;
      units?: number;
      nav?: number;
      purchase_value?: number;
      current_value?: number;
      [key: string]: any;
    }

    interface AIAggregatedResult {
      account_number?: string;
      investor_name?: string;
      statement_date?: string;
      holdings?: Holding[];
      [key: string]: any;
    }

    interface MutualFundRecord {
      fund_name: string;
      amc: string;
      folio_number: string;
      units: number;
      nav: number;
      invested_amount: number;
      current_value: number;
    }

    messages = [] as GmailListMessage[];
    try {


      // Authenticate (handles token refresh or new auth automatically)
      const oauth2Client = await authenticateGmail();
      google.options({ auth: oauth2Client });

      // Search for CAMS/KFintech emails (only new ones since last sync)
      console.log('  → Searching for mutual fund statements...');
      const dateFilter = `after:${Math.floor(lastMFSync.getTime() / 1000)}`;

      const camQuery = `${fromSenders.map(s => `from:${s}`).join(' OR ')} subject:statement ${dateFilter}`;
      console.log('Gmail query:', camQuery);
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: camQuery,
        maxResults: 50
      });
      console.log(response.data);
      messages = response.data.messages || [];
      console.log(`  → Found ${messages.length} emails`);
    } catch (error) {
      console.error('  ✗ Gmail API error:', error);
    }


    // Download and parse each statement
    for (const message of messages.slice(0, 10)) { // Limit to 10 most recent
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: message.id!,
          format: 'full'
        });

        // Extract email body to find password
        let emailBody = '';
        let subject = '';

        const headers = msg.data.payload?.headers || [];
        for (const header of headers) {
          if (header.name === 'Subject') {
            subject = header.value || '';
          }
        }

        // Get email body
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
          if (part.filename && part.filename.endsWith('.pdf') && part.body?.attachmentId) {
            console.log(`  → Processing ${part.filename}...`);

            const attachment = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: message.id!,
              id: part.body.attachmentId
            });

            // Save and parse PDF
            const data = Buffer.from(attachment.data.data!, 'base64');
            const pdfPath = path.join(process.cwd(), 'data', 'mf-statements', part.filename);
            await fs.mkdir(path.dirname(pdfPath), { recursive: true });
            await fs.writeFile(pdfPath, data);

            console.log(`    ✓ Saved to ${pdfPath}`);

            try {
              // Try to parse PDF directly first
              let pdfText = '';

              try {
                const result = await parsePDF(data);
                pdfText = result.text;
              } catch (pdfError: any) {
                // If encrypted, try to decrypt with password(s)
                if (pdfError.message.includes('Encrypted') || pdfError.message.includes('password')) {
                  console.log(`    → PDF is encrypted, attempting decryption...`);

                  // Build password list to try: email-extracted password first, then common passwords
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
                      
                      // Parse the decrypted PDF
                      const decryptedData = await fs.readFile(decryptedPath);
                      const result = await parsePDF(decryptedData);
                      pdfText = result.text;
                      await fs.unlink(decryptedPath).catch(() => { });
                      decrypted = true;
                      break;
                    } catch (decryptError: any) {
                      // Try next password
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
              const aiResult = await parsePDFWithAI(pdfText, subject);

              if (aiResult.holdings && aiResult.holdings.length > 0) {
                if (aiResult.type === 'stocks') {
                  console.log(`    ✓ Found ${aiResult.holdings.length} stock holdings`);
                  
                  for (const holding of aiResult.holdings) {
                    mutualFunds.push({
                      type: 'stock',
                      isin: holding.isin || '',
                      name: holding.name,
                      quantity: holding.quantity || 0,
                      price: holding.price || 0,
                      value: holding.value || 0,
                      statement_date: aiResult.statement_date || ''
                    });
                  }
                } else if (aiResult.type === 'mutual_funds') {
                  console.log(`    ✓ Found ${aiResult.holdings.length} mutual fund holdings`);

                  for (const holding of aiResult.holdings) {
                    mutualFunds.push({
                      type: 'mutual_fund',
                      fund_name: holding.name,
                      amc: extractAMC(holding.name),
                      folio_number: aiResult.account_number || 'XXXXX',
                      units: holding.units || 0,
                      nav: holding.nav || 0,
                      invested_amount: holding.purchase_value || 0,
                      current_value: holding.current_value || 0
                    });
                  }
                } else {
                  console.log(`    ⚠️  Unknown statement type: ${aiResult.type}`);
                }
              } else {
                console.log(`    ⚠️  No holdings found in PDF`);
              }
            } catch (pdfError: any) {
              console.error(`    ✗ PDF parsing error: ${pdfError.message}`);

              if (pdfError.message.includes('Encrypted') || pdfError.message.includes('password')) {
                console.log(`    ⚠️  PDF is password-protected and decryption failed`);
                if (password) {
                  console.log(`    → Attempted with password: ${password}`);
                } else {
                  console.log(`    → No password found in email`);
                }
              }
            }
          }
        }
      } catch (error: any) {
        console.error(`  ✗ Error processing message: ${error.message}`);
      }
    }

  } catch (error: any) {
    console.error('  ✗ Gmail error:', error.message);
  }

  return mutualFunds;
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
  };

  for (const [amc, pattern] of Object.entries(amcPatterns)) {
    if (pattern.test(fundName)) {
      return amc;
    }
  }

  return 'Other';
}
