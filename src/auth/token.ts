/**
 * JWT Token Manager for Scraper
 * 
 * Handles browser-based OAuth authentication and local token storage.
 * Opens browser to Google OAuth, captures JWT from callback, stores locally.
 */

import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import open from 'open';

interface TokenData {
  token: string;
  expires_at: string;
  user_id: number;
  email: string;
}

const TOKEN_FILE = path.join(process.cwd(), 'data', '.token.json');
const API_URL = process.env.API_URL || 'https://shivarya.dev/expense_tracker';

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
 * Authenticate via browser OAuth
 */
export async function authenticate(): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    
    // Create local HTTP server to capture callback
    const server = http.createServer(async (req, res) => {
      if (!req.url) return;
      
      const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
      
      if (parsedUrl.pathname === '/auth/callback') {
        const token = parsedUrl.searchParams.get('token');
        const error = parsedUrl.searchParams.get('error');
        
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #dc3545;">❌ Authentication Failed</h1>
                <p>${error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          
          server.close();
          if (!resolved) {
            resolved = true;
            reject(new Error(error));
          }
          return;
        }
        
        if (token) {
          try {
            // Decode JWT to get user info and expiry
            const payload = JSON.parse(
              Buffer.from(token.split('.')[1], 'base64').toString()
            );
            
            const tokenData: TokenData = {
              token,
              expires_at: new Date(payload.exp * 1000).toISOString(),
              user_id: payload.user_id,
              email: payload.email || 'unknown'
            };
            
            // Save token
            await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                  <h1 style="color: #28a745;">✅ Authentication Successful</h1>
                  <p>Logged in as: <strong>${tokenData.email}</strong></p>
                  <p>Token expires: ${new Date(tokenData.expires_at).toLocaleString()}</p>
                  <p>You can close this window and return to the terminal.</p>
                </body>
              </html>
            `);
            
            console.log(`✓ Authentication successful for ${tokenData.email}`);
            console.log(`  Token expires: ${new Date(tokenData.expires_at).toLocaleString()}`);
            
            server.close();
            if (!resolved) {
              resolved = true;
              resolve(token);
            }
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                  <h1 style="color: #dc3545;">❌ Error</h1>
                  <p>Failed to save token: ${err.message}</p>
                </body>
              </html>
            `);
            
            server.close();
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          }
        }
      }
    });
    
    server.listen(3000, async () => {
      console.log('🔐 Opening browser for authentication...');
      console.log('   Waiting for Google login...');
      
      // Open browser to Google OAuth
      const authUrl = `${API_URL}/auth/google?redirect=http://localhost:3000/auth/callback`;
      
      try {
        await open(authUrl);
      } catch (err) {
        console.error('   Failed to open browser automatically.');
        console.log(`   Please open this URL manually: ${authUrl}`);
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
