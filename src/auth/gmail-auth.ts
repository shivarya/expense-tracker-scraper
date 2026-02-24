import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs/promises';
import http from 'http';
import open from 'open';

const gmailClientId = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const gmailClientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const gmailRedirectUri = process.env.GMAIL_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  gmailClientId,
  gmailClientSecret,
  gmailRedirectUri
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

async function authorize() {
  if (!gmailClientId || !gmailClientSecret) {
    throw new Error('Missing Gmail OAuth config. Set GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in .env');
  }

  // Check if token already exists
  try {
    const token = await fs.readFile('gmail-token.json', 'utf-8');
    oauth2Client.setCredentials(JSON.parse(token));
    console.log('✅ Existing token found and loaded!');
    
    // Test the token
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log(`✅ Connected to Gmail: ${profile.data.emailAddress}`);
    return;
  } catch (error: any) {
    const noTokenFile = error?.code === 'ENOENT';
    if (noTokenFile) {
      console.log('📧 No Gmail token file found. Starting OAuth flow...\n');
    } else {
      console.log('📧 Existing token is invalid/expired. Starting OAuth flow...\n');
      await fs.unlink('gmail-token.json').catch(() => {});
    }
  }

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Force to get refresh token
  });

  console.log('🔗 Opening browser for authorization...');
  console.log('   If browser doesn\'t open, visit this URL:\n');
  console.log(`   ${authUrl}\n`);

  // Start local server to catch OAuth callback
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url) {
          return;
        }

        const parsedUrl = new URL(req.url, 'http://localhost:3000');

        if (parsedUrl.pathname === '/oauth2callback') {
          const code = parsedUrl.searchParams.get('code');

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>❌ Authorization failed - no code received</h1>');
            server.close(() => reject(new Error('Authorization code not received')));
            return;
          }

          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          await fs.writeFile('gmail-token.json', JSON.stringify(tokens, null, 2));

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 50px; text-align: center;">
                <h1>✅ Authorization Successful!</h1>
                <p>Token saved to gmail-token.json</p>
                <p><strong>You can close this window now.</strong></p>
              </body>
            </html>
          `);

          console.log('\n✅ Token saved to gmail-token.json');
          console.log('✅ Gmail API ready to use!');

          server.close(() => resolve());
        }
      } catch (error: any) {
        console.error('❌ Error:', error.message);
        try {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>❌ Error: ${error.message}</h1>`);
        } catch {
        }
        server.close(() => reject(error));
      }
    });

    server.listen(3000, () => {
      console.log('🌐 Local server started on http://localhost:3000');
      console.log('⏳ Waiting for authorization...\n');

      open(authUrl).catch(() => {
        console.log('⚠️  Could not open browser automatically. Please open the URL manually.');
      });
    });

    server.on('error', (error) => {
      reject(error);
    });
  });
}

authorize()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Gmail auth failed:', error?.message || error);
    process.exit(1);
  });
