/**
 * Multi-Bank Credit Card Statement Scraper
 * 
 * Supports: ICICI Bank, RBL Bank
 * 
 * Workflow:
 * 1. Search Gmail for credit card statement emails (ICICI + RBL)
 * 2. Download PDF attachments
 * 3. Decrypt PDFs using configured passwords
 * 4. Parse PDF to extract transaction details
 * 5. Enrich with metadata for LLM analysis (categories, merchant info)
 * 6. Save to JSON or sync directly to PHP server
 * 
 * Usage:
 *   npm run fetch:cc        # Fetch and save to JSON
 *   npm run sync:cc         # Fetch and sync to server
 */

import { getGmailClient } from '../utils/gmail';
import { extractTextFromPDF } from '../utils/pdf';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { decrypt } from 'node-qpdf2';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadPasswords(): Promise<string[]> {
  try {
    const pwdFile = path.join(__dirname, '../config/pdf-passwords.json');
    const content = await fs.readFile(pwdFile, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.log('  ⚠️  No password file found, will try without decryption');
    return [];
  }
}

async function decryptPDF(pdfPath: string, passwords: string[]): Promise<string> {
  const decryptedPath = pdfPath.replace('.pdf', '_decrypted.pdf');
  
  for (const pwd of passwords) {
    try {
      console.log(`  🔓 Trying password: ${pwd.substring(0, 4)}***`);
      await decrypt({ input: pdfPath, output: decryptedPath, password: pwd });
      console.log(`  ✓ Decrypted successfully with password: ${pwd}`);
      return decryptedPath;
    } catch (err: any) {
      // Check if file was created despite error (qpdf sometimes throws even on success)
      try {
        await fs.access(decryptedPath);
        const stats = await fs.stat(decryptedPath);
        if (stats.size > 0) {
          console.log(`  ✓ Decryption succeeded with warnings (password: ${pwd})`);
          return decryptedPath;
        }
      } catch {
        // File doesn't exist or is empty, continue to next password
      }
      console.log(`  ✗ Failed with error: ${err.message || err}`);
      // Try next password
    }
  }
  
  console.log('  ⚠️  Could not decrypt PDF, trying to parse as-is');
  return pdfPath;
}

interface CreditCardTransaction {
  date: string;
  description: string;
  amount: number;
  type: 'debit' | 'credit';
  rawText?: string;
  cardLast4?: string;
  // Enhanced metadata for LLM analysis
  merchantName?: string;
  merchantCategory?: string;
  transactionCategory?: 'food' | 'travel' | 'shopping' | 'entertainment' | 'utilities' | 'healthcare' | 'fuel' | 'other';
  isEMI?: boolean;
  isRecurring?: boolean;
  location?: string;
}

interface StatementData {
  cardNumber: string;
  bankName: 'ICICI' | 'RBL' | 'unknown';
  cardType?: string; // e.g., 'Rubyx', 'Amazon Pay', etc.
  statementMonth: string;
  statementYear: string;
  statementPeriod?: string;
  transactions: CreditCardTransaction[];
  totalSpent: number;
  dueDate?: string;
  minimumDue?: number;
  creditLimit?: number;
  availableCredit?: number;
}

async function searchStatementEmails(maxResults: number = 10) {
  console.log('🔍 Searching for credit card statement emails (ICICI + RBL)...');
  
  const gmail = await getGmailClient();
  
  // Combined search for both ICICI and RBL credit card statements
  const query = '{from:credit-cards@icicibank.com OR from:statements@rbl.bank.in OR from:@icicibank.com OR from:@rblbank.com} subject:statement has:attachment filename:pdf';
  
  console.log(`  Searching: "${query}"`);
  
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: maxResults * 2, // Increase to get statements from both banks
  });

  if (response.data.messages && response.data.messages.length > 0) {
    console.log(`✓ Found ${response.data.messages.length} statement email(s)`);
    return response.data.messages;
  }

  console.log('⚠️  No statement emails found');
  return [];
}

