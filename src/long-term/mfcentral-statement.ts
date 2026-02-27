/**
 * MF Central Statement Downloader
 *
 * Automates downloading consolidated mutual fund statements from MF Central.
 * Login: PAN + Password + reCAPTCHA (manual) → Security Question (auto-answer) →
 * Statement → Detailed tab → Select period → Download as PDF
 *
 * Credentials and security-question answers are stored locally with AES-256-GCM.
 *
 * Usage:
 *   npm run mfc:setup          # First-time: save creds + security answers interactively
 *   npm run mfc:fetch          # Fetch statement using saved session/creds
 *   npm run mfc:forget-creds   # Delete saved credentials
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import dotenv from 'dotenv';
import readline from 'readline';
import { chromium, type Page, type BrowserContext } from 'playwright';

dotenv.config();

// ────────────────────────────────────────────────────────────
// Paths & Constants
// ────────────────────────────────────────────────────────────
const LOGIN_URL = 'https://app.mfcentral.com/investor/signin';
const AUTH_DIR = path.join(process.cwd(), 'data', '.auth');
const RAW_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const SECURE_DIR = path.join(process.cwd(), 'data', '.secure');
const PDF_DIR = path.join(RAW_DIR, 'mfcentral-pdfs');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'mfcentral-storage-state.json');
const SECURE_CREDS_PATH = path.join(SECURE_DIR, 'mfcentral-creds.enc.json');
const SECURE_QA_PATH = path.join(SECURE_DIR, 'mfcentral-qa.enc.json');
const OUTPUT_JSON_PATH = path.join(process.cwd(), 'data', 'mfcentral-statement.json');

// ────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    setup: args.includes('--setup'),
    fetch: args.includes('--fetch'),
    forgetCreds: args.includes('--forget-creds'),
    showPassword: args.includes('--show-password'),
    headed: args.includes('--headed') || args.includes('--setup'),
    period: (args.find(a => a.startsWith('--period='))?.split('=')[1]) || 'all', // current|previous|all
    fromDate: args.find(a => a.startsWith('--from='))?.split('=')[1] || '',
    toDate: args.find(a => a.startsWith('--to='))?.split('=')[1] || '',
  };
}

// ────────────────────────────────────────────────────────────
// I/O helpers
// ────────────────────────────────────────────────────────────
function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

async function prompt(question: string): Promise<string> {
  const rl = createRl();
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function promptSecret(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const rlAny = rl as any;
  return new Promise(resolve => {
    rlAny.output.write(question);
    const orig = rlAny._writeToOutput;
    rlAny._writeToOutput = function () { rlAny.output.write('*'); };
    rl.question('', answer => {
      rlAny._writeToOutput = orig;
      rlAny.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ────────────────────────────────────────────────────────────
// AES-256-GCM credential encryption (machine-local key)
// ────────────────────────────────────────────────────────────
function deriveKey(salt: string): Buffer {
  const machineId = `${os.hostname()}:${os.userInfo().username}:${salt}`;
  return crypto.pbkdf2Sync(machineId, 'mfcentral-salt-20260227', 100000, 32, 'sha256');
}

function encrypt(plainJson: string, salt: string): { encrypted: string; iv: string; tag: string } {
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()]);
  return { encrypted: enc.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decrypt(encrypted: string, ivB64: string, tagB64: string, salt: string): string {
  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

// ────────────────────────────────────────────────────────────
// Credential storage (PAN + password)
// ────────────────────────────────────────────────────────────
interface EncPayload { version: 2; data: string; iv: string; tag: string; savedAt: string; }

async function loadCreds(): Promise<{ pan: string; password: string } | null> {
  try {
    const raw = JSON.parse(await fs.readFile(SECURE_CREDS_PATH, 'utf-8')) as EncPayload;
    if (raw.version !== 2) return null;
    return JSON.parse(decrypt(raw.data, raw.iv, raw.tag, 'mfcentral-creds-v2'));
  } catch { return null; }
}

async function saveCreds(pan: string, password: string) {
  await fs.mkdir(SECURE_DIR, { recursive: true });
  const { encrypted, iv, tag } = encrypt(JSON.stringify({ pan, password }), 'mfcentral-creds-v2');
  const payload: EncPayload = { version: 2, data: encrypted, iv, tag, savedAt: new Date().toISOString() };
  await fs.writeFile(SECURE_CREDS_PATH, JSON.stringify(payload, null, 2));
}

async function clearCreds() {
  await fs.unlink(SECURE_CREDS_PATH).catch(() => {});
  await fs.unlink(SECURE_QA_PATH).catch(() => {});
  console.log('✅ Cleared stored MF Central credentials and security answers');
}

// ────────────────────────────────────────────────────────────
// Security question/answer storage
// ────────────────────────────────────────────────────────────
type QAMap = Record<string, string>; // normalised question → answer

async function loadQA(): Promise<QAMap> {
  try {
    const raw = JSON.parse(await fs.readFile(SECURE_QA_PATH, 'utf-8')) as EncPayload;
    if (raw.version !== 2) return {};
    return JSON.parse(decrypt(raw.data, raw.iv, raw.tag, 'mfcentral-qa-v2'));
  } catch { return {}; }
}

async function saveQA(qa: QAMap) {
  await fs.mkdir(SECURE_DIR, { recursive: true });
  const { encrypted, iv, tag } = encrypt(JSON.stringify(qa), 'mfcentral-qa-v2');
  const payload: EncPayload = { version: 2, data: encrypted, iv, tag, savedAt: new Date().toISOString() };
  await fs.writeFile(SECURE_QA_PATH, JSON.stringify(payload, null, 2));
}

function normaliseQ(q: string): string {
  return q.replace(/\s+/g, ' ').trim().toLowerCase();
}

// ────────────────────────────────────────────────────────────
// Get credentials interactively (or load stored)
// ────────────────────────────────────────────────────────────
async function getCredentials(showPassword: boolean) {
  const stored = await loadCreds();
  if (stored) {
    const use = await prompt('Use saved MF Central credentials? (Y/n): ');
    if (!use || /^y(es)?$/i.test(use)) return stored;
  }

  let pan = process.env.MFCENTRAL_PAN || '';
  let password = process.env.MFCENTRAL_PASSWORD || '';

  if (!pan) pan = await prompt('Enter PAN / PEKRN: ');
  if (!password) {
    if (showPassword) {
      password = await prompt('Enter MF Central Password (visible): ');
    } else {
      console.log('Now enter MF Central password (input is hidden):');
      password = await promptSecret('Enter Password (hidden): ');
    }
  }

  if (pan && password) {
    const save = await prompt('Save credentials securely on this device? (Y/n): ');
    if (!save || /^y(es)?$/i.test(save)) {
      await saveCreds(pan, password);
      console.log(`✅ Credentials saved (AES-256-GCM): ${SECURE_CREDS_PATH}`);
    }
  }
  return { pan, password };
}

// ────────────────────────────────────────────────────────────
// Browser helpers
// ────────────────────────────────────────────────────────────
async function launchBrowser(headed: boolean) {
  const opts = { headless: !headed, args: ['--start-maximized'] };
  try {
    return await chromium.launch({ ...opts, channel: 'chrome' });
  } catch {
    console.log('ℹ️  Chrome not found, falling back to bundled Chromium');
    return await chromium.launch(opts);
  }
}

async function fillField(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try { await loc.fill(value, { timeout: 3000 }); return true; } catch {}
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────
// Step 1: Login Page — PAN + Password + manual CAPTCHA
// ────────────────────────────────────────────────────────────
async function handleLoginPage(page: Page, pan: string, password: string) {
  console.log('\n📌 Step 1: Login page');

  // Fill PAN
  const panFilled = await fillField(page, [
    'input[placeholder*="PAN"]',
    'input[placeholder*="PEKRN"]',
    'input[formcontrolname="pan"]',
    'input[type="text"]',
  ], pan);
  if (panFilled) console.log('  ✅ PAN filled');
  else console.log('  ⚠️  Could not fill PAN — enter manually');

  // check if password toggle is present and selected (vs OTP)
  // The page has Password | OTP toggle — make sure Password is active
  try {
    const pwdToggle = page.locator('label:has-text("Password"), span:has-text("Password")').first();
    if (await pwdToggle.count()) {
      // The toggle might already be selected. Click only if password field is not visible.
      const pwdField = page.locator('input[type="password"]').first();
      if (!(await pwdField.isVisible({ timeout: 1000 }).catch(() => false))) {
        await pwdToggle.click();
        await page.waitForTimeout(500);
      }
    }
  } catch {}

  // Fill password
  const pwdFilled = await fillField(page, [
    'input[type="password"]',
    'input[placeholder*="Password"]',
    'input[formcontrolname="password"]',
  ], password);
  if (pwdFilled) console.log('  ✅ Password filled');
  else console.log('  ⚠️  Could not fill password — enter manually');

  // reCAPTCHA — must be solved manually
  console.log('\n  🤖 reCAPTCHA detected — please solve it manually in the browser.');
  console.log('  Then click the "Sign In" button.');
  console.log('  Press Enter here once you are past the login page.\n');
  await prompt('  ⏳ Press Enter after completing CAPTCHA + Sign In... ');
}

// ────────────────────────────────────────────────────────────
// Step 2: Security Question — auto-answer or prompt
// ────────────────────────────────────────────────────────────
async function handleSecurityQuestion(page: Page): Promise<boolean> {
  console.log('\n📌 Step 2: Security question');

  // Wait a bit for the page to load
  await page.waitForTimeout(2000);

  // Detect if security question is present
  const questionText = await page.evaluate(`(() => {
    var labels = Array.from(document.querySelectorAll('label, span, p, div'));
    for (var i = 0; i < labels.length; i++) {
      var txt = (labels[i].textContent || '').trim();
      if (/security question/i.test(txt)) {
        // The actual question is usually the next sibling or a nearby element
        var parent = labels[i].closest('.form-group, .field-group, div');
        if (parent) {
          var allText = parent.innerText || '';
          var lines = allText.split('\\n').map(function(l) { return l.trim(); }).filter(Boolean);
          // Find the line that contains the question (not the label "Security Question" itself)
          for (var j = 0; j < lines.length; j++) {
            if (lines[j].length > 15 && /\\?|which|what|who|where|when|how|your|favorite|favourite/i.test(lines[j])) {
              return lines[j];
            }
          }
          // fallback: return second line
          if (lines.length > 1) return lines[1];
        }
      }
    }
    return null;
  })()`) as string | null;

  if (!questionText) {
    // Maybe we landed directly on dashboard — no security question
    const url = await page.url();
    if (/dashboard|home|portfolio|statement/i.test(url)) {
      console.log('  ℹ️  No security question — already on dashboard');
      return true;
    }
    // Try detecting by looking for answer input field
    const answerField = page.locator('input[placeholder*="Answer"], input[formcontrolname*="answer"]').first();
    if (!(await answerField.count())) {
      console.log('  ℹ️  No security question detected on this page');
      return true;
    }
    // There's an answer field but we couldn't extract the question — ask user
    console.log('  ⚠️  Found answer field but could not extract question text');
    const manualQ = await prompt('  Type the security question you see: ');
    return await answerSecurityQuestion(page, manualQ);
  }

  console.log(`  ❓ Question: "${questionText}"`);
  return await answerSecurityQuestion(page, questionText);
}

async function answerSecurityQuestion(page: Page, question: string): Promise<boolean> {
  const qa = await loadQA();
  const key = normaliseQ(question);
  let answer = qa[key] || '';

  if (answer) {
    console.log(`  ✅ Found stored answer`);
  } else {
    answer = await prompt(`  Enter answer for "${question}": `);
    if (!answer) {
      console.log('  ❌ No answer provided');
      return false;
    }
    // Save for next time
    qa[key] = answer;
    await saveQA(qa);
    console.log('  💾 Answer saved for future use');
  }

  // Fill the answer
  const filled = await fillField(page, [
    'input[placeholder*="Answer"]',
    'input[formcontrolname*="answer"]',
    'input[type="text"]',
    'input[type="password"]',
  ], answer);

  if (!filled) {
    console.log('  ⚠️  Could not fill answer — enter manually');
    await prompt('  Press Enter after entering answer and submitting... ');
    return true;
  }

  console.log('  ✅ Answer filled');

  // Try to click submit/continue button
  try {
    const submitBtn = page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Continue"), button:has-text("Verify")').first();
    if (await submitBtn.count()) {
      await submitBtn.click();
      console.log('  ✅ Submitted security answer');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      console.log('  ℹ️  No submit button found — click it manually');
      await prompt('  Press Enter after submitting... ');
    }
  } catch {
    await prompt('  Press Enter after submitting the answer... ');
  }

  return true;
}

// ────────────────────────────────────────────────────────────
// Step 3: Navigate to Statement → Detailed tab
// ────────────────────────────────────────────────────────────
async function navigateToStatement(page: Page) {
  console.log('\n📌 Step 3: Navigating to Statement page');

  // Wait for dashboard to load
  await page.waitForTimeout(2000);

  // Click "Statement" in sidebar/nav
  const statementClicked = await tryClickNav(page, [
    'a:has-text("Statement")',
    'span:has-text("Statement")',
    'div:has-text("Statement")',
    'li:has-text("Statement")',
    'button:has-text("Statement")',
    '[routerlink*="statement"]',
    'a[href*="statement"]',
  ]);

  if (statementClicked) {
    console.log('  ✅ Clicked Statement tab');
  } else {
    console.log('  ⚠️  Could not find Statement link — navigate manually');
    await prompt('  Press Enter after navigating to Statement page... ');
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function tryClickNav(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
        await loc.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function selectDetailedTab(page: Page) {
  console.log('\n📌 Step 4: Selecting "Detailed" tab');

  // MF Central uses Angular Material tabs or custom tab-like elements.
  // Use getByText for broad matching, then try specific selectors.
  let clicked = false;

  // The tab text is "Detailed (includes transaction listing)" — use partial match

  // Approach 1: Playwright getByText with partial match
  try {
    const byText = page.getByText(/Detailed/i);
    const count = await byText.count();
    for (let i = 0; i < count; i++) {
      const el = byText.nth(i);
      const text = await el.textContent().catch(() => '') || '';
      // Skip nav items that just say "Statement" etc — look for "Detailed" specifically
      if (!/detailed/i.test(text)) continue;
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click({ timeout: 3000 });
        clicked = true;
        break;
      }
    }
  } catch {}

  // Approach 2: CSS selectors — broad set including Angular
  if (!clicked) {
    clicked = await tryClickNav(page, [
      '*:has-text("Detailed (")',
      '.mat-tab-label:has-text("Detailed")',
      '.mat-mdc-tab:has-text("Detailed")',
      '[role="tab"]:has-text("Detailed")',
      '.nav-link:has-text("Detailed")',
      'a:has-text("Detailed")',
      'span:has-text("Detailed")',
      'button:has-text("Detailed")',
      'li:has-text("Detailed")',
    ]);
  }

  // Approach 3: JS click — find any element containing "Detailed" in visible text
  if (!clicked) {
    clicked = await page.evaluate(`(() => {
      var els = document.querySelectorAll('a, span, button, li, div, label, p, h1, h2, h3, h4, td, th');
      for (var i = 0; i < els.length; i++) {
        var txt = (els[i].textContent || '').trim();
        if (/detailed/i.test(txt) && txt.length < 80 && els[i].offsetParent !== null) {
          els[i].click();
          return true;
        }
      }
      return false;
    })()`) as boolean;
  }

  if (clicked) {
    console.log('  ✅ Clicked "Detailed" tab');
  } else {
    // Debug: dump ALL visible text elements (not just nav-like) to find the tab
    const tabTexts = await page.evaluate(`(() => {
      var all = document.querySelectorAll('a, span, button, li, div, label, h1, h2, h3, h4, td, th, p');
      var texts = [];
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].textContent || '').trim();
        if (t && t.length > 3 && t.length < 80 && /detail|summary|transact|statement|download/i.test(t) && all[i].offsetParent !== null) {
          texts.push(all[i].tagName + ': ' + t);
        }
      }
      return texts.filter(function(v, i, a) { return a.indexOf(v) === i; }).slice(0, 20).join(' | ');
    })()`);
    console.log(`  🔍 Visible tab-like elements: ${tabTexts}`);
    console.log('  ⚠️  Could not find "Detailed" tab — click it manually');
    await prompt('  Press Enter after selecting the Detailed tab... ');
  }

  await page.waitForTimeout(2000);
}

// ────────────────────────────────────────────────────────────
// Step 5: Select period and download PDF
// ────────────────────────────────────────────────────────────
async function selectPeriodAndDownload(page: Page, context: BrowserContext, args: ReturnType<typeof parseArgs>) {
  console.log('\n📌 Step 5: Selecting period and downloading PDF');

  const period = args.period;

  if (period === 'current') {
    await tryClickNav(page, [
      'label:has-text("Current financial year")',
      'span:has-text("Current financial year")',
      'input[value*="current"]',
    ]);
    console.log('  ✅ Selected "Current financial year"');
  } else if (period === 'previous') {
    await tryClickNav(page, [
      'label:has-text("Previous financial year")',
      'span:has-text("Previous financial year")',
      'input[value*="previous"]',
    ]);
    console.log('  ✅ Selected "Previous financial year"');
  } else {
    // "Specific period" (all / custom dates)
    const specificClicked = await tryClickNav(page, [
      'label:has-text("Specific period")',
      'span:has-text("Specific period")',
      'input[value*="specific"]',
    ]);
    if (specificClicked) {
      console.log('  ✅ Selected "Specific period"');
    }
    await page.waitForTimeout(1000);

    // Set date range
    let fromDate = args.fromDate;
    let toDate = args.toDate;

    if (!fromDate) {
      // MF Central data starts from January 2023
      fromDate = '01/01/2023';
    }
    if (!toDate) {
      toDate = formatDateDDMMYYYY(new Date());
    }

    console.log(`  📅 Period: ${fromDate} → ${toDate}`);

    // Fill "From" date
    await setDateField(page, 0, fromDate);
    // Fill "To" date
    await setDateField(page, 1, toDate);

    await page.waitForTimeout(500);
  }

  // Dismiss any error modal (e.g. "From date and To date should not be same")
  try {
    const okayBtn = page.locator('button:has-text("Okay"), button:has-text("OK"), button:has-text("Close")');
    if (await okayBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await okayBtn.first().click();
      console.log('  ℹ️  Dismissed error modal');
      await page.waitForTimeout(500);
    }
  } catch {}

  // ── STEP A: Navigate to downloads table (without creating new request) ──
  console.log('\n  📥 Checking existing downloads...');
  await fs.mkdir(PDF_DIR, { recursive: true });

  // Check if we're already on the downloads table (has S.NO + Action headers)
  const alreadyOnTable = await page.evaluate(`(() => {
    var ths = document.querySelectorAll('th');
    for (var i = 0; i < ths.length; i++) {
      if (/S\\.?NO/i.test((ths[i].textContent || '').trim())) return true;
    }
    return false;
  })()`);

  if (alreadyOnTable) {
    console.log('  ✅ Already on downloads table');
  } else {
    // Try "My Download" nav link with broader selectors
    const myDlClicked = await tryClickNav(page, [
      'a:has-text("My Download")',
      'button:has-text("My Download")',
      'span:has-text("My Download")',
      'a:has-text("My Downloads")',
      'button:has-text("My Downloads")',
      '[routerlink*="download"]',
      'a:has-text("Download")',  // broader match
    ]);
    if (myDlClicked) {
      console.log('  ✅ Navigated to My Download page');
    } else {
      // Last resort: use the URL directly if possible
      const currentUrl = page.url();
      if (currentUrl.includes('mfcentral.com')) {
        console.log('  ℹ️  Could not find "My Download" link — clicking "Download as PDF"');
        console.log('  ⚠️  This will create a new download request.');
        const pdfClicked = await tryClickNav(page, [
          'button:has-text("Download as PDF")',
          'a:has-text("Download as PDF")',
          'span:has-text("Download as PDF")',
          'button:has-text("Download PDF")',
        ]);
        if (!pdfClicked) {
          await prompt('  Navigate to "My Download" page manually, then press Enter... ');
        }
      }
    }
  }

  await page.waitForTimeout(3000);

  // ── Helper: dump downloads table ──
  const dumpTable = async () => {
    return await page.evaluate(`(() => {
      var rows = document.querySelectorAll('tr');
      var info = [];
      for (var i = 0; i < Math.min(rows.length, 10); i++) {
        var cells = rows[i].querySelectorAll('td, th');
        if (cells.length < 4) continue;
        var rowText = [];
        for (var j = 0; j < cells.length; j++) rowText.push((cells[j].textContent || '').trim().substring(0, 40));
        info.push(rowText.join(' | '));
      }
      return info.join('\\n');
    })()`) as string;
  };

  // ── Helper: find a clickable "Download" in the downloads table ──
  // Looks for a <td> in the ACTION column that contains "Download" (not "In Progress"),
  // and finds ANY clickable descendant or the td itself.
  const findDownloadLink = async () => {
    return await page.evaluate(`(() => {
      var rows = document.querySelectorAll('tr');
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (cells.length < 4) continue;
        var lastCell = cells[cells.length - 1];
        var cellText = (lastCell.textContent || '').trim();
        if (/In Progress/i.test(cellText)) continue;
        if (!/Download/i.test(cellText)) continue;
        // Found a row with "Download" — find something to click
        // Try: a, button, span, div children first
        var clickables = lastCell.querySelectorAll('a, button, span, div, mat-icon, i');
        for (var c = 0; c < clickables.length; c++) {
          var elTxt = (clickables[c].textContent || '').trim();
          if (/Download/i.test(elTxt)) {
            var rect = clickables[c].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                tag: clickables[c].tagName,
                href: clickables[c].getAttribute('href') || '',
                row: r,
                text: elTxt.substring(0, 20)
              };
            }
          }
        }
        // Fallback: click the td itself
        var tdRect = lastCell.getBoundingClientRect();
        if (tdRect.width > 0 && tdRect.height > 0) {
          return {
            x: tdRect.x + tdRect.width / 2,
            y: tdRect.y + tdRect.height / 2,
            tag: 'TD',
            href: '',
            row: r,
            text: cellText.substring(0, 20)
          };
        }
      }
      return null;
    })()`) as { x: number; y: number; tag: string; href: string; row: number; text: string } | null;
  };

  // ── Helper: attempt the download click + capture ──
  const attemptDownload = async (): Promise<string | null> => {
    const dlInfo = await findDownloadLink();
    if (!dlInfo) return null;

    console.log(`  📄 Found "${dlInfo.text}" in row ${dlInfo.row} (${dlInfo.tag}) — clicking...`);

    // Set up capture methods BEFORE clicking
    const downloadPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
    const newPagePromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);

    // Intercept ALL responses to capture PDF or debug what happens
    let capturedPdfBuffer: Buffer | null = null;
    let capturedPdfName = '';
    const allResponses: string[] = [];
    const responseHandler = async (response: any) => {
      try {
        const status = response.status();
        const ct = response.headers()['content-type'] || '';
        const cd = response.headers()['content-disposition'] || '';
        const url = response.url() as string;
        const shortUrl = url.length > 80 ? url.substring(0, 80) + '...' : url;
        allResponses.push(`${status} ${ct.substring(0, 40)} ${shortUrl}`);

        if (ct.includes('pdf') || ct.includes('octet-stream') || ct.includes('force-download') ||
            cd.includes('attachment') || cd.includes('.pdf') || url.includes('.pdf') ||
            url.includes('/download') || url.includes('/cas') || url.includes('getCasDocument')) {
          const body = await response.body().catch(() => null);
          if (body && body.length > 1000) {
            capturedPdfBuffer = body;
            const fnMatch = cd.match(/filename[*]?=(?:UTF-8''|")?([^";\\n]+)/i);
            capturedPdfName = fnMatch ? fnMatch[1].replace(/"/g, '') : '';
            console.log(`  📦 Intercepted response: ${body.length} bytes, ct=${ct}, cd=${cd.substring(0, 50)}`);
          }
        }
      } catch {}
    };
    page.on('response', responseHandler);

    // Click the download link using JS dispatch (more reliable for Angular)
    // First try JS click on the element, then fall back to mouse click
    const jsClicked = await page.evaluate(`(() => {
      var rows = document.querySelectorAll('tr');
      var targetRow = rows[${dlInfo.row}];
      if (!targetRow) return false;
      var cells = targetRow.querySelectorAll('td');
      if (cells.length < 4) return false;
      var lastCell = cells[cells.length - 1];
      // Click all clickable descendants with "Download" text
      var clickables = lastCell.querySelectorAll('a, button, span, div');
      for (var c = 0; c < clickables.length; c++) {
        var elTxt = (clickables[c].textContent || '').trim();
        if (/Download/i.test(elTxt)) {
          clickables[c].click();
          return true;
        }
      }
      // Click the td itself
      lastCell.click();
      return true;
    })()`);
    if (jsClicked) {
      console.log('  ✅ JS click dispatched');
    } else {
      // Fallback: mouse click
      await page.mouse.click(dlInfo.x, dlInfo.y);
      console.log('  ✅ Mouse click dispatched (fallback)');
    }
    console.log('  ⏳ Waiting for download (15s)...');
    await page.waitForTimeout(15000);

    page.removeListener('response', responseHandler);

    // Log all responses for debugging
    if (allResponses.length > 0) {
      console.log(`  🌐 Network responses after click (${allResponses.length}):`);
      for (const r of allResponses.slice(0, 10)) console.log(`     ${r}`);
    } else {
      console.log('  🌐 No network responses after click');
    }

    // Method 1: Playwright download event
    const download = await downloadPromise;
    if (download) {
      const suggestedName = download.suggestedFilename() || `mfcentral-cas-${Date.now()}.pdf`;
      const savePath = path.join(PDF_DIR, suggestedName);
      await download.saveAs(savePath);
      console.log(`  ✅ PDF saved (download event): ${savePath}`);
      return savePath;
    }

    // Method 2: Intercepted network response body
    if (capturedPdfBuffer) {
      const fileName = capturedPdfName || `mfcentral-cas-${Date.now()}.pdf`;
      const savePath = path.join(PDF_DIR, fileName);
      await fs.writeFile(savePath, capturedPdfBuffer);
      console.log(`  ✅ PDF saved (response intercept): ${savePath}`);
      return savePath;
    }

    // Method 3: New tab opened
    const newPage = await newPagePromise;
    if (newPage) {
      console.log(`  📄 New tab opened: ${newPage.url()}`);
    }

    // Method 4: Check Chrome's default download folder for recent PDFs
    const homeDir = process.env.USERPROFILE || process.env.HOME || '';
    const defaultDlDir = path.join(homeDir, 'Downloads');
    try {
      const files = await fs.readdir(defaultDlDir);
      const recent = files
        .filter(f => /\.pdf$/i.test(f) && /cas|mf|mutual/i.test(f))
        .map(f => ({ name: f, path: path.join(defaultDlDir, f) }));
      // Check files modified in last 30 seconds
      for (const f of recent) {
        const stat = await fs.stat(f.path);
        if (Date.now() - stat.mtimeMs < 30000) {
          const destPath = path.join(PDF_DIR, f.name);
          await fs.copyFile(f.path, destPath);
          console.log(`  ✅ PDF found in Downloads folder: ${destPath}`);
          return destPath;
        }
      }
    } catch {}

    console.log(`  ℹ️  Download not captured. URL: ${page.url()}`);
    return null;
  };

  // ── STEP B: Try to download from existing table entries ──
  const tableInfo = await dumpTable();
  console.log(`  🔍 Downloads table:\n${tableInfo}`);

  // First attempt: try existing "Download" link
  const dlLink = await findDownloadLink();
  if (dlLink) {
    console.log('  ✅ Found existing download — attempting to capture...');
    const result = await attemptDownload();
    if (result) return result;
  } else {
    console.log('  ℹ️  No ready downloads found in table');
    // Go back and request a new download
    console.log('  📤 Requesting new PDF download...');
    // Navigate back to statement page
    await tryClickNav(page, [
      'a:has-text("Statement")',
      'button:has-text("Statement")',
    ]);
    await page.waitForTimeout(2000);
    await tryClickNav(page, [
      'button:has-text("Download as PDF")',
      'a:has-text("Download as PDF")',
      'span:has-text("Download as PDF")',
    ]);
    await page.waitForTimeout(3000);
  }

  // Retry up to 2 more times (for "In Progress" completion or failed capture)
  for (let retry = 1; retry <= 2; retry++) {
    console.log(`  ⏳ Retry ${retry}/2 — waiting 10s...`);
    await page.waitForTimeout(10000);
    // Re-navigate to "My Download" instead of reloading (reload loses the table)
    await tryClickNav(page, [
      'a:has-text("My Download")',
      'button:has-text("My Download")',
      'span:has-text("My Download")',
    ]);
    await page.waitForTimeout(3000);
    const retryTable = await dumpTable();
    console.log(`  🔍 Downloads table (retry ${retry}):\n${retryTable}`);
    const result = await attemptDownload();
    if (result) return result;
  }

  console.log('  ⚠️  Could not capture download automatically.');
  console.log('  ℹ️  Try clicking the Download link manually in the browser.');
  console.log('  ℹ️  If status is "In Progress", wait ~30 mins and run again.');
  const manualPath = await prompt('  Enter the full path of the downloaded PDF (or press Enter to skip): ');
  if (manualPath) return manualPath;

  return null;
}

function formatDateDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Open the datepicker and prompt the user to pick the date manually.
 * Automated calendar navigation was unreliable on MF Central, so we just
 * open the popup and let the user select.
 *
 * @param page  Playwright page
 * @param index 0 = From, 1 = To
 * @param dateStr DD/MM/YYYY format
 */
