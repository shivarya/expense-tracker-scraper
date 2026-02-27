/**
 * JWT Token Manager for Scraper
 * 
 * Handles browser-based OAuth authentication and local token storage.
 * Opens browser directly to Google OAuth, exchanges ID token with server for JWT.
 * Uses same Google OAuth client as gmail-auth (GMAIL_CLIENT_ID/SECRET).
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import open from 'open';
import { google } from 'googleapis';

interface TokenData {
  token: string;
  expires_at: string;
  user_id: number;
  email: string;
}

const TOKEN_FILE = path.join(process.cwd(), 'data', '.token.json');
const ENV_FILE = path.join(process.cwd(), '.env');
const API_URL = process.env.API_URL || 'https://shivarya.dev/expense_tracker';

const googleClientId = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

/**
 * Check if token exists and is valid
 */
export async function hasValidToken(): Promise<boolean> {
  try {
    const tokenData = await readToken();
    if (!tokenData) return false;
    
    const expiresAt = new Date(tokenData.expires_at);
    const now = new Date();
    
    // Check if token expires within next hour
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    
    return expiresAt > oneHourFromNow;
  } catch {
    return false;
  }
}

/**
 * Read token from file
 */
export async function readToken(): Promise<TokenData | null> {
  try {
    const content = await fs.readFile(TOKEN_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get valid token (trigger auth if needed)
 */
export async function getToken(): Promise<string> {
  // Check existing token
  if (await hasValidToken()) {
    const tokenData = await readToken();
    if (tokenData) {
      console.log(`✓ Using existing token for ${tokenData.email}`);
      return tokenData.token;
    }
  }
  
  // Need to authenticate
  console.log('⚠️  No valid token found, starting authentication...');
  return await authenticate();
}

/**
 * Update API_TOKEN in .env file
 */
async function updateEnvToken(newToken: string): Promise<void> {
  try {
    let envContent = await fs.readFile(ENV_FILE, 'utf-8');
    if (envContent.match(/^API_TOKEN=.*/m)) {
      envContent = envContent.replace(/^API_TOKEN=.*/m, `API_TOKEN=${newToken}`);
    } else {
      envContent += `\nAPI_TOKEN=${newToken}\n`;
    }
    await fs.writeFile(ENV_FILE, envContent);
    console.log('  ✓ Updated API_TOKEN in .env');
  } catch (err: any) {
    console.warn(`  ⚠️  Could not update .env: ${err.message}`);
  }
}

/**
 * Exchange Google ID token for server JWT
 */
async function exchangeForServerJwt(idToken: string): Promise<{ token: string; user: any }> {
  const response = await fetch(`${API_URL}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_token: idToken }),
  });
  
  const data = await response.json() as any;
  
  if (!data.success) {
    throw new Error(data.error || 'Server auth failed');
  }
  
  return { token: data.data.token, user: data.data.user };
}

/**
 * Authenticate via direct Google OAuth → exchange for server JWT
 */
export async function authenticate(): Promise<string> {
  if (!googleClientId || !googleClientSecret) {
    throw new Error(
      'Missing Google OAuth config. Set GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET in .env'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    googleClientId,
    googleClientSecret,
    REDIRECT_URI
  );

  // Generate auth URL with openid scopes to get id_token
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });

  return new Promise((resolve, reject) => {
    let resolved = false;

    const server = http.createServer(async (req, res) => {
      if (!req.url) return;

      const parsedUrl = new URL(req.url, 'http://localhost:3000');

      if (parsedUrl.pathname === '/oauth2callback') {
        const code = parsedUrl.searchParams.get('code');
        const error = parsedUrl.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #dc3545;">&#10060; Authentication Failed</h1>
                <p>${error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          if (!resolved) { resolved = true; reject(new Error(error)); }
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>No authorization code received</h1>');
          server.close();
          if (!resolved) { resolved = true; reject(new Error('No code received')); }
          return;
        }

        try {
          // Step 1: Exchange code for Google tokens (includes id_token)
          console.log('  Exchanging code for Google tokens...');
          const { tokens } = await oauth2Client.getToken(code);

          if (!tokens.id_token) {
            throw new Error('Google did not return an id_token. Check scopes.');
          }

          // Step 2: Send Google id_token to our server to get a server JWT
          console.log('  Exchanging Google ID token for server JWT...');
          const { token: serverJwt, user } = await exchangeForServerJwt(tokens.id_token);

          // Step 3: Decode server JWT to get expiry
          const payload = JSON.parse(
            Buffer.from(serverJwt.split('.')[1], 'base64').toString()
          );

          const tokenData: TokenData = {
            token: serverJwt,
            expires_at: new Date(payload.exp * 1000).toISOString(),
            user_id: payload.user_id || user?.id,
            email: payload.email || user?.email || 'unknown',
          };

          // Step 4: Save token to file and update .env
          await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
          await updateEnvToken(serverJwt);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #28a745;">&#9989; Authentication Successful</h1>
                <p>Logged in as: <strong>${tokenData.email}</strong></p>
                <p>Token expires: ${new Date(tokenData.expires_at).toLocaleString()}</p>
                <p>You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);

          console.log(`✓ Authentication successful for ${tokenData.email}`);
          console.log(`  Token expires: ${new Date(tokenData.expires_at).toLocaleString()}`);

          server.close();
          if (!resolved) { resolved = true; resolve(serverJwt); }
        } catch (err: any) {
          console.error('❌ Auth exchange failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #dc3545;">&#10060; Error</h1>
                <p>${err.message}</p>
              </body>
            </html>
          `);
          server.close();
          if (!resolved) { resolved = true; reject(err); }
        }
      }
    });

    server.listen(3000, async () => {
      console.log('🔐 Opening browser for Google authentication...');
      console.log(`   Redirect URI: ${REDIRECT_URI}`);
      console.log('   Waiting for Google login...\n');

      try {
        await open(authUrl);
      } catch (err) {
        console.error('   Failed to open browser automatically.');
        console.log(`   Please open this URL manually:\n   ${authUrl}`);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        reject(new Error('Authentication timeout (5 minutes)'));
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Clear stored token
 */
export async function clearToken(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
    console.log('✓ Token cleared');
  } catch {
    // File doesn't exist, that's fine
  }
}

/**
 * Get user info from token
 */
export async function getUserInfo(): Promise<{ user_id: number; email: string } | null> {
  const tokenData = await readToken();
  if (!tokenData) return null;
  
  return {
    user_id: tokenData.user_id,
    email: tokenData.email
  };
}

// CLI command handler
if (process.argv[2] === 'auth') {
  (async () => {
    const forceReauth = process.argv.includes('--force');
    
    if (!forceReauth) {
      // Check if valid token already exists
      const hasValid = await hasValidToken();
      if (hasValid) {
        const tokenData = await readToken();
        console.log('\n✓ Valid token already exists!');
        console.log(`   Email: ${tokenData?.email}`);
        console.log(`   Expires: ${tokenData?.expires_at}`);
        console.log('\n💡 No need to re-authenticate. Use existing token.');
        console.log('   To force re-authentication, use: npm run auth:force');
        process.exit(0);
      }
    }
    
    // No valid token or force flag used, proceed with authentication
    if (forceReauth) {
      console.log('\n🔑 Force re-authentication requested...\n');
    } else {
      console.log('\n🔑 No valid token found. Starting authentication...\n');
    }
    
    await authenticate();
    console.log('\n✓ Authentication complete!');
    process.exit(0);
  })().catch((err) => {
    console.error('\n✗ Authentication failed:', err.message);
    process.exit(1);
  });
}