async function downloadPDFAttachment(messageId: string, outputDir: string) {
  console.log(`📧 Fetching email ${messageId}...`);
  
  const gmail = await getGmailClient();
  
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
  });

  if (!message.data.payload?.parts) {
    console.log('⚠️  No attachments found in email');
    return null;
  }

  // Find PDF attachment
  for (const part of message.data.payload.parts) {
    if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
      console.log(`📄 Found PDF: ${part.filename}`);
      
      if (part.body?.attachmentId) {
        const attachment = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: part.body.attachmentId,
        });

        if (attachment.data.data) {
          const buffer = Buffer.from(attachment.data.data, 'base64');
          const outputPath = path.join(outputDir, part.filename);
          
          await fs.writeFile(outputPath, buffer);
          console.log(`✓ Downloaded to: ${outputPath}`);
          
          return {
            filename: part.filename,
            path: outputPath,
            messageId,
          };
        }
      }
    }
  }

  return null;
}

async function parseICICIStatement(pdfPath: string, passwords: string[]): Promise<StatementData | null> {
  console.log(`📖 Parsing PDF: ${pdfPath}`);
  
  // Try to decrypt if passwords available
  let pathToParse = pdfPath;
  if (passwords.length > 0) {
    pathToParse = await decryptPDF(pdfPath, passwords);
  }
  
  const text = await extractTextFromPDF(pathToParse);
  
  if (!text) {
    console.log('⚠️  Could not extract text from PDF');
    return null;
  }

  console.log(`✓ Extracted ${text.length} characters from PDF`);
  
  // Debug: Save extracted text to file for inspection
  const debugPath = pathToParse.replace('.pdf', '_extracted.txt');
  await fs.writeFile(debugPath, text, 'utf-8');
  console.log(`📝 Saved extracted text to: ${debugPath}`);
  
  // Extract card number (last 4 digits)
  const cardMatch = text.match(/(\d{4})(?:XXXX|XXXXXXXX)(\d{4})|Card.*?(\d{4})/i);
  const cardLast4 = cardMatch ? (cardMatch[2] || cardMatch[3] || cardMatch[1]) : 'Unknown';

  // Detect bank and card type
  const { bankName, cardType, creditLimit, availableCredit, statementPeriod } = detectBankAndCardType(text, cardLast4);

  // Extract statement period
  const monthMatch = text.match(/Statement\s*(?:for|period|date)\s*[:\-]?\s*(\w+)\s*(\d{4})/i);
  const statementMonth = monthMatch ? monthMatch[1] : '';
  const statementYear = monthMatch ? monthMatch[2] : '';

  // Extract due date
  const dueDateMatch = text.match(/(?:Payment\s*)?Due\s*(?:Date|By)\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i);
  const dueDate = dueDateMatch ? dueDateMatch[1] : undefined;

  // Extract minimum due
  const minDueMatch = text.match(/Minimum\s*(?:Amount\s*)?Due\s*[:\-]?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+\.?\d*)/i);
  const minimumDue = minDueMatch ? parseFloat(minDueMatch[1].replace(/,/g, '')) : undefined;

  // Extract transactions
  const transactions = parseTransactions(text, cardLast4);

  const totalSpent = transactions
    .filter(t => t.type === 'debit')
    .reduce((sum, t) => sum + t.amount, 0);

  return {
    cardNumber: cardLast4,
    bankName,
    cardType,
    statementMonth,
    statementYear,
    statementPeriod,
    transactions,
    totalSpent,
    dueDate,
    minimumDue,
    creditLimit,
    availableCredit,
  };
}

