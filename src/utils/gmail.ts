/**
 * Gmail API Utility
 * 
 * Shared Gmail OAuth2 authentication for all email-based scrapers.
 */

import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import open from 'open';

const TOKEN_FILE = path.join(process.cwd(), 'gmail-token.json');

const gmailClientId = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const gmailClientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const gmailRedirectUri = process.env.GMAIL_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

/**
 * Authenticate Gmail with OAuth2
 * Reuses existing token if valid, otherwise triggers browser flow
 */
export async function authenticateGmail(): Promise<any> {
  const oauth2Client = new google.auth.OAuth2(
    gmailClientId,
    gmailClientSecret,
    gmailRedirectUri
  );

  console.log('📧 Gmail OAuth Config:', {
    hasClientId: !!gmailClientId,
    hasClientSecret: !!gmailClientSecret,
    redirectUri: gmailRedirectUri
  });

  if (!gmailClientId || !gmailClientSecret) {
    throw new Error('Missing Gmail OAuth config. Set GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in .env');
  }

  // Try to load existing token
  try {
    const token = await fs.readFile(TOKEN_FILE, 'utf-8');
    const credentials = JSON.parse(token);
    oauth2Client.setCredentials(credentials);

    // Test if token is valid
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    await gmail.users.getProfile({ userId: 'me' });

    // Set up automatic token refresh
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.refresh_token) {
        credentials.refresh_token = tokens.refresh_token;
      }
      credentials.access_token = tokens.access_token;
      credentials.expiry_date = tokens.expiry_date;
      await fs.writeFile(TOKEN_FILE, JSON.stringify(credentials, null, 2));
    });

    return oauth2Client;
  } catch (error: any) {
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      console.log('  ⚠️  Gmail token expired, re-authenticating...');
      await fs.unlink(TOKEN_FILE).catch(() => {});
    }
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
      if (!req.url) return;
      
      const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
      
      if (parsedUrl.pathname === '/oauth2callback') {
        const code = parsedUrl.searchParams.get('code');
        
        if (code) {
          try {
            const { tokens } = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(tokens);
            
            await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                  <h1 style="color: #28a745;">✅ Gmail Authorization Successful</h1>
                  <p>You can close this window and return to the terminal.</p>
                </body>
              </html>
            `);
            
            console.log('  ✓ Gmail authorization successful');
            server.close();
            resolve(oauth2Client);
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Failed to authenticate');
            server.close();
            reject(err);
          }
        }
      }
    });
    
    server.listen(3000, async () => {
      console.log('  → Opening browser for Gmail authorization...');
      try {
        await open(authUrl);
      } catch {
        console.log(`  → Please open this URL: ${authUrl}`);
      }
    });
  });
}

/**
 * Get authenticated Gmail client
 */
export async function getGmailClient() {
  const auth = await authenticateGmail();
  return google.gmail({ version: 'v1', auth });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  authenticateGmail()
    .then(() => {
      console.log(`  ✓ Token saved to: ${TOKEN_FILE}`);
      process.exit(0);
    })
    .catch((error: any) => {
      console.error('  ✗ Gmail auth failed:', error.message || error);
      process.exit(1);
    });
}
