import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs/promises';
import http from 'http';
import url from 'url';
import open from 'open';

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

async function authorize() {
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
  } catch (error) {
    console.log('📧 No token found. Starting OAuth flow...\n');
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
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = url.parse(req.url!, true);
      
      if (parsedUrl.pathname === '/oauth2callback') {
        const code = parsedUrl.query.code as string;
        
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>❌ Authorization failed - no code received</h1>');
          server.close();
          return;
        }

        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        // Save token
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
        
        server.close();
      }
    } catch (error: any) {
      console.error('❌ Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>❌ Error: ${error.message}</h1>`);
      server.close();
    }
  });

  server.listen(3000, () => {
    console.log('🌐 Local server started on http://localhost:3000');
    console.log('⏳ Waiting for authorization...\n');
    
    // Open browser automatically
    open(authUrl).catch(() => {
      console.log('⚠️  Could not open browser automatically. Please open the URL manually.');
    });
  });
}

authorize().catch(console.error);