function parseTransactions(text: string, cardLast4: string): CreditCardTransaction[] {
  const transactions: CreditCardTransaction[] = [];

  // Common patterns in credit card statements
  // RBL Pattern: DD MMM YYYY Description Amount
  // ICICI Pattern: DD/MM/YYYY Description Amount
  // Example: 26 Dec 2025 ADITYA BIRLA FASHION A BANGALORE IND 2,086.20
  // Example: 15/01/2026 SWIGGY BANGALORE 450.00

  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines and headers
    if (!line || line.includes('Date Description') || line.includes('Amount ₹')) {
      continue;
    }
    
    // Pattern 1: DD MMM YYYY format (RBL Bank)
    // Example: 26 Dec 2025 PAYMENT RECEIVED - BBPS 5,099.00
    const pattern1 = /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\s+(.+?)\s+([\d,]+\.\d{2})$/i;
    const match1 = line.match(pattern1);
    
    if (match1) {
      const [, date, description, amount] = match1;
      const isCr = description.toLowerCase().includes('payment received') || 
                   description.toLowerCase().includes('credit') ||
                   description.toLowerCase().includes('refund');
      
      transactions.push({
        date: normalizeDate(date),
        description: description.trim(),
        amount: parseFloat(amount.replace(/,/g, '')),
        type: isCr ? 'credit' : 'debit',
        rawText: line,
        cardLast4,
      });
      continue;
    }

    // Pattern 2: DD/MM/YYYY or DD-MM-YYYY format (ICICI Bank)
    const pattern2 = /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(.+?)\s+([\d,]+\.?\d*)\s*(Cr)?$/;
    const match2 = line.match(pattern2);
    
    if (match2) {
      const [, date, description, amount, isCr] = match2;
      
      transactions.push({
        date: normalizeDate(date),
        description: description.trim(),
        amount: parseFloat(amount.replace(/,/g, '')),
        type: isCr ? 'credit' : 'debit',
        rawText: line,
        cardLast4,
      });
      continue;
    }

    // Pattern 3: DD MMM YY format (short year)
    const pattern3 = /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2})\s+(.+?)\s+([\d,]+\.?\d*)\s*(Cr)?$/i;
    const match3 = line.match(pattern3);
    
    if (match3) {
      const [, date, description, amount, isCr] = match3;
      
      transactions.push({
        date: normalizeDate(date),
        description: description.trim(),
        amount: parseFloat(amount.replace(/,/g, '')),
        type: isCr ? 'credit' : 'debit',
        rawText: line,
        cardLast4,
      });
    }
  }

  console.log(`✓ Extracted ${transactions.length} transactions`);
  return transactions;
}

function normalizeDate(dateStr: string): string {
  // Convert various date formats to ISO format
  // DD/MM/YYYY, DD-MM-YYYY, DD MMM YY -> YYYY-MM-DD
  
  const patterns = [
    // DD/MM/YYYY or DD-MM-YYYY
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/,
    // DD/MM/YY or DD-MM-YY
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/,
    // DD MMM YY or DD MMM YYYY
    /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})$/i,
  ];

  const monthMap: { [key: string]: string } = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      let day = match[1].padStart(2, '0');
      let month: string;
      let year: string;

      if (pattern.source.includes('Jan|Feb')) {
        // DD MMM YY format
        month = monthMap[match[2].toLowerCase()];
        year = match[3].length === 2 ? `20${match[3]}` : match[3];
      } else {
        // DD/MM/YYYY or DD-MM-YYYY format
        month = match[2].padStart(2, '0');
        year = match[3].length === 2 ? `20${match[3]}` : match[3];
      }

      return `${year}-${month}-${day}`;
    }
  }

  return dateStr; // Return as-is if no pattern matches
}

function cleanMerchantName(description: string): string {
  // Remove common suffixes and clean merchant names
  let merchant = description.trim();
  
  // Extract merchant from UPI format: "125772565544 UPI-572628261960-Blinkit IN 5" -> "Blinkit"
  const upiMatch = merchant.match(/UPI-\d+-(.+?)(?:\sIN\s\d+)?$/i);
  if (upiMatch) {
    merchant = upiMatch[1].trim();
  }
  
  // Remove "IN X" pattern (store/terminal numbers)
  merchant = merchant.replace(/\sIN\s\d+$/i, '');
  
  // Remove location suffixes (city names, state codes, country codes)
  merchant = merchant.replace(/\s+(BANGALORE|BENGALURU|MUMBAI|DELHI|CHENNAI|KOLKATA|PUNE|HYDERABAD|RAMESWARAM|TAM|KAR|IND|MH|DL|TN|DELHI NCR|GURGAON|NOIDA|GHAZIABAD)$/i, '');
  
  // Remove common payment prefixes
  merchant = merchant.replace(/^(WLI\*|UPI-|NEFT-|IMPS-|PAYMENT TO |\d+\s+)/i, '');
  
  // Fix common merchant name patterns
  merchant = merchant.replace(/MC\sDONAL\sDS/i, "McDonald's");
  merchant = merchant.replace(/MOKSH\sME\sDICALS/i, 'Moksh Medicals');
  merchant = merchant.replace(/SHREENIV\sASA/i, 'Shreenivas');
  
  // Clean up multiple spaces
  merchant = merchant.replace(/\s+/g, ' ').trim();
  
  // Capitalize first letter of each word (unless already properly cased like McDonald's)
  if (!merchant.match(/[A-Z][a-z]+[A-Z]/)) {
    merchant = merchant.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
  }
  
  return merchant;
}