async function setDateField(page: Page, index: number, dateStr: string) {
  const label = index === 0 ? 'From' : 'To';

  // ── Helper: click element center using page.mouse ──────────
  const mouseClickEl = async (selector: string, nth = 0): Promise<boolean> => {
    const pos = await page.evaluate(`((sel, nth) => {
      var els = document.querySelectorAll(sel);
      var visible = [];
      for (var i = 0; i < els.length; i++) {
        if (els[i].offsetParent !== null || els[i].getClientRects().length > 0) visible.push(els[i]);
      }
      if (visible.length <= nth) return null;
      var r = visible[nth].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })('${selector}', ${nth})`) as { x: number; y: number } | null;
    if (!pos) return false;
    await page.mouse.click(pos.x, pos.y);
    return true;
  };

  // ── Open the calendar popup ────────────────────────────────
  let opened = false;
  const toggleSelectors = [
    'mat-datepicker-toggle button',
    'mat-datepicker-toggle',
    '.mat-datepicker-toggle button',
    '.mat-datepicker-toggle',
    'button[matdatepickertoggle]',
    '[matSuffix] button',
    'button[aria-label*="calendar" i]',
    'button[aria-label*="Choose" i]',
    'button[aria-label*="date" i]',
    'button[aria-label*="open" i]',
  ];
  for (const sel of toggleSelectors) {
    if (opened) break;
    opened = await mouseClickEl(sel, index);
    if (opened) console.log(`  ✅ Opened calendar for ${label} date`);
  }

  if (!opened) {
    console.log(`  ⚠️  Could not open calendar for ${label} date`);
  }

  // Prompt user to pick the date manually
  await prompt(`  📅 Pick ${label} date: ${dateStr} in the calendar, then press Enter... `);
}


