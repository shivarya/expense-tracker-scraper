/**
 * Extract transactions using pdf-parse (Node.js PDF library)
 * This is a fallback/complementary method to MarkItDown MCP
 * Agent should use BOTH methods and merge results
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { extractTextFromPDF } from '../utils/pdf.js';

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
  rawText?: string;
  extractionMethod: 'pdf-parse';
}

async function extractTransactionsFromPDF(pdfPath: string): Promise<PDFExtraction> {
  console.log(`\n📄 Extracting from: ${path.basename(pdfPath)}`);
  
  // Extract raw text
  const rawText = await extractTextFromPDF(pdfPath);
  
  // Parse transactions using multiple patterns
  const transactions: Transaction[] = [];
  
  // Detect bank type from filename or content
  const filename = path.basename(pdfPath).toLowerCase();
  const isRBL = filename.includes('xxxx') || rawText.includes('RBL BANK');
  const isICICI = filename.includes('6529') || filename.includes('4315') || rawText.includes('ICICI BANK');
  
  if (isRBL) {
    // RBL Table Format: Date | Description | Amount ₹
    // Example: "26 Dec 2025 PAYMENT RECEIVED - BBPS 5,099.00"
    // Process line by line to avoid issues with multi-line descriptions
    
    const lines = rawText.split('\n');
    for (const line of lines) {
      // Match RBL transaction: Date (DD MMM YYYY) + Description + Amount
      const rblMatch = line.match(/^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\s+(.+?)\s+([\d,]+\.\d{2})\s*$/i);
      
      if (rblMatch) {
        const [, date, desc, amtStr] = rblMatch;
        const amount = parseFloat(amtStr.replace(/,/g, ''));
        
        // Skip headers and invalid entries
        if (amount === 0 || desc.toLowerCase().includes('description') || desc.toLowerCase().includes('amount')) {
          continue;
        }
        
        // Determine type based on description keywords
        const isCredit = desc.toLowerCase().includes('payment') && desc.toLowerCase().includes('received');
        
        transactions.push({
          date: date.trim(),
          description: desc.trim(),
          amount,
          type: isCredit ? 'credit' : 'debit'
        });
      }
    }
  }
  
  if (isICICI) {
    // ICICI Table Format: Date | SerNo | Transaction Details | Reward Points | Intl.# amount | Amount (in`)
    // IMPORTANT: Transactions can span multiple lines when description is long!
    // Example multi-line:
    // 29/12/2025 12597931313 UPI-572921828289-RAJA THI YAGARAJAN
    // IN
    // 0 25.00
    
    // Strategy: Combine lines between transaction start markers
    const lines = rawText.split('\n');
    const combinedLines: string[] = [];
    let currentLine = '';
    
    for (const line of lines) {
      // Check if this line starts a new transaction (Date + 8+ digit serial number)
      if (/^\d{2}\/\d{2}\/\d{4}\s+\d{8,}/.test(line)) {
        // Save previous transaction if exists
        if (currentLine) {
          combinedLines.push(currentLine);
        }
        // Start new transaction
        currentLine = line;
      } else if (currentLine) {
        // This is a continuation of the previous transaction
        // Append with space (preserve content but merge lines)
        currentLine += ' ' + line.trim();
      }
    }
    // Don't forget the last transaction
    if (currentLine) {
      combinedLines.push(currentLine);
    }
    
    // Now process the combined lines
    for (const line of combinedLines) {
      // Match ICICI transaction: Date + SerialNo + rest of line ending with amount (+ optional CR)
      const iciciMatch = line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(\d{8,})\s+(.+?)\s+([\d,]+\.\d{2})\s*(CR)?\s*$/i);
      
      if (iciciMatch) {
        const [, date, serNo, middlePart, amtStr, isCr] = iciciMatch;
        const amount = parseFloat(amtStr.replace(/,/g, ''));
        
        // Skip header rows or zero amounts
        if (amount === 0 || middlePart.toLowerCase().includes('transaction details')) {
          continue;
        }
        
        // The middlePart contains: Description + Reward Points + (optional Intl.# amount)
        // Remove trailing numeric columns: "Description RewardPoints [IntlAmount]"
        const descMatch = middlePart.match(/^(.+?)\s+(-?\d+)(?:\s+[\d,]+\.\d{2})?\s*$/);
        let description = middlePart.trim();
        
        if (descMatch) {
          description = descMatch[1].trim();
        }
        
        transactions.push({
          date: date.trim(),
          description: description,
          amount,
          type: isCr ? 'credit' : 'debit'
        });
      }
    }
  }
  
  // Fallback: Try generic patterns if bank-specific didn't work
  if (transactions.length === 0) {
    // Generic Pattern 1: DD/MM/YYYY Description Amount
    const genericPattern1 = /(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+([\d,]+\.\d{2})\s*(?:CR|DR)?/gi;
    let match;
    while ((match = genericPattern1.exec(rawText)) !== null) {
      const [, date, desc, amtStr] = match;
      const amount = parseFloat(amtStr.replace(/,/g, ''));
      if (amount > 0 && desc.trim().length > 5) {
        transactions.push({
          date: date.trim(),
          description: desc.trim(),
          amount,
          type: 'debit'
        });
      }
    }
    
    // Generic Pattern 2: DD MMM YYYY Description Amount
    const genericPattern2 = /(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+(.+?)\s+([\d,]+\.\d{2})/gi;
    while ((match = genericPattern2.exec(rawText)) !== null) {
      const [, date, desc, amtStr] = match;
      const amount = parseFloat(amtStr.replace(/,/g, ''));
      if (amount > 0 && desc.trim().length > 5) {
        transactions.push({
          date: date.trim(),
          description: desc.trim(),
          amount,
          type: 'debit'
        });
      }
    }
  }
  
  // Remove duplicates (same date, amount, description)
  const uniqueTransactions = transactions.filter((tx, index, self) =>
    index === self.findIndex(t =>
      t.date === tx.date && t.amount === tx.amount && t.description === tx.description
    )
  );
  
  console.log(`  ✓ Extracted ${uniqueTransactions.length} transaction(s) using pdf-parse`);
  
  return {
    filename: path.basename(pdfPath),
    pdfPath,
    transactions: uniqueTransactions,
    rawText: rawText.substring(0, 2000), // First 2000 chars for debugging
    extractionMethod: 'pdf-parse'
  };
}

// Main execution
(async () => {
  console.log('📊 PDF-Parse Transaction Extractor\n');
  console.log('━'.repeat(60));
  console.log('⚠️  This is a COMPLEMENTARY extraction method');
  console.log('⚠️  Agent should MERGE results with MarkItDown MCP\n');
  
  // Read manifest
  const manifestPath = path.join(__dirname, '../../data/raw-extracts/pdf-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  
  console.log(`📂 Found ${manifest.totalPDFs} PDF(s) in manifest\n`);
  
  const extractions: PDFExtraction[] = [];
  let skippedCount = 0;
  
  for (const pdf of manifest.pdfs) {
    // CRITICAL: Only parse DECRYPTED PDFs
    // Check if this PDF was successfully decrypted
    const isDecrypted = pdf.decryptedPath && pdf.decryptedPath !== pdf.pdfPath;
    
    if (!isDecrypted) {
      console.log(`\n⚠️  Skipping ENCRYPTED PDF: ${pdf.filename}`);
      console.log(`   → PDF was not successfully decrypted (missing password)`);
      console.log(`   → Agent should use MarkItDown MCP if this PDF is readable`);
      skippedCount++;
      continue;
    }
    
    try {
      console.log(`\n✅ Processing DECRYPTED PDF: ${pdf.filename}`);
      const extraction = await extractTransactionsFromPDF(pdf.decryptedPath);
      extractions.push(extraction);
    } catch (error: any) {
      console.error(`  ❌ Failed: ${error.message}`);
      extractions.push({
        filename: pdf.filename,
        pdfPath: pdf.decryptedPath,
        transactions: [],
        extractionMethod: 'pdf-parse'
      });
    }
  }
  
  // Save results
  const outputPath = path.join(__dirname, '../../data/raw-extracts/pdf-parse-extractions.json');
  await fs.writeFile(outputPath, JSON.stringify({
    extractedAt: new Date().toISOString(),
    method: 'pdf-parse (Node.js library)',
    totalPDFsInManifest: manifest.totalPDFs,
    decryptedPDFsProcessed: extractions.length,
    encryptedPDFsSkipped: skippedCount,
    totalTransactions: extractions.reduce((sum, e) => sum + e.transactions.length, 0),
    extractions
  }, null, 2));
  
  console.log(`\n✅ Saved pdf-parse extractions to: ${outputPath}`);
  console.log(`📊 Processed: ${extractions.length} decrypted PDF(s)`);
  console.log(`⚠️  Skipped: ${skippedCount} encrypted PDF(s) (no password)`);
  console.log(`📊 Total: ${extractions.reduce((sum, e) => sum + e.transactions.length, 0)} transaction(s)`);
  console.log(`\n💡 Next: Agent should:`);
  console.log(`   1. Read pdf-parse-extractions.json (this file)`);
  console.log(`   2. For DECRYPTED PDFs: Use MarkItDown MCP on decryptedPath from manifest`);
  console.log(`   3. For ENCRYPTED PDFs: Try MarkItDown MCP (may work if MarkItDown can handle encryption)`);
  console.log(`   4. MERGE both results (union of transactions)`);
  console.log(`   5. Deduplicate by date+amount+description`);
  console.log(`   6. Save to enriched-transactions.json`);
})();