function cleanDescription(description: string): string {
  // Create a more readable description from raw transaction text
  let cleaned = description.trim();
  
  // Extract merchant name and format nicely
  const merchant = cleanMerchantName(description);
  
  // If it's a UPI transaction, format as "Payment to [Merchant]"
  if (description.includes('UPI-')) {
    return `Payment to ${merchant}`;
  }
  
  // If it has IN X pattern (terminal number), format as "Purchase at [Merchant]"
  if (description.match(/\sIN\s\d+$/i)) {
    return `Purchase at ${merchant}`;
  }
  
  // Clean up multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  return cleaned;
}

function generateSmartDescription(txn: CreditCardTransaction, metadata: { bankName?: string, cardNumber?: string }): string {
  const merchant = cleanMerchantName(txn.description);
  const amount = txn.amount.toFixed(2);
  const type = txn.type === 'credit' ? 'Refund/Credit' : 'Payment';
  
  // Detect merchant category
  const desc = txn.description.toUpperCase();
  
  // Generate context-aware description
  if (desc.includes('PAYMENT RECEIVED') || desc.includes('BBPS')) {
    return `${type} received via ${merchant}`;
  }
  
  // Food & Dining
  if (desc.match(/SWIGGY|ZOMATO|BLINKIT|GROCERIES|SUPERMARKET/)) {
    if (desc.includes('BLINKIT')) {
      return `Grocery delivery from ${merchant}`;
    }
    return `Food delivery order from ${merchant}`;
  }
  if (desc.match(/MCDONAL|DOMINO|KFC|SUBWAY|PIZZA|DUNKIN/)) {
    return `Dining at ${merchant}`;
  }
  if (desc.match(/RESTAURANT|CAFE|HOTEL.*(?:BANGALORE|MUMBAI|DELHI)/)) {
    return `Dining at ${merchant}`;
  }
  
  // Travel
  if (desc.match(/MAKEMYTRIP|CLEARTRIP|GOIBIBO/)) {
    return `Travel booking via ${merchant}`;
  }
  if (desc.match(/INDIGO|SPICEJET|AIRASIA|VISTARA/)) {
    return `Flight ticket - ${merchant}`;
  }
  if (desc.match(/UBER|OLA|RAPIDO/)) {
    return `Ride booking - ${merchant}`;
  }
  if (desc.match(/OYO|HOTEL/)) {
    return `Hotel booking - ${merchant}`;
  }
  
  // Shopping
  if (desc.match(/AMAZON|FLIPKART/)) {
    return `Online shopping - ${merchant}`;
  }
  if (desc.match(/MYNTRA|AJIO|MEESHO|WESTSIDE|LIFESTYLE.*FASHION/)) {
    return `Fashion purchase from ${merchant}`;
  }
  if (desc.match(/METRO\sBRANDS|LUGGAGE|CLOTHING/)) {
    return `Shopping at ${merchant}`;
  }
  
  // Entertainment
  if (desc.match(/BOOKMYSHOW|CINEPOLIS|PVR/)) {
    return `Movie ticket - ${merchant}`;
  }
  if (desc.match(/NETFLIX|PRIME|HOTSTAR|SPOTIFY/)) {
    return `Subscription - ${merchant}`;
  }
  
  // Utilities
  if (desc.match(/BBPS|RECHARGE/)) {
    return `Bill payment via ${merchant}`;
  }
  if (desc.match(/JIO|AIRTEL|VODAFONE|VI\s/)) {
    return `Mobile recharge - ${merchant}`;
  }
  
  // Healthcare
  if (desc.match(/1MG|PHARMEASY|NETMEDS|APOLLO/)) {
    return `Medicine purchase from ${merchant}`;
  }
  
  // Fuel
  if (desc.match(/FUEL|PETROL|DIESEL|HP\s|IOCL|SHELL/)) {
    return `Fuel purchase at ${merchant}`;
  }
  
  // UPI payments
  if (desc.match(/UPI-\d+/)) {
    return `UPI payment to ${merchant}`;
  }
  
  // Default
  return `Purchase at ${merchant}`;
}

/**
 * Enrich transaction with metadata for better LLM analysis
 */
