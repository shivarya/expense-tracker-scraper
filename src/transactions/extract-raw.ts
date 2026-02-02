/**
 * Simple PDF Downloader & Decryptor - NO transaction extraction
 * Agent uses MarkItDown MCP to read PDFs and extract transactions
 */

import { getGmailClient } from '../utils/gmail';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { decrypt } from 'node-qpdf2';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DownloadedPDF {
  filename: string;
  pdfPath: string;
  decryptedPath?: string;
  messageId: string;
  downloadedAt: string;
}

interface TimeFilter {
  label: string;
  gmailFilter: string;
}

function parseTimeFilter(arg?: string): TimeFilter {
  const filters: Record<string, TimeFilter> = {
    '1m': { label: 'Last 1 month', gmailFilter: 'newer_than:1m' },
    '3m': { label: 'Last 3 months', gmailFilter: 'newer_than:3m' },
    '6m': { label: 'Last 6 months', gmailFilter: 'newer_than:6m' },
    '1y': { label: 'Last 1 year', gmailFilter: 'newer_than:1y' },
    '2y': { label: 'Last 2 years', gmailFilter: 'newer_than:2y' },
    'all': { label: 'All time', gmailFilter: '' },
  };
  
  const key = arg?.toLowerCase() || '1y';
  return filters[key] || filters['1y'];
}

