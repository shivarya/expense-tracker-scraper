import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';

const gmail = google.gmail('v1');

export async function scrapeMutualFunds() {
  console.log('  → Authenticating with Gmail...');
  
  const mutualFunds = [];

  try {
    // Check last sync date to avoid re-downloading
    const syncStateFile = './data/sync-state.json';
    let lastMFSync = new Date('2026-01-01');
    try {
      const state = JSON.parse(await fs.readFile(syncStateFile, 'utf-8'));
      if (state.lastMFSyncTimestamp) {
        lastMFSync = new Date(state.lastMFSyncTimestamp);
      }
    } catch (e) {
      // No sync state yet
    }

    console.log(`  → Last MF sync: ${lastMFSync.toISOString()}`);

    // OAuth2 client setup
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );

    // Check for existing token
    const tokenPath = path.join(process.cwd(), 'gmail-token.json');
    try {
      const token = await fs.readFile(tokenPath, 'utf-8');
      oauth2Client.setCredentials(JSON.parse(token));
    } catch (error) {
      console.error('  ✗ No Gmail token found. Run OAuth flow first.');
      return mutualFunds;
    }

    google.options({ auth: oauth2Client });

    // Search for CAMS/KFintech emails (only new ones since last sync)
    console.log('  → Searching for mutual fund statements...');
    const dateFilter = `after:${Math.floor(lastMFSync.getTime() / 1000)}`;
    const camQuery = `from:donotreply@camsonline.com OR from:service@kfintech.com subject:statement ${dateFilter}`;
    
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: camQuery,
      maxResults: 50
    });

    const messages = response.data.messages || [];
    console.log(`  → Found ${messages.length} emails`);

    // Download and parse each statement
    for (const message of messages.slice(0, 10)) { // Limit to 10 most recent
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id!,
        format: 'full'
      });

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

          // Save PDF for manual parsing (or use PDF parser library)
          const data = Buffer.from(attachment.data.data!, 'base64');
          const pdfPath = path.join(process.cwd(), 'data', 'mf-statements', part.filename);
          await fs.mkdir(path.dirname(pdfPath), { recursive: true });
          await fs.writeFile(pdfPath, data);
          
          console.log(`    ✓ Saved to ${pdfPath}`);
          
          // TODO: Parse PDF and extract mutual fund data
          // For now, return placeholder data
          mutualFunds.push({
            fund_name: 'Sample Fund',
            amc: 'HDFC',
            folio_number: 'XXXXX',
            units: 100,
            nav: 50.25,
            invested_amount: 5000,
            current_value: 5025
          });
        }
      }
    }

  } catch (error: any) {
    console.error('  ✗ Gmail error:', error.message);
  }

  return mutualFunds;
}
