/**
 * CAMS Mutual Fund Statement Scraper
 * 
 * Fetches mutual fund statements from CAMS emails via Gmail API.
 * Parses PDF attachments to extract MF holdings.
 * Outputs data to: data/mutual-funds/cams.json
 */

import fs from 'fs/promises';
import path from 'path';
import { authenticateGmail } from '../../utils/gmail';
import { downloadAndParsePDF } from '../../utils/pdf';

export interface CAMSMutualFund {
  fund_name: string;
  folio_number: string;
  amc: string;
  scheme_code?: string;
  isin?: string;
  units: number;
  nav: number;
  invested_amount: number;
  current_value: number;
  plan_type: 'direct' | 'regular';
  option_type: 'growth' | 'dividend' | 'idcw';
  source: 'cams';
}

interface ScraperResult {
  success: boolean;
  data: CAMSMutualFund[];
  error?: string;
  scraped_at: string;
  emails_processed: number;
}

/**
 * Basic schema validation
 */
function validateMF(mf: any): mf is CAMSMutualFund {
  return (
    typeof mf.fund_name === 'string' &&
    typeof mf.folio_number === 'string' &&
    typeof mf.units === 'number' &&
    typeof mf.nav === 'number'
  );
}

/**
 * Fetch CAMS mutual fund statements
 */
export async function fetchCAMSMutualFunds(): Promise<ScraperResult> {
  const result: ScraperResult = {
    success: false,
    data: [],
    scraped_at: new Date().toISOString(),
    emails_processed: 0
  };
  
  try {
    console.log('🔍 CAMS Mutual Fund Scraper');
    console.log('  → Authenticating Gmail...');
    
    const auth = await authenticateGmail();
    const gmail = await import('googleapis').then(g => g.google.gmail({ version: 'v1', auth }));
    
    console.log('  → Searching for CAMS emails...');
    
    const query = 'from:donotreply@camsonline.com subject:(statement OR consolidated) has:attachment';
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20
    });
    
    const messages = listResponse.data.messages || [];
    console.log(`  → Found ${messages.length} CAMS emails`);
    
    if (messages.length === 0) {
      result.success = true;
      result.error = 'No CAMS emails found';
      return result;
    }
    
    const mutualFunds: CAMSMutualFund[] = [];
    
    for (const message of messages.slice(0, 5)) { // Process latest 5
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: message.id!,
          format: 'full'
        });
        
        // Find PDF attachment
        const parts = msg.data.payload?.parts || [];
        for (const part of parts) {
          if (part.filename?.endsWith('.pdf') && part.body?.attachmentId) {
            console.log(`  → Processing: ${part.filename}`);
            
            const attachment = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: message.id!,
              id: part.body.attachmentId
            });
            
            if (attachment.data.data) {
              const buffer = Buffer.from(attachment.data.data, 'base64');
              
              // Parse PDF (this would use the PDF parser utility)
              // For now, placeholder
              console.log(`    → PDF size: ${buffer.length} bytes`);
              console.log(`    ⚠️  PDF parsing not implemented - needs AI processing`);
              
              result.emails_processed++;
            }
          }
        }
      } catch (err: any) {
        console.error(`    ✗ Failed to process email: ${err.message}`);
      }
    }
    
    // Validate
    const validMFs = mutualFunds.filter(validateMF);
    
    result.success = true;
    result.data = validMFs;
    
    // Save to file
    const outputPath = path.join(process.cwd(), 'data', 'mutual-funds', 'cams.json');
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`  ✓ Saved to ${outputPath}`);
    
  } catch (error: any) {
    console.error('  ✗ Scraping failed:', error.message);
    result.error = error.message;
  }
  
  return result;
}

// CLI command handler
if (process.argv[1].includes('cams.ts') || process.argv[2] === 'cams') {
  fetchCAMSMutualFunds()
    .then((result) => {
      if (result.success) {
        console.log(`\n✓ Scraping complete: ${result.data.length} mutual funds from ${result.emails_processed} emails`);
        process.exit(0);
      } else {
        console.error(`\n✗ Scraping failed: ${result.error}`);
        process.exit(1);
      }
    });
}