function enrichTransaction(txn: CreditCardTransaction): CreditCardTransaction {
  const desc = txn.description.toUpperCase();
  
  // Extract merchant name (clean up UPI references)
  let merchantName = txn.description;
  const upiMatch = desc.match(/UPI-\d+-(.+?)(?:\sIN)?$/);
  if (upiMatch) {
    merchantName = upiMatch[1].trim().replace(/\s+/g, ' ');
  }
  
  // Categorize merchant
  let merchantCategory: string = 'other';
  let transactionCategory: CreditCardTransaction['transactionCategory'] = 'other';
  
  // Food & Dining
  if (desc.match(/SWIGGY|ZOMATO|BLINKIT|DUNKIN|RESTAURANT|CAFE|HOTEL|MCDONAL|DOMINO|KFC|SUBWAY|PIZZA|FOOD|DINING/)) {
    merchantCategory = 'food_delivery';
    transactionCategory = 'food';
  }
  // Travel
  else if (desc.match(/MAKEMYTRIP|CLEARTRIP|GOIBIBO|INDIGO|SPICEJET|AIRASIA|VISTARA|OYO|HOTEL|UBER|OLA|RAPIDO|AIRLINE/)) {
    merchantCategory = 'travel_transport';
    transactionCategory = 'travel';
  }
  // Shopping
  else if (desc.match(/AMAZON|FLIPKART|MYNTRA|AJIO|MEESHO|WESTSIDE|LIFESTYLE|FASHION|RELIANCE|METRO\sBRANDS|FIRSTCRY|LUGGAGE|CLOTHING/)) {
    merchantCategory = 'retail_shopping';
    transactionCategory = 'shopping';
  }
  // Entertainment
  else if (desc.match(/BOOKMYSHOW|CINEPOLIS|PVR|NETFLIX|PRIME|HOTSTAR|SPOTIFY|YOUTUBE|GAMING/)) {
    merchantCategory = 'entertainment';
    transactionCategory = 'entertainment';
  }
  // Utilities & Bills
  else if (desc.match(/BBPS|JIO|AIRTEL|VODAFONE|VI\s|ELECTRICITY|GAS|WATER|BROADBAND|DTH|RECHARGE/)) {
    merchantCategory = 'utilities_bills';
    transactionCategory = 'utilities';
  }
  // Healthcare
  else if (desc.match(/MEDICAL|PHARMACY|HOSPITAL|CLINIC|DOCTOR|APOLLO|1MG|PHARMEASY|NETMEDS/)) {
    merchantCategory = 'healthcare_medical';
    transactionCategory = 'healthcare';
  }
  // Fuel
  else if (desc.match(/FUEL|PETROL|DIESEL|HP\s|IOCL|BHARAT\sPETRO|SHELL/)) {
    merchantCategory = 'fuel_gas';
    transactionCategory = 'fuel';
  }
  // Services
  else if (desc.match(/URBANCLAP|URBAN\sCLAP|HOUSEJOY|JUSTDIAL|DUNZO|PORTER/)) {
    merchantCategory = 'professional_services';
    transactionCategory = 'other';
  }
  // Subscriptions
  else if (desc.match(/GITHUB|GOOGLE\*PLAY|MICROSOFT|ADOBE|AWS|DIGITAL\sOCEAN|HOSTING/)) {
    merchantCategory = 'subscriptions_software';
    transactionCategory = 'other';
  }
  // Insurance
  else if (desc.match(/INSURANCE|POLICY|BAJAJ\sALLIANZ|ICICI\sPRU|LIC\sOF\sINDIA/)) {
    merchantCategory = 'insurance_finance';
    transactionCategory = 'other';
  }
  
  // Detect EMI transactions
  const isEMI = desc.includes('EMI') || desc.includes('AMORTIZATION') || desc.includes('INSTALMENT');
  
  // Detect recurring patterns (monthly subscriptions)
  const isRecurring = desc.match(/NETFLIX|PRIME|SPOTIFY|GITHUB|GOOGLE\*PLAY|JIO|AIRTEL/) !== null;
  
  // Extract location if present
  let location: string | undefined;
  const locMatch = desc.match(/\s(IN|US|UK|SG|AE|UAE)\s*$/);
  if (locMatch) {
    const countryMap: { [key: string]: string } = {
      'IN': 'India',
      'US': 'United States',
      'UK': 'United Kingdom',
      'SG': 'Singapore',
      'AE': 'UAE',
      'UAE': 'UAE'
    };
    location = countryMap[locMatch[1]];
  }
  
  // City detection for India
  const cityMatch = desc.match(/(BANGALORE|BENGALURU|MUMBAI|DELHI|HYDERABAD|CHENNAI|PUNE|KOLKATA|AHMEDABAD)/);
  if (cityMatch) {
    location = cityMatch[1];
  }
  
  return {
    ...txn,
    merchantName,
    merchantCategory,
    transactionCategory,
    isEMI,
    isRecurring,
    location
  };
}