// ────────────────────────────────────────────────────────────
// Wait for user to complete any remaining manual steps
// ────────────────────────────────────────────────────────────
async function waitForPostLogin(page: Page): Promise<Page> {
  // Check if we're past login
  await page.waitForTimeout(2000);
  const url = page.url();

  if (/signin|login/i.test(url)) {
    console.log('\n  ⚠️  Still on login/signin page.');
    console.log('  Complete any remaining steps in the browser.');
    await prompt('  Press Enter when you see the dashboard/home page... ');
  }

  return page;
}

// ────────────────────────────────────────────────────────────
// Main workflows
// ────────────────────────────────────────────────────────────

async function setupSession() {
  console.log('🔐 MF Central Setup Session\n');
  console.log('━'.repeat(60));
  console.log('This will save your credentials and security-question answers');
  console.log('securely (AES-256-GCM, machine-local key).\n');

  const { showPassword } = parseArgs();
  const { pan, password } = await getCredentials(showPassword);

  const browser = await launchBrowser(true);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
  });
  let page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`🔗 Opened: ${LOGIN_URL}`);

    await handleLoginPage(page, pan, password);
    page = await waitForPostLogin(page);

    // Security question
    await handleSecurityQuestion(page);
    page = await waitForPostLogin(page);

    // Save session state
    await fs.mkdir(AUTH_DIR, { recursive: true });
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`\n✅ Session saved: ${STORAGE_STATE_PATH}`);
    console.log('You can now run: npm run mfc:fetch\n');
  } finally {
    await browser.close();
  }
}