async function loadPasswords(): Promise<string[]> {
  try {
    const pwdFile = path.join(__dirname, '../config/pdf-passwords.json');
    const content = await fs.readFile(pwdFile, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return [];
  }
}

async function decryptPDF(pdfPath: string, passwords: string[], decryptedDir: string): Promise<string> {
  const filename = path.basename(pdfPath);
  const decryptedPath = path.join(decryptedDir, filename.replace('.pdf', '_decrypted.pdf'));
  
  console.log(`  🔐 Trying ${passwords.length} password(s)...`);
  
  for (let i = 0; i < passwords.length; i++) {
    const pwd = passwords[i];
    
    // Clean up any previous failed attempts
    try {
      await fs.unlink(decryptedPath);
    } catch (e) {
      // File doesn't exist, that's fine
    }
    
    try {
      await decrypt({ input: pdfPath, output: decryptedPath, password: pwd });
    } catch (e: any) {
      // Decrypt might throw error but still create the file
      // So we check for file existence below
    }
    
    // Check if file was created and has content (regardless of error)
    try {
      const stat = await fs.stat(decryptedPath);
      if (stat.size > 0) {
        console.log(`  ✓ Decrypted with password #${i + 1}: ${pwd.substring(0, 4)}***`);
        return decryptedPath;
      } else {
        console.log(`  ⚠️  Password #${i + 1} created empty file`);
      }
    } catch (statErr) {
      // File wasn't created
      console.log(`  ⚠️  Password #${i + 1} failed (no output)`);
    }
  }
  
  // If decryption failed, try to copy as-is (might not be encrypted)
  console.log(`  ℹ️  All passwords failed, attempting to copy PDF...`);
  try {
    await fs.copyFile(pdfPath, decryptedPath);
    console.log(`  ℹ️  PDF copied (not encrypted or unknown password)`);
    return decryptedPath;
  } catch (e) {
    console.log(`  ⚠️  Could not decrypt or copy PDF`);
    return pdfPath;
  }
}

async function searchStatementEmails(maxResults: number = 5, timeFilter: string = '') {
  const gmail = await getGmailClient();
  
  // Combined query for both banks
  // Note: ICICI uses credit_cards@ (underscore), not credit-cards@ (hyphen)
  let query = '{from:credit_cards@icicibank.com OR from:statements@rbl.bank.in} subject:statement has:attachment filename:pdf';
  
  // Add time filter if specified
  if (timeFilter) {
    query = `${query} ${timeFilter}`;
  }
  
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  return response.data.messages || [];
}

async function downloadPDFAttachment(messageId: string, outputDir: string) {
  const gmail = await getGmailClient();
  
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
  });

  if (!message.data.payload?.parts) {
    return null;
  }

  for (const part of message.data.payload.parts) {
    if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
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

// Main execution
(async () => {
  console.log('🏦 Credit Card PDF Downloader & Decryptor\n');
  console.log('━'.repeat(60));
  console.log('📌 This script ONLY downloads and decrypts PDFs');
  console.log('📌 Agent will use MarkItDown MCP to extract transactions\n');

  const dataDir = path.join(__dirname, '../../data/raw-extracts');
  const pdfDir = path.join(dataDir, 'pdfs');
  const decryptedDir = path.join(dataDir, 'decrypted');
  
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(pdfDir, { recursive: true });
  await fs.mkdir(decryptedDir, { recursive: true });

  const passwords = await loadPasswords();
  console.log(`🔑 Loaded ${passwords.length} password(s)\n`);

  // Parse CLI arguments: --all --time=3m
  const fetchAll = process.argv.includes('--all');
  const timeArg = process.argv.find(arg => arg.startsWith('--time='))?.split('=')[1];
  const timeFilter = parseTimeFilter(timeArg);
  
  const maxResults = fetchAll ? 50 : 1;
  
  console.log(`📥 Mode: ${fetchAll ? 'Fetch ALL statements' : 'Fetch 1 statement (POC mode)'}`);
  console.log(`⏱️  Time Range: ${timeFilter.label}`);
  console.log(`📊 Max Results: ${maxResults}\n`);

  // Fetch statements
  const messages = await searchStatementEmails(maxResults, timeFilter.gmailFilter);
  
  if (messages.length === 0) {
    console.log('\n❌ No statements found');
    return;
  }

  const downloadedPDFs: DownloadedPDF[] = [];

  for (const message of messages) {
    if (!message.id) continue;

    console.log(`\n📧 Processing email ${message.id}...`);
    const attachment = await downloadPDFAttachment(message.id, pdfDir);
    
    if (attachment) {
      console.log(`📄 Downloaded: ${attachment.filename}`);
      
      let decryptedPath: string = attachment.path; // Default to original path
      
      // Decrypt if needed
      if (passwords.length > 0) {
        try {
          const result = await decryptPDF(attachment.path, passwords, decryptedDir);
          decryptedPath = result; // Use the result (either decrypted or copied)
          if (result !== attachment.path) {
            console.log(`🔓 Decrypted successfully`);
          }
        } catch (e) {
          console.log(`⚠️  Could not decrypt (may not be encrypted)`);
        }
      }
      
      downloadedPDFs.push({
        filename: attachment.filename,
        pdfPath: attachment.path,
        decryptedPath: decryptedPath,
        messageId: attachment.messageId,
        downloadedAt: new Date().toISOString()
      });
    }
  }

  // Save manifest for agent to process
  const manifestFile = path.join(dataDir, 'pdf-manifest.json');
  await fs.writeFile(manifestFile, JSON.stringify({
    downloadedAt: new Date().toISOString(),
    totalPDFs: downloadedPDFs.length,
    pdfs: downloadedPDFs
  }, null, 2));
  
  console.log(`\n✅ Downloaded and decrypted ${downloadedPDFs.length} PDF(s)`);
  console.log(`📄 Manifest saved to: ${manifestFile}`);
  console.log(`\n📂 Encrypted PDFs: ${pdfDir}`);
  console.log(`📂 Decrypted PDFs: ${decryptedDir}`);
  console.log(`\n💡 Next Steps:`);
  console.log(`   1. Agent reads pdf-manifest.json`);
  console.log(`   2. For each PDF with decryptedPath, agent uses MarkItDown MCP tool:`);
  console.log(`      mcp_microsoft_mar_convert_to_markdown({ uri: "file:///{decryptedPath}" })`);
  console.log(`   3. Agent extracts transactions from markdown tables`);
  console.log(`   4. Agent enriches data (clean merchants, categorize, smart descriptions)`);
  console.log(`   5. Agent saves to enriched-transactions.json`);
  console.log(`   6. Run: npm run sync:cc:enriched`);
})();