/**
 * Detect bank and card type from statement
 */
function detectBankAndCardType(text: string, cardLast4: string): { 
  bankName: 'ICICI' | 'RBL' | 'unknown', 
  cardType?: string,
  creditLimit?: number,
  availableCredit?: number,
  statementPeriod?: string
} {
  const upperText = text.toUpperCase();
  
  let bankName: 'ICICI' | 'RBL' | 'unknown' = 'unknown';
  let cardType: string | undefined;
  let creditLimit: number | undefined;
  let availableCredit: number | undefined;
  let statementPeriod: string | undefined;
  
  // Detect bank
  if (upperText.includes('ICICI BANK') || upperText.includes('ICICIBANK')) {
    bankName = 'ICICI';
    
    // Detect ICICI card types
    if (upperText.includes('RUBYX') || upperText.includes('RUBY')) {
      cardType = 'Rubyx';
    } else if (upperText.includes('AMAZON PAY')) {
      cardType = 'Amazon Pay';
    } else if (upperText.includes('CORAL')) {
      cardType = 'Coral';
    } else if (upperText.includes('PLATINUM')) {
      cardType = 'Platinum';
    }
  } else if (upperText.includes('RBL BANK') || upperText.includes('RBLBANK')) {
    bankName = 'RBL';
    
    // RBL card types typically not in statement, but we can detect category
    if (upperText.includes('CREDIT CARD')) {
      cardType = 'Credit Card';
    }
  }
  
  // Extract credit limit
  const limitMatch = text.match(/Credit\s*Limit[:\s]+(?:INR|Rs\.?)?\s*([\d,]+(?:\.\d{2})?)/i);
  if (limitMatch) {
    creditLimit = parseFloat(limitMatch[1].replace(/,/g, ''));
  }
  
  // Extract available credit
  const availMatch = text.match(/Available\s*Credit[:\s]+(?:INR|Rs\.?)?\s*([\d,]+(?:\.\d{2})?)/i);
  if (availMatch) {
    availableCredit = parseFloat(availMatch[1].replace(/,/g, ''));
  }
  
  // Extract statement period
  const periodMatch = text.match(/Statement\s*(?:period|Period)[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\s*(?:to|-)\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
  if (periodMatch) {
    statementPeriod = `${periodMatch[1]} to ${periodMatch[2]}`;
  }
  
  return { bankName, cardType, creditLimit, availableCredit, statementPeriod };
}

/**
 * Sync transactions to PHP server
 */
async function syncToServer(statements: StatementData[]): Promise<void> {
  try {
    const apiUrl = process.env.API_URL || 'http://localhost:8000';
    
    // Read JWT token from environment or .token.json file
    let token: string | undefined = process.env.API_TOKEN;
    
    if (!token) {
      // Fallback to .token.json if API_TOKEN not in env
      const tokenPath = path.join(__dirname, '../../data/.token.json');
      try {
        const tokenData = JSON.parse(await fs.readFile(tokenPath, 'utf-8'));
        token = tokenData.token;
      } catch (e) {
        throw new Error('No authentication token found. Set API_TOKEN in .env or run: npm run auth');
      }
    }
    
    console.log('\n📤 Syncing to server...');
    
    // Group transactions by card
    const cardGroups = new Map<string, CreditCardTransaction[]>();
    const cardMetadata = new Map<string, Partial<StatementData>>();
    
    for (const statement of statements) {
      const cardKey = `${statement.bankName}_${statement.cardNumber}`;
      
      if (!cardGroups.has(cardKey)) {
        cardGroups.set(cardKey, []);
        cardMetadata.set(cardKey, {
          bankName: statement.bankName,
          cardNumber: statement.cardNumber,
          cardType: statement.cardType,
          creditLimit: statement.creditLimit,
          availableCredit: statement.availableCredit
        });
      }
      
      cardGroups.get(cardKey)!.push(...statement.transactions);
    }
    
    let totalSynced = 0;
    
    // Sync each card's transactions
    for (const [cardKey, transactions] of cardGroups) {
      const metadata = cardMetadata.get(cardKey)!;
      const enrichedTransactions = transactions.map(enrichTransaction);
      
      // Filter for last month only for smart descriptions
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      
      console.log(`\n  Syncing ${enrichedTransactions.length} transactions for ${metadata.bankName} card ending ${metadata.cardNumber}...`);
      
      const response = await axios.post(
        `${apiUrl}/sync/transactions`,
        {
          source: 'credit_card_scraper',
          transactions: enrichedTransactions.map(txn => {
            const txnDate = new Date(txn.date);
            const useSmartDescription = txnDate >= oneMonthAgo;
            
            return {
              bank: metadata.bankName,
              account_number: metadata.cardNumber,
              transaction_type: txn.type === 'debit' ? 'expense' : 'income',
              amount: txn.amount,
              merchant: txn.merchantName || cleanMerchantName(txn.description),
              description: useSmartDescription 
                ? generateSmartDescription(txn, metadata) 
                : cleanDescription(txn.description),
              date: txn.date,
              category: txn.transactionCategory || 'Other',
              reference_number: txn.cardLast4 ? `CC_${txn.cardLast4}_${txn.date}_${txn.amount}` : undefined,
              source: `${metadata.bankName} Card *${metadata.cardNumber}`,
              source_data: {
                merchant_category: txn.merchantCategory,
                is_emi: txn.isEMI,
                is_recurring: txn.isRecurring,
                location: txn.location,
                card_last4: txn.cardLast4,
                bank: metadata.bankName,
                card_type: metadata.cardType,
                credit_limit: metadata.creditLimit,
                available_credit: metadata.availableCredit,
                raw_description: txn.description
              }
            };
          })
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`  ✓ ${response.data.message}`);
      console.log(`    Created: ${response.data.data.created}, Updated: ${response.data.data.updated}, Failed: ${response.data.data.failed}`);
      
      totalSynced += response.data.data.created + response.data.data.updated;
    }
    
    console.log(`\n✅ Total synced: ${totalSynced} transactions`);
  } catch (error: any) {
    if (error.response) {
      console.error(`❌ Server error: ${error.response.data.message || error.response.statusText}`);
    } else {
      console.error(`❌ Sync failed: ${error.message}`);
    }
    throw error;
  }
}

export async function scrapeICICICreditCard() {
  try {
    console.log('\n🏦 Credit Card Statement Scraper (ICICI + RBL)\n' + '='.repeat(50));

    // Create output directories
    const dataDir = path.join(__dirname, '../../data/transactions');
    const pdfDir = path.join(dataDir, 'pdfs');
    
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(pdfDir, { recursive: true });

    // Load passwords for PDF decryption
    const passwords = await loadPasswords();
    console.log(`🔑 Loaded ${passwords.length} password(s) for PDF decryption\n`);

    // Step 1: Search for statement emails (fetch more to get all 3 cards)
    const messages = await searchStatementEmails(15);
    
    if (messages.length === 0) {
      console.log('\n❌ No statements found');
      return;
    }

    const allStatements: StatementData[] = [];

    // Step 2: Download and parse each statement
    for (const message of messages) {
      if (!message.id) continue;

      const attachment = await downloadPDFAttachment(message.id, pdfDir);
      
      if (attachment) {
        const statementData = await parseICICIStatement(attachment.path, passwords);
        
        if (statementData) {
          allStatements.push(statementData);
          console.log(`✓ Parsed ${statementData.transactions.length} transactions from ${statementData.statementMonth} ${statementData.statementYear}`);
        }
      }
    }

    // Step 3: Save to JSON or sync to server
    const shouldSync = process.argv.includes('--sync');
    
    if (shouldSync) {
      await syncToServer(allStatements);
    } else {
      const outputFile = path.join(dataDir, 'credit-cards.json');
      await fs.writeFile(outputFile, JSON.stringify(allStatements, null, 2));
      
      console.log(`\n✅ Saved ${allStatements.length} statement(s) to ${outputFile}`);
      console.log(`📊 Total transactions: ${allStatements.reduce((sum, s) => sum + s.transactions.length, 0)}`);
      console.log(`\n💡 Tip: Run with --sync flag to sync directly to server`);
    }
    
    return allStatements;
  } catch (error) {
    console.error('❌ Error scraping ICICI credit card statements:', error);
    throw error;
  }
}

// For manual testing - always run when executed directly
scrapeICICICreditCard()
  .then(() => console.log('\n✓ Done'))
  .catch(err => {
    console.error('\n✗ Failed:', err);
    process.exit(1);
  });