async function fetchStatement() {
  console.log('📄 MF Central Statement Download\n');
  console.log('━'.repeat(60));

  const args = parseArgs();

  // Try to reuse saved session
  let hasSession = false;
  try {
    await fs.access(STORAGE_STATE_PATH);
    hasSession = true;
  } catch {}

  const browser = await launchBrowser(true); // Always headed — needs captcha
  const contextOptions: any = {
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
  };
  if (hasSession) {
    contextOptions.storageState = STORAGE_STATE_PATH;
    console.log('  🔄 Restoring saved session...');
  }

  const context = await browser.newContext(contextOptions);
  let page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`🔗 Opened: ${LOGIN_URL}`);
    await page.waitForTimeout(3000);

    // Check if session is still valid (redirected to dashboard?)
    const url = page.url();
    const needsLogin = /signin|login/i.test(url);

    if (needsLogin) {
      console.log('  ℹ️  Session expired — need to log in again');

      // Load credentials
      const creds = await loadCreds();
      if (!creds) {
        console.log('  ❌ No saved credentials. Run: npm run mfc:setup');
        return;
      }

      await handleLoginPage(page, creds.pan, creds.password);
      page = await waitForPostLogin(page);

      // Security question
      await handleSecurityQuestion(page);
      page = await waitForPostLogin(page);

      // Save refreshed session
      await fs.mkdir(AUTH_DIR, { recursive: true });
      await context.storageState({ path: STORAGE_STATE_PATH });
    } else {
      console.log('  ✅ Session still valid — on dashboard');
    }

    // Navigate to Statement → Detailed tab
    await navigateToStatement(page);
    await selectDetailedTab(page);

    // Select period & download
    const pdfPath = await selectPeriodAndDownload(page, context, args);

    if (pdfPath) {
      // Save metadata
      const meta = {
        downloadedAt: new Date().toISOString(),
        pdfPath,
        period: args.period,
        fromDate: args.fromDate || '5 years ago',
        toDate: args.toDate || 'today',
      };
      await fs.writeFile(OUTPUT_JSON_PATH, JSON.stringify(meta, null, 2));
      console.log(`\n✅ Statement download complete!`);
      console.log(`📄 PDF: ${pdfPath}`);
      console.log(`📋 Metadata: ${OUTPUT_JSON_PATH}`);
    } else {
      console.log('\n⚠️  No PDF downloaded. Try again or download manually.');
    }

    // Save session
    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────
