import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import dotenv from 'dotenv';
import readline from 'readline';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

dotenv.config();

const LOGIN_URL = 'https://passbook.epfindia.gov.in/MemberPassBook/login';
const AUTH_DIR = path.join(process.cwd(), 'data', '.auth');
const RAW_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const SECURE_DIR = path.join(process.cwd(), 'data', '.secure');
const PDF_DIR = path.join(RAW_DIR, 'epfo-pdfs');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'epfo-storage-state.json');
const SECURE_CREDS_PATH = path.join(SECURE_DIR, 'epfo-creds.enc.json');
const OUTPUT_JSON_PATH = path.join(process.cwd(), 'data', 'epfo-passbook.json');
const OUTPUT_HTML_PATH = path.join(RAW_DIR, 'epfo-passbook-page.html');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    setup: args.includes('--setup'),
    fetch: args.includes('--fetch'),
    forgetCreds: args.includes('--forget-creds'),
    showPassword: args.includes('--show-password'),
    headed: args.includes('--headed') || args.includes('--setup')
  };
}

type StoredCreds = {
  version: 2;
  uan: string;
  password: string;
  iv: string;
  tag: string;
  savedAt: string;
};

function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

async function prompt(question: string) {
  const rl = createReadline();
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptSecret(question: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const rlAny = rl as any;
  return new Promise<string>((resolve) => {
    rlAny.output.write(`${question}`);
    const originalWrite = rlAny._writeToOutput;
    rlAny._writeToOutput = function _writeToOutput() {
      rlAny.output.write('*');
    };

    rl.question('', (answer) => {
      rlAny._writeToOutput = originalWrite;
      rlAny.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Derive a machine-local AES-256 key from hostname + username (not exportable across machines)
function deriveKey(): Buffer {
  const machineId = `${os.hostname()}:${os.userInfo().username}:epfo-creds-v2`;
  return crypto.pbkdf2Sync(machineId, 'epfo-salt-20250227', 100000, 32, 'sha256');
}

function encryptPayload(jsonStr: string): { encrypted: string; iv: string; tag: string } {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptPayload(encrypted: string, ivB64: string, tagB64: string): string {
  const key = deriveKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

async function loadStoredCredentials() {
  try {
    const raw = await fs.readFile(SECURE_CREDS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as StoredCreds;
    if (parsed.version !== 2) return null;
    const json = decryptPayload(parsed.uan, parsed.iv, parsed.tag);
    const creds = JSON.parse(json);
    return { uan: creds.uan as string, password: creds.password as string };
  } catch {
    return null;
  }
}

async function saveStoredCredentials(uan: string, password: string) {
  await fs.mkdir(SECURE_DIR, { recursive: true });
  const plainJson = JSON.stringify({ uan, password });
  const { encrypted, iv, tag } = encryptPayload(plainJson);
  const payload: StoredCreds = {
    version: 2,
    uan: encrypted,
    password: '',  // stored in encrypted blob
    iv,
    tag,
    savedAt: new Date().toISOString()
  };

  await fs.writeFile(SECURE_CREDS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

async function clearStoredCredentials() {
  await fs.unlink(SECURE_CREDS_PATH).catch(() => {});
  // Also clean up old DPAPI format if present
  const oldPath = path.join(SECURE_DIR, 'epfo-creds.dpapi.json');
  await fs.unlink(oldPath).catch(() => {});
  console.log(`✅ Cleared stored EPFO credentials`);
}

async function getCredentials(showPassword: boolean = false) {
  const stored = await loadStoredCredentials();
  if (stored) {
    const useSaved = await prompt('Use securely saved EPFO credentials? (Y/n): ');
    if (!useSaved || /^y(es)?$/i.test(useSaved)) {
      return stored;
    }
  }

  let uan = process.env.EPFO_UAN || '';
  let password = process.env.EPFO_PASSWORD || '';

  if (!uan) {
    uan = await prompt('Enter EPFO UAN (won\'t be saved): ');
  }

  if (!password) {
    if (showPassword) {
      console.log('⚠️ Visible password mode enabled for this run.');
      password = await prompt('Enter EPFO Password (visible): ');
    } else {
      console.log('Now enter EPFO password (input is hidden):');
      password = await promptSecret('Enter EPFO Password (hidden, won\'t be saved): ');
    }
  }

  if (uan && password) {
    const saveChoice = await prompt('Save EPFO credentials securely on this device for next runs? (Y/n): ');
    if (!saveChoice || /^y(es)?$/i.test(saveChoice)) {
      try {
        await saveStoredCredentials(uan, password);
        console.log(`✅ Credentials saved securely (AES-256-GCM): ${SECURE_CREDS_PATH}`);
      } catch (error: any) {
        console.log(`⚠️ Could not save credentials: ${error.message || error}`);
        console.log('Continuing without saved credentials.');
      }
    }
  }

  return { uan, password };
}

async function launchInteractiveBrowser() {
  const launchOptions = {
    headless: false as boolean,
    args: ['--start-maximized']
  };

  try {
    console.log('🌐 Launching Chrome window...');
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    console.log('ℹ️ Chrome channel not available, falling back to bundled Chromium...');
    return await chromium.launch(launchOptions);
  }
}

async function fillIfVisible(page: Page, selectors: string[], value: string) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.fill(value, { timeout: 1500 });
        return true;
      } catch {
      }
    }
  }
  return false;
}

async function tryAutofillLogin(page: Page, uan: string, password: string) {
  const userSelectors = [
    'input[name="username"]',
    'input[name="uan"]',
    'input#username',
    'input#uan',
    'input[type="text"]'
  ];
  const passwordSelectors = [
    'input[name="password"]',
    'input#password',
    'input[type="password"]'
  ];

  const userFilled = await fillIfVisible(page, userSelectors, uan);
  const passFilled = await fillIfVisible(page, passwordSelectors, password);

  return userFilled && passFilled;
}

async function detectLoginState(page: Page) {
  // Use string-based evaluate to avoid tsx __name injection error
  return page.evaluate(`(() => {
    var text = (document.body && document.body.innerText || '').toLowerCase();
    var title = (document.title || '').toLowerCase();
    var url = window.location.href;
    var hasCaptchaHint = /captcha/.test(text) || /captcha/.test(title);
    var hasOtpHint = /otp|one time password|mobile verification/.test(text);
    var hasLoginForm = !!document.querySelector('input[type="password"]');
    var isLoginUrl = /memberpassbook\\/login/i.test(url);
    var seemsLoginPage = hasLoginForm || isLoginUrl;
    var hasPassbookHint = /member id|establishment|contribution|employer share|employee share|closing balance|wage month|passbook.*member/i.test(text) && !hasLoginForm;
    return { url: url, hasCaptchaHint: hasCaptchaHint, hasOtpHint: hasOtpHint, seemsLoginPage: seemsLoginPage, hasPassbookHint: hasPassbookHint, hasLoginForm: hasLoginForm, isLoginUrl: isLoginUrl };
  })()`) as Promise<{
    url: string;
    hasCaptchaHint: boolean;
    hasOtpHint: boolean;
    seemsLoginPage: boolean;
    hasPassbookHint: boolean;
    hasLoginForm: boolean;
    isLoginUrl: boolean;
  }>;
}

async function findBestPostLoginPage(context: any, fallbackPage: Page) {
  const pages = context.pages() as Page[];

  // First pass: find any page that clearly has passbook content
  for (const candidate of pages.slice().reverse()) {
    try {
      const state = await detectLoginState(candidate);
      if (state.hasPassbookHint) {
        return { page: candidate, state };
      }
    } catch {}
  }

  // Second pass: find any page that's NOT on the login URL and has no login form
  for (const candidate of pages.slice().reverse()) {
    try {
      const state = await detectLoginState(candidate);
      if (!state.isLoginUrl && !state.hasLoginForm) {
        return { page: candidate, state };
      }
    } catch {}
  }

  // Fallback
  try {
    const fallbackState = await detectLoginState(fallbackPage);
    return { page: fallbackPage, state: fallbackState };
  } catch {
    return {
      page: fallbackPage,
      state: {
        url: '',
        hasCaptchaHint: false,
        hasOtpHint: false,
        seemsLoginPage: true,
        hasPassbookHint: false,
        hasLoginForm: false,
        isLoginUrl: true
      }
    };
  }
}

async function waitForManualLoginCompletion(context: any, page: Page) {
  let attempts = 0;

  while (true) {
    attempts += 1;
    const probe = await findBestPostLoginPage(context, page);
    page = probe.page;
    const state = probe.state;

    if (state.hasCaptchaHint || state.hasOtpHint) {
      console.log('\n🔐 Additional verification detected (captcha and/or mobile OTP).');
      console.log('Complete it manually in the opened browser window.');
    }

    const pageCount = (context.pages() as Page[]).length;
    if (pageCount > 1) {
      console.log(`ℹ️ Detected ${pageCount} open browser tabs/windows. If EPFO opened passbook in a new tab, keep it active.`);
    }

    console.log('\nComplete login in browser, then press Enter here.');
    const confirm = await prompt('Press Enter after passbook page is visible (or type force to continue): ');
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    if (/^force$/i.test(confirm)) {
      console.log('⚠️ Continuing by user confirmation (force).');
      return page;
    }

    const updatedProbe = await findBestPostLoginPage(context, page);
    page = updatedProbe.page;
    const updatedState = updatedProbe.state;

    console.log(`  [debug] URL: ${updatedState.url}`);
    console.log(`  [debug] loginForm=${updatedState.hasLoginForm} loginUrl=${updatedState.isLoginUrl} passbook=${updatedState.hasPassbookHint}`);
    console.log(`  [debug] ${(context.pages() as Page[]).length} tab(s) open`);

    if (!updatedState.seemsLoginPage) {
      return page;
    }
    if (updatedState.hasPassbookHint && !updatedState.isLoginUrl) {
      return page;
    }

    if (attempts >= 3) {
      throw new Error('Still on login page after multiple attempts. Please retry `npm run pf:setup` and complete captcha/OTP.');
    }

    console.log('ℹ️ Still appears to be on login page. Let\'s try once more.');
  }
}

async function saveStorageState(context: any) {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  await context.storageState({ path: STORAGE_STATE_PATH });
}

async function setupSession() {
  console.log('🔐 EPFO Setup Session\n');
  console.log('━'.repeat(60));

  const { showPassword } = parseArgs();
  const { uan, password } = await getCredentials(showPassword);
  const browser = await launchInteractiveBrowser();
  const context = await browser.newContext();
  let page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.bringToFront().catch(() => {});
  console.log(`🔗 Opened: ${LOGIN_URL}`);
  console.log('If browser is not visible, check taskbar/Alt+Tab for a Playwright Chrome/Chromium window.');
  const filled = await tryAutofillLogin(page, uan, password);
  if (filled) {
    console.log('✅ Username/password autofilled.');
  } else {
    console.log('ℹ️ Could not reliably find login fields. Fill manually in browser.');
  }

  page = await waitForManualLoginCompletion(context, page);
  await page.bringToFront().catch(() => {});
  await saveStorageState(context);

  console.log(`✅ Session saved: ${STORAGE_STATE_PATH}`);
  await browser.close();
}

async function extractPassbookTables(page: Page) {
  // Use string-based evaluate to avoid tsx __name injection error
  return page.evaluate(`(() => {
    function textOf(el) { return (el && el.textContent || '').replace(/\\s+/g, ' ').trim(); }
    var tables = Array.from(document.querySelectorAll('table')).map(function(table, index) {
      var rows = Array.from(table.querySelectorAll('tr'));
      var parsedRows = rows.map(function(row) {
        return Array.from(row.querySelectorAll('th,td')).map(function(cell) { return textOf(cell); });
      });
      var headers = parsedRows.find(function(r) { return r.length > 1; }) || [];
      var dataRows = parsedRows.filter(function(r) { return r.length > 1; });
      return { tableIndex: index, headers: headers, rows: dataRows };
    }).filter(function(t) { return t.rows.length > 0; });
    var bodyText = document.body.innerText || '';
    return {
      extractedAt: new Date().toISOString(),
      pageTitle: document.title,
      url: window.location.href,
      tableCount: tables.length,
      tables: tables,
      bodyPreview: bodyText.slice(0, 4000)
    };
  })()`) as Promise<any>;
}

async function getYearTabs(page: Page): Promise<string[]> {
  // EPFO sidebar year tabs — they can be <a>, <li>, or styled elements
  return page.evaluate(`(() => {
    var tabs = Array.from(document.querySelectorAll('.year-list a, .year-list li, [class*="year"] a, [class*="year"] li, a, button, li'))
      .filter(function(el) { return /^\\s*\\d{4}\\s*$/.test(el.textContent || ''); })
      .map(function(el) { return (el.textContent || '').trim(); });
    return Array.from(new Set(tabs)).sort().reverse();
  })()`) as Promise<string[]>;
}

async function clickYearTab(page: Page, year: string): Promise<boolean> {
  // Use Playwright locator for more reliable clicking
  try {
    // Try clicking the year text directly with various selectors
    const yearLink = page.locator(`a:text-is("${year}"), li:text-is("${year}")`).first();
    if (await yearLink.count()) {
      await yearLink.click({ timeout: 5000 });
      return true;
    }
    // Fallback: JS click
    return page.evaluate(`((year) => {
      var els = Array.from(document.querySelectorAll('a, li, button'))
        .filter(function(el) { return (el.textContent || '').trim() === year; });
      if (els.length > 0) { els[0].click(); return true; }
      return false;
    })("${year}")`) as Promise<boolean>;
  } catch {
    return false;
  }
}

async function closeAnyModal(page: Page) {
  try {
    // Try multiple Bootstrap close button selectors
    const closeSelectors = [
      '.modal.show .btn-close',
      '.modal.show button.close',
      '.modal.show [data-bs-dismiss="modal"]',
      '.modal.show [data-dismiss="modal"]',
      '.modal.show .modal-header button',
    ];
    for (const sel of closeSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(500);
        // Verify modal is gone
        const stillOpen = await page.locator('.modal.show').isVisible({ timeout: 500 }).catch(() => false);
        if (!stillOpen) return;
      }
    }
    // Fallback: press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Fallback: force hide via JS
    const stillOpen = await page.locator('.modal.show').isVisible({ timeout: 500 }).catch(() => false);
    if (stillOpen) {
      await page.evaluate(`(() => {
        document.querySelectorAll('.modal.show').forEach(function(m) { m.classList.remove('show'); m.style.display = 'none'; });
        document.querySelectorAll('.modal-backdrop').forEach(function(b) { b.remove(); });
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('padding-right');
      })()`);
      await page.waitForTimeout(300);
    }
  } catch {}
}

async function downloadPdfForCurrentView(page: Page, context: BrowserContext, label: string): Promise<string | null> {
  await fs.mkdir(PDF_DIR, { recursive: true });

  try {
    // Step 1: Find and click "Download File" button on the page (inside active tab area)
    // This button opens the download modal popup
    const downloadFileSelectors = [
      '.v-tab-content.active button.download-btn',
      '.v-tab-content.active button[name="pb-pdf"]',
      '.v-tab-content.active a.download-btn',
      'button.download-btn',
      'button[name="pb-pdf"]',
    ];

    let clicked = false;
    for (const sel of downloadFileSelectors) {
      const btn = page.locator(sel).first();
      const isVisible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (isVisible) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Broader fallback: any visible button/link with "download" text in the active tab area
      const fallback = page.locator('.v-tab-content.active button, .v-tab-content.active a').filter({ hasText: /download/i }).first();
      const fbVisible = await fallback.isVisible({ timeout: 2000 }).catch(() => false);
      if (fbVisible) {
        await fallback.scrollIntoViewIfNeeded().catch(() => {});
        await fallback.click();
        clicked = true;
      }
    }

    if (!clicked) {
      console.log(`    ⚠️ No "Download File" button found for ${label}`);
      return null;
    }

    // Step 2: Wait for the modal popup to appear
    console.log(`    📋 Waiting for download popup...`);
    await page.waitForSelector('.modal.show, .modal[style*="display: block"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Step 3: Click "Download as PDF" button inside the modal to trigger the actual download
    const modalDownloadSelectors = [
      '.modal.show a.download-btn',
      '.modal.show button.download-btn',
      '.modal.show a[href*="pdf"]',
      '.modal.show a[download]',
    ];

    let modalBtn: any = null;
    for (const sel of modalDownloadSelectors) {
      const btn = page.locator(sel).first();
      const isVisible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
      if (isVisible) {
        modalBtn = btn;
        break;
      }
    }

    if (!modalBtn) {
      // Broader fallback: any link/button with "download" text inside the modal
      const fallback = page.locator('.modal.show a, .modal.show button').filter({ hasText: /download/i }).first();
      const fbVisible = await fallback.isVisible({ timeout: 2000 }).catch(() => false);
      if (fbVisible) {
        modalBtn = fallback;
      }
    }

    if (!modalBtn) {
      console.log(`    ⚠️ No download button found inside modal for ${label}`);
      await closeAnyModal(page);
      return null;
    }

    // Set up download listener before clicking the actual download button
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      modalBtn.click()
    ]);

    const pdfPath = path.join(PDF_DIR, `epfo-passbook-${label}.pdf`);
    await download.saveAs(pdfPath);
    console.log(`    ✅ Downloaded: epfo-passbook-${label}.pdf`);

    // Step 4: Close the modal
    await page.waitForTimeout(500);
    await closeAnyModal(page);

    return pdfPath;
  } catch (err: any) {
    // Try closing any open modal before returning
    await closeAnyModal(page);
    console.log(`    ⚠️ PDF download failed for ${label}: ${err.message}`);
    return null;
  }
}

interface PassbookEntry {
  wageMonth: string;
  transactionDate: string;
  transactionType: string;
  particulars: string;
  epfWages: number;
  epsWages: number;
  employeeShare: number;
  employerShare: number;
  pensionShare: number;
  year: string;
}

function parsePassbookPdfText(text: string, year: string): PassbookEntry[] {
  const entries: PassbookEntry[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Match pattern: "Mar-2025 14-04-2025 + Cont. For Due-Month 042025 15,000 15,000 1,800 550 1,250"
    // Or: "MonthYear DD-MM-YYYY [+/-] Description Amount Amount Amount Amount Amount"
    const match = line.match(
      /^([A-Z][a-z]{2}-\d{4})\s+(\d{2}-\d{2}-\d{4})\s+([+\-]?)\s*(.*?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s*$/i
    );

    if (match) {
      const [, wageMonth, txnDate, txnType, particulars, epfW, epsW, empShare, erShare, penShare] = match;
      const parseNum = (s: string) => parseFloat(s.replace(/,/g, '')) || 0;

      entries.push({
        wageMonth,
        transactionDate: txnDate,
        transactionType: txnType.trim() || '+',
        particulars: particulars.trim(),
        epfWages: parseNum(epfW),
        epsWages: parseNum(epsW),
        employeeShare: parseNum(empShare),
        employerShare: parseNum(erShare),
        pensionShare: parseNum(penShare),
        year
      });
    }
  }

  return entries;
}

function parseOpeningBalance(text: string): { employeeShare: number; employerShare: number; pensionShare: number } | null {
  // Look for "OB Int. Updated upto DD/MM/YYYY" line followed by amounts
  // or a line with "₹ 75,221 ₹ 22,983 ₹ 46,250"
  const obMatch = text.match(/(?:OB|Opening\s*Balance).*?([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
  if (obMatch) {
    const parseNum = (s: string) => parseFloat(s.replace(/,/g, '')) || 0;
    return {
      employeeShare: parseNum(obMatch[1]),
      employerShare: parseNum(obMatch[2]),
      pensionShare: parseNum(obMatch[3])
    };
  }
  return null;
}

function parseTotalContributions(text: string): { employeeShare: number; employerShare: number; pensionShare: number; label: string }[] {
  const totals: any[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const totalMatch = line.match(/Total\s+Contributions?\s+for\s+the\s+year\s*\[\s*(\d{4})\s*\].*?([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
    if (totalMatch) {
      const parseNum = (s: string) => parseFloat(s.replace(/,/g, '')) || 0;
      totals.push({
        label: `Total Contributions ${totalMatch[1]}`,
        employeeShare: parseNum(totalMatch[2]),
        employerShare: parseNum(totalMatch[3]),
        pensionShare: parseNum(totalMatch[4])
      });
    }
  }
  return totals;
}

async function getMemberIds(page: Page): Promise<{ id: string; selected: boolean }[]> {
  return page.evaluate(`(() => {
    var select = document.querySelector('#selectmid');
    if (!select) return [];
    return Array.from(select.querySelectorAll('option')).map(function(opt) {
      return { id: opt.value, selected: opt.selected };
    });
  })()`) as Promise<{ id: string; selected: boolean }[]>;
}

async function fetchPassbook() {
  console.log('📘 Fetch EPFO Passbook\n');
  console.log('━'.repeat(60));

  await fs.mkdir(AUTH_DIR, { recursive: true });
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.mkdir(PDF_DIR, { recursive: true });

  const browser = await launchInteractiveBrowser();
  const context = await browser.newContext({ acceptDownloads: true });
  let page = await context.newPage();

  // Step 1: Login
  console.log('\n📌 Step 1: Login to EPFO');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.bringToFront().catch(() => {});
  console.log(`🔗 Opened: ${LOGIN_URL}`);

  const { showPassword } = parseArgs();
  const { uan, password } = await getCredentials(showPassword);
  const filled = await tryAutofillLogin(page, uan, password);
  if (filled) {
    console.log('✅ Username/password autofilled. Complete the captcha in the browser.');
  } else {
    console.log('ℹ️ Fill login fields manually in the browser.');
  }

  page = await waitForManualLoginCompletion(context, page);
  await page.bringToFront().catch(() => {});
  console.log('✅ Login successful!\n');

  // Step 2: Navigate to Passbook tab (login lands on Home tab by default)
  console.log('📌 Step 2: Navigating to Passbook tab...');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  try {
    const passbookTab = page.locator('a.nav-link.page-url[data-name="passbook"]').first();
    if (await passbookTab.count()) {
      await passbookTab.click();
      console.log('  ✅ Clicked "Passbook" tab');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
    } else {
      // Maybe already on passbook page
      console.log('  ℹ️ Passbook tab not found — may already be on passbook page');
    }
  } catch {
    console.log('  ℹ️ Could not click Passbook tab — continuing with current page');
  }

  // Save HTML for debugging
  const html = await page.content();
  await fs.writeFile(OUTPUT_HTML_PATH, html, 'utf-8');

  // Detect all member accounts from dropdown
  console.log('\n📌 Detecting member accounts...');
  const memberIds = await getMemberIds(page);
  if (memberIds.length === 0) {
    console.log('  ℹ️ No member dropdown found — will process current view as single account');
    memberIds.push({ id: 'unknown', selected: true });
  }
  console.log(`  👥 Found ${memberIds.length} member account(s): ${memberIds.map(m => m.id).join(', ')}`);

  interface MemberAccountData {
    memberId: string;
    entries: PassbookEntry[];
    openingBalance: any;
    yearTotals: any[];
    yearsAvailable: string[];
    pdfFiles: string[];
    entryCount: number;
  }
  const allMemberData: MemberAccountData[] = [];

  // Helper: extract data from the currently visible table (defined once, used per member)
  const extractCurrentTabData = async () => {
    return page.evaluate(`(() => {
      function txt(el) { return (el && el.textContent || '').replace(/\\s+/g, ' ').trim(); }
      function parseNum(s) { return parseFloat((s || '0').replace(/[^\\d.]/g, '')) || 0; }

      var results = { entries: [], openingBalance: null, totals: [], memberId: null };

      // Get member ID
      var bodyText = document.body.innerText || '';
      var memberMatch = bodyText.match(/Member\\s*Id\\s*:?\\s*\\[?\\s*([A-Z0-9]+)\\s*\\]?/i);
      if (memberMatch) results.memberId = memberMatch[1];

      // Find the active/visible tab content
      var activeTab = document.querySelector('.v-tab-content.active') || document.querySelector('.v-tab-content');
      var tables = activeTab ? Array.from(activeTab.querySelectorAll('table')) : Array.from(document.querySelectorAll('table'));

      for (var ti = 0; ti < tables.length; ti++) {
        var rows = Array.from(tables[ti].querySelectorAll('tr'));
        for (var ri = 0; ri < rows.length; ri++) {
          var cells = Array.from(rows[ri].querySelectorAll('th, td')).map(function(c) { return txt(c); });

          // Opening Balance row
          if (cells.join(' ').match(/OB\\s*Int|Opening.*Balance|Updated\\s*upto/i)) {
            var obAmounts = cells.filter(function(c) { return /^[\\d,]+$/.test(c.replace(/\\s/g, '')); });
            if (obAmounts.length >= 3) {
              results.openingBalance = {
                employeeShare: parseNum(obAmounts[obAmounts.length - 3]),
                employerShare: parseNum(obAmounts[obAmounts.length - 2]),
                pensionShare: parseNum(obAmounts[obAmounts.length - 1]),
                raw: cells.join(' | ')
              };
            }
            continue;
          }

          // Total Contributions row
          var totalMatch = cells.join(' ').match(/Total\\s+Contributions?.*\\[(\\d{4})\\]/i);
          if (totalMatch) {
            var tAmounts = cells.filter(function(c) { return /^[\\u20B9\\s]*[\\d,]+$/.test(c.trim()); });
            if (tAmounts.length >= 3) {
              results.totals.push({
                label: 'Total Contributions ' + totalMatch[1],
                year: totalMatch[1],
                employeeShare: parseNum(tAmounts[tAmounts.length - 3]),
                employerShare: parseNum(tAmounts[tAmounts.length - 2]),
                pensionShare: parseNum(tAmounts[tAmounts.length - 1])
              });
            }
            continue;
          }

          // Skip other total/header rows
          if (cells.join(' ').match(/Total\\s+(Transfer|Withdraw)/i)) continue;
          if (cells.join(' ').match(/Wage\\s*Month|Particulars.*Employee.*Employer|EPF\\s*Wages/i)) continue;

          // Data rows
          var monthCell = cells.find(function(c) { return /^[A-Z][a-z]{2}-\\d{4}$/.test(c); });
          var dateCell = cells.find(function(c) { return /^\\d{2}-\\d{2}-\\d{4}$/.test(c); });

          if (monthCell && dateCell) {
            var nums = cells.filter(function(c) { return /^[\\d,]+$/.test(c.replace(/\\s/g, '')); }).map(parseNum);
            var txnType = cells.find(function(c) { return /^[+\\-]$/.test(c.trim()); }) || '+';
            var particulars = cells.find(function(c) { return /Cont\\.|Due-Month|Interest|Transfer|Withdraw/i.test(c); }) || '';

            if (nums.length >= 5) {
              var yearMatch = monthCell.match(/(\\d{4})/);
              results.entries.push({
                wageMonth: monthCell,
                transactionDate: dateCell,
                transactionType: typeof txnType === 'string' ? txnType.trim() : '+',
                particulars: particulars || '',
                epfWages: nums[nums.length - 5],
                epsWages: nums[nums.length - 4],
                employeeShare: nums[nums.length - 3],
                employerShare: nums[nums.length - 2],
                pensionShare: nums[nums.length - 1],
                year: yearMatch ? yearMatch[1] : ''
              });
            }
          }
        }
      }
      return results;
    })()`) as any;
  };

  // ── Process each member account ──
  for (let mi = 0; mi < memberIds.length; mi++) {
    const currentMemberId = memberIds[mi].id;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`👤 Member Account ${mi + 1}/${memberIds.length}: ${currentMemberId}`);
    console.log('═'.repeat(60));

    // Switch member if not already selected
    if (!memberIds[mi].selected) {
      console.log(`  🔄 Switching to member ${currentMemberId}...`);
      try {
        const navPromise = page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle' });
        await page.selectOption('#selectmid', currentMemberId);
        await navPromise;
        await page.waitForTimeout(2000);

        // After page reload, click Passbook tab if available
        try {
          const passbookTab = page.locator('a.nav-link.page-url[data-name="passbook"]').first();
          if (await passbookTab.count()) {
            await passbookTab.click();
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(3000);
          }
        } catch {}

        console.log(`  ✅ Switched to member ${currentMemberId}`);
      } catch (err: any) {
        console.log(`  ❌ Failed to switch to member ${currentMemberId}: ${err.message?.slice(0, 100)}`);
        continue;
      }
    }

    // Step 3: Discover year tabs for this member
    console.log(`\n  📌 Step 3: Discovering year tabs for ${currentMemberId}...`);
    const yearTabs = await getYearTabs(page);
    console.log(`    📅 Found: ${yearTabs.join(', ') || '(none detected)'}`);

    // Step 4: Extract data + download PDFs per year
    console.log(`\n  📌 Step 4: Extracting passbook data...`);
    const allEntries: PassbookEntry[] = [];
    let openingBalance: any = null;
    const yearTotals: any[] = [];
    let detectedMemberId: string | null = null;

    const downloadedPdfs: { year: string; pdfPath: string }[] = [];
    for (let yi = 0; yi < yearTabs.length; yi++) {
      const year = yearTabs[yi];
      console.log(`\n    📅 Year: ${year} (${yi + 1}/${yearTabs.length})`);

    // Click year tab using the data-year attribute
    try {
      // First ensure no modal is blocking
      await closeAnyModal(page);

      const yearLink = page.locator(`a[data-year="${year}"]`).first();
      const count = await yearLink.count();
      if (count) {
        await yearLink.scrollIntoViewIfNeeded().catch(() => {});
        await yearLink.click({ timeout: 5000 });
      } else {
        // Fallback: text match
        const fallback = page.locator(`a:text-is("${year}"), li:text-is("${year}")`).first();
        await fallback.scrollIntoViewIfNeeded().catch(() => {});
        await fallback.click({ timeout: 5000 });
      }
    } catch (err: any) {
      console.log(`    ⚠️ Could not click year tab ${year}: ${err.message?.slice(0, 80)}`);
      continue;
    }

    // Wait for AJAX content to load into the tab
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Check if the active tab now has table data
    const hasData = await page.evaluate(`(() => {
      var active = document.querySelector('.v-tab-content.active');
      if (!active) return false;
      var rows = active.querySelectorAll('table tr');
      return rows.length > 2;
    })()`);

    if (!hasData) {
      console.log(`    ℹ️ No data loaded for ${year} (may have no contributions)`);
      continue;
    }

    const yearData = await extractCurrentTabData();
    if (yearData.entries && yearData.entries.length > 0) {
      allEntries.push(...yearData.entries);
      console.log(`    ✅ ${yearData.entries.length} entries extracted`);
    } else {
      console.log(`    ℹ️ No transaction entries found`);
    }

    if (yearData.openingBalance && !openingBalance) {
      openingBalance = yearData.openingBalance;
    }
    if (yearData.totals) {
      yearTotals.push(...yearData.totals);
    }
    if (yearData.memberId && !detectedMemberId) {
      detectedMemberId = yearData.memberId;
    }

    // Download PDF for this year — include memberId in filename when multiple accounts
    const pdfLabel = memberIds.length > 1 ? `${currentMemberId}-${year}` : year;
    const pdfPath = await downloadPdfForCurrentView(page, context, pdfLabel);
    if (pdfPath) {
      downloadedPdfs.push({ year, pdfPath });
    }
  }

    // Step 5: Parse downloaded PDFs to text
    if (downloadedPdfs.length > 0) {
      console.log(`\n  📌 Step 5: Saving PDF text for ${currentMemberId}...`);
    try {
      const { PDFParse } = require('pdf-parse');

      for (const { year, pdfPath } of downloadedPdfs) {
        try {
          const pdfBuffer = await fs.readFile(pdfPath);
          const parser = new PDFParse(new Uint8Array(pdfBuffer));
          await parser.load();
          const result = await parser.getText();
          const text = result.pages?.map((p: any) => p.text).join('\n\n') || '';
          await fs.writeFile(pdfPath.replace('.pdf', '.txt'), text, 'utf-8');
          console.log(`    📄 ${year}: PDF text saved (${text.length} chars)`);
          parser.destroy();
        } catch (err: any) {
          console.log(`    ⚠️ Failed to parse ${year} PDF: ${err.message}`);
        }
      }
      } catch (err: any) {
        console.log(`    ⚠️ pdf-parse not available: ${err.message}`);
      }
    }

    // Collect this member's data — use currentMemberId from dropdown, not detectedMemberId from page body
    // (page body always shows the first member's ID regardless of dropdown selection)
    allMemberData.push({
      memberId: currentMemberId,
      entries: allEntries,
      openingBalance,
      yearTotals,
      yearsAvailable: yearTabs,
      pdfFiles: downloadedPdfs.map(d => d.pdfPath),
      entryCount: allEntries.length
    });

    console.log(`\n  ✅ Member ${currentMemberId}: ${allEntries.length} entries across ${yearTabs.length} years`);
  } // end member loop

  // Step 6: Build combined output
  const output = {
    extractedAt: new Date().toISOString(),
    memberAccounts: allMemberData,
    totalEntryCount: allMemberData.reduce((s, m) => s + m.entryCount, 0),
    totalMemberAccounts: allMemberData.length
  };

  await fs.writeFile(OUTPUT_JSON_PATH, JSON.stringify(output, null, 2));
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`✅ Saved JSON: ${OUTPUT_JSON_PATH}`);
  console.log(`👥 Member accounts: ${allMemberData.length}`);
  console.log(`📊 Total entries: ${output.totalEntryCount}`);

  for (const member of allMemberData) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`👤 ${member.memberId}`);
    console.log(`📅 Years: ${member.yearsAvailable.join(', ')}`);
    console.log(`📊 Entries: ${member.entryCount}`);
    console.log(`📥 PDFs: ${member.pdfFiles.length}`);

    if (member.openingBalance) {
      console.log(`\n💰 Opening Balance:`);
      console.log(`   Employee Share: ₹${member.openingBalance.employeeShare.toLocaleString('en-IN')}`);
      console.log(`   Employer Share: ₹${member.openingBalance.employerShare.toLocaleString('en-IN')}`);
      console.log(`   Pension Share:  ₹${member.openingBalance.pensionShare.toLocaleString('en-IN')}`);
    }

    if (member.yearTotals.length > 0) {
      console.log(`\n📊 Annual Totals:`);
      for (const t of member.yearTotals) {
        console.log(`   ${t.label}: Employee ₹${t.employeeShare.toLocaleString('en-IN')} | Employer ₹${t.employerShare.toLocaleString('en-IN')} | Pension ₹${t.pensionShare.toLocaleString('en-IN')}`);
      }
    }

    if (member.entries.length > 0) {
      const byYear = new Map<string, PassbookEntry[]>();
      for (const e of member.entries) {
        const y = e.year || 'Unknown';
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y)!.push(e);
      }

      console.log(`\n📋 Entries by Year:`);
      for (const [yr, entries] of byYear) {
        console.log(`\n  ── ${yr} (${entries.length} entries) ──`);
        console.log(`  ${'Wage Month'.padEnd(12)} ${'Txn Date'.padEnd(12)} ${'Employee'.padStart(10)} ${'Employer'.padStart(10)} ${'Pension'.padStart(10)} Particulars`);
        for (const e of entries) {
          console.log(`  ${e.wageMonth.padEnd(12)} ${e.transactionDate.padEnd(12)} ${('₹' + e.employeeShare.toLocaleString('en-IN')).padStart(10)} ${('₹' + e.employerShare.toLocaleString('en-IN')).padStart(10)} ${('₹' + e.pensionShare.toLocaleString('en-IN')).padStart(10)} ${e.particulars}`);
        }

        const empTotal = entries.reduce((s, e) => s + e.employeeShare, 0);
        const erTotal = entries.reduce((s, e) => s + e.employerShare, 0);
        const penTotal = entries.reduce((s, e) => s + e.pensionShare, 0);
        console.log(`  ${''.padEnd(12)} ${'TOTAL'.padEnd(12)} ${('₹' + empTotal.toLocaleString('en-IN')).padStart(10)} ${('₹' + erTotal.toLocaleString('en-IN')).padStart(10)} ${('₹' + penTotal.toLocaleString('en-IN')).padStart(10)}`);
      }

      const grandEmp = member.entries.reduce((s, e) => s + e.employeeShare, 0);
      const grandEr = member.entries.reduce((s, e) => s + e.employerShare, 0);
      const grandPen = member.entries.reduce((s, e) => s + e.pensionShare, 0);
      console.log(`\n  ══ MEMBER TOTAL: Employee ₹${grandEmp.toLocaleString('en-IN')} | Employer ₹${grandEr.toLocaleString('en-IN')} | Pension ₹${grandPen.toLocaleString('en-IN')} ══`);
    }
  }

  // Grand totals across all members
  if (allMemberData.length > 1) {
    const combinedEntries = allMemberData.flatMap(m => m.entries);
    const grandEmp = combinedEntries.reduce((s, e) => s + e.employeeShare, 0);
    const grandEr = combinedEntries.reduce((s, e) => s + e.employerShare, 0);
    const grandPen = combinedEntries.reduce((s, e) => s + e.pensionShare, 0);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🏦 GRAND TOTAL (all ${allMemberData.length} accounts): Employee ₹${grandEmp.toLocaleString('en-IN')} | Employer ₹${grandEr.toLocaleString('en-IN')} | Pension ₹${grandPen.toLocaleString('en-IN')}`);
    console.log('═'.repeat(60));
  }

  if (output.totalEntryCount === 0) {
    console.log('\n⚠️ No entries parsed. Check the saved HTML for page structure.');
  }

  await browser.close();
}

async function main() {
  const { setup, fetch, forgetCreds } = parseArgs();

  if (forgetCreds) {
    await clearStoredCredentials();
    if (!setup && !fetch) {
      process.exit(0);
    }
  }

  if (!setup && !fetch) {
    console.log('Usage:');
    console.log('  npm run pf:setup   # guided login + session save');
    console.log('  npm run pf:setup:visible # setup with visible password input (temporary)');
    console.log('  npm run pf:fetch   # open passbook and extract table data');
    console.log('  npm run pf:forget-creds # remove securely saved EPFO credentials');
    process.exit(0);
  }

  if (setup) {
    await setupSession();
  }

  if (fetch) {
    await fetchPassbook();
  }
}

main().catch((error: any) => {
  console.error('\n❌ EPFO workflow failed:', error.message || error);
  process.exit(1);
});