const args = parseArgs();

if (args.forgetCreds) {
  clearCreds().then(() => process.exit(0));
} else if (args.setup) {
  setupSession()
    .then(() => process.exit(0))
    .catch((err: any) => { console.error('\n❌ Error:', err.message || err); process.exit(1); });
} else if (args.fetch) {
  fetchStatement()
    .then(() => process.exit(0))
    .catch((err: any) => { console.error('\n❌ Error:', err.message || err); process.exit(1); });
} else {
  console.log(`
MF Central Statement Downloader
================================

Usage:
  npm run mfc:setup              First-time setup (save creds + security answers)
  npm run mfc:setup:visible      Setup with visible password input
  npm run mfc:fetch              Download statement (uses saved session)
  npm run mfc:fetch -- --period=current    Current financial year
  npm run mfc:fetch -- --period=previous   Previous financial year
  npm run mfc:fetch -- --period=all        Specific period (default: last 5 years)
  npm run mfc:fetch -- --from=01/04/2023 --to=27/02/2026   Custom date range
  npm run mfc:forget-creds       Delete saved credentials

Steps:
  1. Login with PAN + Password + reCAPTCHA (manual)
  2. Answer security question (auto-filled from stored answers)
  3. Navigate to Statement → Detailed tab
  4. Select period → Download as PDF
`);
}
