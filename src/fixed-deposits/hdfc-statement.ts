import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import dotenv from 'dotenv';
import readline from 'readline';
import { chromium, type Page } from 'playwright';

dotenv.config();

const LOGIN_URL = 'https://online.hdfc.bank.in/HdfcDeposits/';
const AUTH_DIR = path.join(process.cwd(), 'data', '.auth');
const RAW_DIR = path.join(process.cwd(), 'data', 'raw-extracts');
const PDF_DIR = path.join(RAW_DIR, 'hdfc-fd-pdfs');
const SECURE_DIR = path.join(process.cwd(), 'data', '.secure');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'hdfc-fd-storage-state.json');
const SECURE_CREDS_PATH = path.join(SECURE_DIR, 'hdfc-fd-creds.enc.json');
const OUTPUT_JSON_PATH = path.join(process.cwd(), 'data', 'hdfc-fd-statement.json');
const SNAPSHOT_PATH = path.join(RAW_DIR, 'hdfc-fd-table-snapshot.json');
const DASHBOARD_PDF_REQUEST_GAP_MS = 5000;
const DASHBOARD_PDF_RATE_LIMIT_BACKOFF_MS = 15000;
const DASHBOARD_PDF_MAX_ATTEMPTS = 4;

interface EncPayload {
  version: 2;
  data: string;
  iv: string;
  tag: string;
  savedAt: string;
}

interface StoredCreds {
  pan: string;
  dob: string;
}

interface PageState {
  url: string;
  hasPasswordField: boolean;
  hasOtpInput: boolean;
  hasPanInput: boolean;
  hasDobInput: boolean;
  hasAuthScreen: boolean;
  hasLoginHint: boolean;
  hasFdHint: boolean;
}

interface LoginProgressState {
  loginFlag: string;
  loginCategory: string;
  loginCustNo: string;
  panValue: string;
  dobValue: string;
  custNo: string;
  custNoAfter: string;
  emailValue: string;
  otpVisible: boolean;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    setup: args.includes('--setup'),
    fetch: args.includes('--fetch'),
    forgetCreds: args.includes('--forget-creds'),
    headed: args.includes('--headed') || args.includes('--setup') || args.includes('--fetch'),
  };
}

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(question: string): Promise<string> {
  const rl = createRl();
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function deriveKey(salt: string): Buffer {
  const machineId = `${os.hostname()}:${os.userInfo().username}:${salt}`;
  return crypto.pbkdf2Sync(machineId, 'hdfc-fd-salt-20260309', 100000, 32, 'sha256');
}

function encrypt(plainJson: string, salt: string): { encrypted: string; iv: string; tag: string } {
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()]);
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(encrypted: string, ivB64: string, tagB64: string, salt: string): string {
  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

async function loadCreds(): Promise<StoredCreds | null> {
  try {
    const raw = JSON.parse(await fs.readFile(SECURE_CREDS_PATH, 'utf-8')) as EncPayload;
    if (raw.version !== 2) return null;
    const parsed = JSON.parse(decrypt(raw.data, raw.iv, raw.tag, 'hdfc-fd-creds-v2')) as any;
    const pan = String(parsed?.pan || parsed?.loginId || '').trim();
    const dob = String(parsed?.dob || '').trim();
    if (!pan || !dob) return null;
    return { pan, dob };
  } catch {
    return null;
  }
}

async function saveCreds(pan: string, dob: string) {
  await fs.mkdir(SECURE_DIR, { recursive: true });
  const { encrypted, iv, tag } = encrypt(JSON.stringify({ pan, dob }), 'hdfc-fd-creds-v2');
  const payload: EncPayload = {
    version: 2,
    data: encrypted,
    iv,
    tag,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(SECURE_CREDS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

async function clearCreds() {
  await fs.unlink(SECURE_CREDS_PATH).catch(() => {});
  await fs.unlink(STORAGE_STATE_PATH).catch(() => {});
  console.log('Cleared stored HDFC FD PAN/DOB and session state');
}

function normalizeDob(input: string): string {
  const trimmed = input.trim();
  const parts = trimmed.split(/[-/]/).map(part => part.trim()).filter(Boolean);
  if (parts.length === 3) {
    const [first, second, third] = parts;
    const monthMap: Record<string, string> = {
      jan: '01',
      feb: '02',
      mar: '03',
      apr: '04',
      may: '05',
      jun: '06',
      jul: '07',
      aug: '08',
      sep: '09',
      oct: '10',
      nov: '11',
      dec: '12',
    };

    if (first.length === 4) {
      const month = monthMap[second.toLowerCase()] || second.padStart(2, '0');
      return `${third.padStart(2, '0')}-${month}-${first}`;
    }

    const month = monthMap[second.toLowerCase()] || second.padStart(2, '0');
    return `${first.padStart(2, '0')}-${month}-${third}`;
  }
  return trimmed;
}

function parseDobParts(value: string): { day: string; month: string; year: string } | null {
  const match = normalizeDob(value).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;
  return {
    day: match[1],
    month: match[2],
    year: match[3],
  };
}

function isDobFormat(value: string): boolean {
  return /^\d{2}-\d{2}-\d{4}$/.test(value);
}

function formatDobForHdfc(value: string): string {
  const parts = parseDobParts(value);
  if (!parts) return value;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = Number(parts.month) - 1;
  const monthName = monthNames[monthIndex] || parts.month;
  return `${parts.day}-${monthName}-${parts.year}`;
}

async function getCredentials(): Promise<StoredCreds> {
  const saved = await loadCreds();
  if (saved) {
    const useSaved = await prompt('Use securely saved HDFC FD PAN and DOB? (Y/n): ');
    if (!useSaved || /^y(es)?$/i.test(useSaved)) {
      return saved;
    }
  }

  let pan = process.env.HDFC_FD_PAN || process.env.HDFC_FD_LOGIN_ID || '';
  let dob = process.env.HDFC_FD_DOB || '';

  if (!pan) {
    pan = await prompt('Enter HDFC FD PAN: ');
  }

  if (!dob) {
    dob = await prompt('Enter HDFC FD Date of Birth (DD-MM-YYYY or DD-MMM-YYYY): ');
  }

  pan = pan.trim().toUpperCase();
  dob = normalizeDob(dob);
  if (!pan) {
    throw new Error('PAN is required');
  }
  if (!isDobFormat(dob)) {
    throw new Error('Date of birth must be in DD-MM-YYYY or DD-MMM-YYYY format');
  }

  const saveChoice = await prompt('Save HDFC FD PAN and DOB securely on this device? (Y/n): ');
  if (!saveChoice || /^y(es)?$/i.test(saveChoice)) {
    await saveCreds(pan, dob);
    console.log(`PAN/DOB saved (AES-256-GCM): ${SECURE_CREDS_PATH}`);
  }

  return { pan, dob };
}

async function launchBrowser(headed: boolean) {
  const launchOptions = {
    headless: !headed,
    args: ['--start-maximized'],
  };

  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    console.log('Chrome channel not found. Using bundled Chromium.');
    return await chromium.launch(launchOptions);
  }
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.fill(value, { timeout: 3000 });
        return true;
      } catch {
        // Try next selector.
      }
    }
  }
  return false;
}

async function fillPanField(page: Page, pan: string): Promise<boolean> {
  const selectors = [
    '#txtPANEmail',
    'input[placeholder="PAN"]',
    'input[placeholder*="PAN" i]',
    'input[name*="pan" i]',
    'input[id*="pan" i]',
    'input[type="text"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) continue;

    try {
      await locator.click({ timeout: 2000 });
    } catch {
      // Ignore click failure and try direct assignment.
    }

    try {
      const currentValue = await locator.evaluate((node, nextPan) => {
        const input = node as any;
        const globalScope = globalThis as any;
        input.removeAttribute('readonly');
        input.removeAttribute('disabled');
        input.value = nextPan as string;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('keyup', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        input.dispatchEvent(new Event('focusout', { bubbles: true }));
        if (typeof globalScope.fnValidatePANCharacter === 'function') {
          globalScope.fnValidatePANCharacter(input.value);
        }
        return input.value;
      }, pan);

      if (currentValue.trim().toUpperCase() === pan.toUpperCase()) {
        return true;
      }
    } catch {
      // Fall back to standard fill.
    }

    try {
      await locator.fill(pan, { timeout: 2000 });
      await locator.press('Tab').catch(() => {});
      return true;
    } catch {
      // Try next selector.
    }
  }

  return false;
}

async function getLoginProgressState(page: Page): Promise<LoginProgressState> {
  return page.evaluate(`(() => {
    function isVisible(el) {
      if (!el) return false;
      var style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetParent !== null;
    }

    function value(selector) {
      var el = document.querySelector(selector);
      return el && 'value' in el ? (el.value || '').trim() : '';
    }

    var otpModal = document.querySelector('#LoginWithOTP');

    return {
      loginFlag: sessionStorage.getItem('LOGIN_FLAG') || '',
      loginCategory: sessionStorage.getItem('LOGIN_CATEGORY') || '',
      loginCustNo: sessionStorage.getItem('LOGIN_CUST_NO') || '',
      panValue: value('#txtPANEmail'),
      dobValue: value('#txtDOB'),
      custNo: value('#txtCustNo'),
      custNoAfter: value('#txtCustNoAfter'),
      emailValue: value('#txtLogiEmailID'),
      otpVisible: isVisible(document.querySelector('#txtOTP_FOM')) || isVisible(otpModal)
    };
  })()`) as Promise<LoginProgressState>;
}

async function waitForLoginAdvance(
  page: Page,
  previousState: LoginProgressState | null,
  expectedFlags: string[],
  timeout = 10000,
): Promise<LoginProgressState | null> {
  try {
    await page.waitForFunction(({ expectedFlags, previousFlag, previousCustNo }) => {
      const globalScope = globalThis as any;
      const doc = globalScope.document;
      const storage = globalScope.sessionStorage;

      function isVisible(el: any) {
        if (!el) return false;
        var style = globalScope.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetParent !== null;
      }

      var currentFlag = storage?.getItem('LOGIN_FLAG') || '';
      var currentCustNo = storage?.getItem('LOGIN_CUST_NO') || '';
      var otpModal = doc?.querySelector('#LoginWithOTP');

      return expectedFlags.indexOf(currentFlag) !== -1
        || !!(currentFlag && currentFlag !== previousFlag)
        || !!(currentCustNo && currentCustNo !== previousCustNo)
        || isVisible(doc?.querySelector('#txtOTP_FOM'))
        || isVisible(otpModal);
    }, {
      expectedFlags,
      previousFlag: previousState?.loginFlag || '',
      previousCustNo: previousState?.loginCustNo || '',
    }, { timeout });

    return getLoginProgressState(page);
  } catch {
    return null;
  }
}

async function triggerPanCategoryCheck(page: Page, pan: string, dob?: string): Promise<boolean> {
  try {
    return await page.evaluate(({ panValue, dobValue }) => {
      const globalScope = globalThis as any;
      const $ = globalScope.jQuery || globalScope.$;
      const doc = globalScope.document;
      const storage = globalScope.sessionStorage;
      if (!$ || typeof globalScope.P_PAN_CATEGORY_ENTITY_CHECK !== 'function') {
        return false;
      }

      function setValue(selector: string, value: string) {
        const input = doc?.querySelector(selector) as any;
        if (!input) return '';
        input.removeAttribute('readonly');
        input.removeAttribute('disabled');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        input.dispatchEvent(new Event('focusout', { bubbles: true }));
        return input.value;
      }

      setValue('#txtPANEmail', panValue);
      if (dobValue) {
        setValue('#txtDOB', dobValue);
      }

      if (typeof globalScope.fnValidatePANCharacter === 'function') {
        globalScope.fnValidatePANCharacter(panValue);
      }

      const customerNumber = $.trim($('#txtCustNo').val())
        || $.trim($('#txtCustNoAfter').val())
        || $.trim(storage?.getItem('LOGIN_CUST_NO') || '');
      const email = $.trim($('#txtLogiEmailID').val()) || '';
      globalScope.P_PAN_CATEGORY_ENTITY_CHECK($.trim(panValue), customerNumber, email, dobValue ? $.trim(dobValue) : '');
      return true;
    }, {
      panValue: pan,
      dobValue: dob ? formatDobForHdfc(dob) : '',
    });
  } catch {
    return false;
  }
}

async function fillDobField(page: Page, dob: string): Promise<boolean> {
  const normalizedDob = normalizeDob(dob);
  const formattedDob = formatDobForHdfc(normalizedDob);
  const dobParts = parseDobParts(normalizedDob);
  const selectors = ['#txtDOB', 'input[placeholder="DD-MM-YYYY"]', 'input[id*="dob" i]'];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) continue;

    try {
      await locator.click({ timeout: 2000 });
    } catch {
      // Ignore click failure and try JS assignment.
    }

    try {
      const currentValue = await locator.evaluate((node, payload) => {
        const input = node as any;
        const globalScope = globalThis as any;
        const $ = globalScope.jQuery || globalScope.$;
        const hasDatepicker = !!($ && $.fn && typeof $.fn.datepicker === 'function');
        const targetDate = payload.dobParts
          ? new Date(Number(payload.dobParts.year), Number(payload.dobParts.month) - 1, Number(payload.dobParts.day))
          : null;

        const setValue = (value: string) => {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        input.removeAttribute('readonly');
        input.removeAttribute('disabled');

        try {
          input.focus();
        } catch {
          // Ignore focus failure and continue.
        }

        if (hasDatepicker && targetDate) {
          try {
            $(input).datepicker('setDate', targetDate);
          } catch {
            // Ignore plugin-specific errors and fall back to direct assignment.
          }

          if (!input.value) {
            try {
              $(input).datepicker('update', payload.formattedDob);
            } catch {
              // Ignore unsupported update API.
            }
          }
        }

        if (!input.value && payload.formattedDob) {
          setValue(payload.formattedDob);
        }

        if (!input.value && payload.normalizedDob) {
          setValue(payload.normalizedDob);
        }

        input.dispatchEvent(new Event('blur', { bubbles: true }));
        input.dispatchEvent(new Event('focusout', { bubbles: true }));
        return input.value;
      }, {
        normalizedDob,
        formattedDob,
        dobParts,
      });

      if (currentValue.trim()) {
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  return false;
}

async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.click({ timeout: 3000 });
        return true;
      } catch {
        // Try next selector.
      }
    }
  }
  return false;
}

async function getPageState(page: Page): Promise<PageState> {
  return page.evaluate(`(() => {
    function isVisible(el) {
      if (!el) return false;
      var style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetParent !== null;
    }

    var text = ((document.body && document.body.innerText) || '').toLowerCase();
    var url = (window.location.href || '').toLowerCase();
    var inputs = Array.from(document.querySelectorAll('input')).filter(function(i) {
      var type = (i.getAttribute('type') || '').toLowerCase();
      return type !== 'hidden';
    });

    var hasPasswordField = !!document.querySelector('input[type="password"]');
    var panField = document.querySelector('#txtPANEmail');
    var hasPanInput = isVisible(panField) || inputs.some(function(i) {
      var bag = [i.id || '', i.name || '', i.placeholder || '', i.getAttribute('aria-label') || '']
        .join(' ')
        .toLowerCase();
      return /\bpan\b/.test(bag);
    });
    var dobField = document.querySelector('#txtDOB');
    var hasDobInput = isVisible(dobField) || inputs.some(function(i) {
      var bag = [i.id || '', i.name || '', i.placeholder || '', i.getAttribute('aria-label') || '']
        .join(' ')
        .toLowerCase();
      return /date of birth|dob|dd-mm-yyyy/.test(bag);
    });
    var otpField = document.querySelector('#txtOTP_FOM');
    var hasOtpInput = isVisible(otpField) || inputs.some(function(i) {
      var bag = [i.id || '', i.name || '', i.placeholder || '', i.getAttribute('aria-label') || '']
        .join(' ')
        .toLowerCase();
      return /otp|one time password|verification code/.test(bag);
    });

    var otpHeading = /login with otp/.test(text) || !!document.querySelector('#lnkLoginThroughOTP');
    var proceedButton = document.querySelector('#btnGenerateOtp, #btnLogin, #btnSubmit_FOM');
    var clearButton = document.querySelector('#btnClear');
    var hasAuthScreen = otpHeading || ((hasPanInput || hasDobInput || hasOtpInput) && isVisible(proceedButton)) || (isVisible(proceedButton) && isVisible(clearButton) && /important note/.test(text));

    var hasLoginHint = /login|sign in|customer id|user id|pan|otp|proceed/.test(text) || /signin|login/.test(url);
    var hasFdHint = !hasAuthScreen && /my deposits|deposit summary|deposit details|fd number|deposit no|download statement|download advice|maturity date/.test(text);

    return {
      url: url,
      hasPasswordField: hasPasswordField,
      hasOtpInput: hasOtpInput,
      hasPanInput: hasPanInput,
      hasDobInput: hasDobInput,
      hasAuthScreen: hasAuthScreen,
      hasLoginHint: hasLoginHint,
      hasFdHint: hasFdHint
    };
  })()`) as Promise<PageState>;
}

function needsLogin(state: PageState): boolean {
  if (state.hasFdHint && !state.hasAuthScreen) return false;
  return state.hasAuthScreen || state.hasPanInput || state.hasDobInput || state.hasOtpInput || (state.hasLoginHint && !state.hasFdHint);
}

async function autofillLogin(page: Page, creds: StoredCreds) {
  await clickFirst(page, ['text=Login With OTP', 'text=LOGIN WITH OTP']);

  const panFilled = await fillPanField(page, creds.pan);

  if (panFilled) {
    console.log('PAN autofilled');
  } else {
    console.log('Could not auto-fill PAN. Enter it manually in browser.');
  }

  let loginState = await getLoginProgressState(page);
  if (panFilled) {
    const panAdvance = await waitForLoginAdvance(page, loginState, ['ASK_DOB', 'ASK_CUST_NO', 'ASK_EMAIL_ID', 'PROCEED']);
    if (panAdvance) {
      loginState = panAdvance;
    } else if (await triggerPanCategoryCheck(page, creds.pan)) {
      const triggeredPanAdvance = await waitForLoginAdvance(page, loginState, ['ASK_DOB', 'ASK_CUST_NO', 'ASK_EMAIL_ID', 'PROCEED']);
      if (triggeredPanAdvance) {
        loginState = triggeredPanAdvance;
      }
    }
  }

  const dobFilled = await fillDobField(page, creds.dob);
  if (dobFilled) {
    console.log('DOB autofilled');
  } else {
    console.log('Could not auto-fill DOB. Enter it manually in browser.');
  }

  if (dobFilled) {
    const dobAdvance = await waitForLoginAdvance(page, loginState, ['PROCEED', 'ASK_CUST_NO', 'ASK_EMAIL_ID']);
    if (dobAdvance) {
      loginState = dobAdvance;
    } else if (await triggerPanCategoryCheck(page, creds.pan, creds.dob)) {
      const triggeredDobAdvance = await waitForLoginAdvance(page, loginState, ['PROCEED', 'ASK_CUST_NO', 'ASK_EMAIL_ID']);
      if (triggeredDobAdvance) {
        loginState = triggeredDobAdvance;
      }
    }
  }

  console.log(
    `Login pre-check state: flag=${loginState.loginFlag || '(empty)'}, category=${loginState.loginCategory || '(empty)'}, custNo=${loginState.loginCustNo || '(empty)'}`,
  );

  if (loginState.loginFlag === 'ASK_CUST_NO') {
    console.log('HDFC requested Customer No. Enter it manually in browser before continuing.');
    return;
  }

  if (loginState.loginFlag === 'ASK_EMAIL_ID') {
    console.log('HDFC requested Email ID. Enter it manually in browser before continuing.');
    return;
  }

  const clicked = await clickFirst(page, [
    '#btnGenerateOtp',
    'button:has-text("Proceed")',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign In")',
    'text=PROCEED',
  ]);

  if (clicked) {
    await page.waitForTimeout(1500);
    const postClickState = await getLoginProgressState(page);
    if (postClickState.otpVisible) {
      console.log('OTP dialog opened');
    }
  }
}

async function waitForPostLogin(page: Page): Promise<void> {
  for (let i = 1; i <= 4; i++) {
    const state = await getPageState(page);
    if (!needsLogin(state)) {
      console.log('Login appears complete');
      return;
    }

    if (state.hasOtpInput || state.hasAuthScreen) {
      console.log('OTP input detected. Complete OTP manually in browser.');
    } else {
      console.log('Finish any pending verification manually in browser.');
    }

    await prompt(`Press Enter after completing login/OTP (attempt ${i}/4): `);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }

  throw new Error('Login did not complete after multiple attempts');
}

async function ensureDepositSection(page: Page) {
  const state = await getPageState(page);
  if (state.hasFdHint) {
    await waitForDashboardDeposits(page);
    return;
  }

  const moved = await clickFirst(page, [
    'a:has-text("My Deposits")',
    'button:has-text("My Deposits")',
    'a:has-text("Deposit Summary")',
    'button:has-text("Deposit Summary")',
    'a:has-text("Fixed Deposit")',
    'button:has-text("Fixed Deposit")',
    'a:has-text("View Deposits")',
  ]);

  if (moved) {
    await page.waitForTimeout(1500);
    return;
  }

  console.log('Could not auto-navigate to deposits page.');
  await prompt('Open the deposits details page manually, then press Enter: ');
  await waitForDashboardDeposits(page);
}

async function waitForDashboardDeposits(page: Page): Promise<void> {
  await clickFirst(page, [
    'text=OPEN DEPOSITS',
    'a:has-text("OPEN DEPOSITS")',
    'button:has-text("OPEN DEPOSITS")',
  ]);

  try {
    await page.waitForFunction(`(() => {
      const table = document.querySelector('#tablemydep');
      if (!table) return false;
      const rows = table.querySelectorAll('tr').length;
      const pdfIcons = table.querySelectorAll('span.icon-pdf').length;
      return rows > 1 || pdfIcons > 0;
    })()`, undefined, { timeout: 15000 });
  } catch {
    await page.waitForTimeout(3000);
  }
}

function normalizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

function buildDashboardPdfName(actionKey: string, fallbackName: string, index: number): string {
  const match = actionKey.match(/GET_DASHBOARD_DOC\('([^']+)','([^']+)'\)/i);
  if (match) {
    return normalizeFileName(`hdfc-fd-${index + 1}-${match[2]}-${match[1]}.pdf`);
  }

  const normalizedFallback = normalizeFileName(fallbackName || `hdfc-fd-${index + 1}.pdf`);
  if (normalizedFallback === 'file.pdf') {
    return normalizeFileName(`hdfc-fd-${index + 1}.pdf`);
  }
  return normalizedFallback;
}

function parseDashboardAction(actionKey: string): { documentId: string; documentType: string } | null {
  const match = actionKey.match(/GET_DASHBOARD_DOC\('([^']+)','([^']+)'\)/i);
  if (!match) return null;
  return {
    documentId: match[1],
    documentType: match[2],
  };
}

function isRateLimitedDashboardResponse(result: any): boolean {
  if (!result) return false;
  const message = String(result.message || '').toLowerCase();
  return result.reason === 'unexpected-response-code' && message.includes('too many requests');
}

async function requestDashboardPdf(page: Page, documentId: string, documentType: string): Promise<any> {
  const responsePromise = page.waitForResponse(response => {
    return response.url().includes('/Dashboard/GET_DASHBOARD_DOC')
      && response.request().method().toUpperCase() === 'POST';
  }, { timeout: 15000 }).catch(() => null);

  const triggerResult = await page.evaluate(({ nextDocumentId, nextDocumentType }) => {
    const globalScope = globalThis as any;
    const hiddenInput = globalScope.document?.querySelector('#hdnPdfName_Dashboard') as any;
    const objectHost = globalScope.document?.querySelector('#dvPDFObject_Dashboard') as any;

    if (hiddenInput) {
      hiddenInput.value = '';
    }

    if (objectHost) {
      objectHost.innerHTML = '';
    }

    if (typeof globalScope.PDF_DASHBOARD !== 'undefined') {
      globalScope.PDF_DASHBOARD = '';
    }

    if (typeof globalScope.GET_DASHBOARD_DOC !== 'function') {
      return { ok: false, reason: 'missing-get-dashboard-doc' };
    }

    globalScope.GET_DASHBOARD_DOC(nextDocumentId, nextDocumentType);
    return { ok: true };
  }, {
    nextDocumentId: documentId,
    nextDocumentType: documentType,
  }).catch((error: any) => ({
    ok: false,
    reason: 'evaluate-failed',
    message: error?.message || String(error),
  }));

  if (!triggerResult?.ok) {
    return triggerResult;
  }

  const response = await responsePromise;
  if (!response) {
    return { ok: false, reason: 'missing-dashboard-response' };
  }

  const rawPayload = await response.text().catch(() => '');

  try {
    const parsed = JSON.parse(rawPayload);
    const code = String(parsed?.CODE ?? parsed?.[0]?.CODE ?? '');
    const message = String(parsed?.MSG ?? parsed?.[1]?.MSG ?? '');
    const fileName = String(parsed?.File_Name || '').trim();
    const fileBytes = String(parsed?.file_bytes || '').trim();

    if (code !== '1') {
      return {
        ok: false,
        reason: 'unexpected-response-code',
        code,
        message,
        fileName,
      };
    }

    if (!fileName || !fileBytes) {
      return {
        ok: false,
        reason: 'missing-file-payload',
        code,
        message,
        fileName,
        hasBytes: !!fileBytes,
      };
    }

    return {
      ok: true,
      fileName,
      fileBytes,
    };
  } catch (error: any) {
    return {
      ok: false,
      reason: 'parse-failed',
      message: error?.message || String(error),
    };
  }
}

async function getDashboardPdfActions(snapshotPath: string): Promise<string[]> {
  try {
    const snapshotRaw = await fs.readFile(snapshotPath, 'utf-8');
    const snapshot = JSON.parse(snapshotRaw) as any;
    const rows = Array.isArray(snapshot?.openDeposits) ? snapshot.openDeposits : [];
    const actions = rows.flatMap((row: any) => [
      row?.daf_document?.onclick,
      row?.fdr_document?.onclick,
    ]).filter((value: unknown): value is string => typeof value === 'string' && value.includes('GET_DASHBOARD_DOC'));
    return Array.from(new Set(actions));
  } catch {
    return [];
  }
}

async function captureTableSnapshot(page: Page): Promise<string> {
  await fs.mkdir(RAW_DIR, { recursive: true });

  const snapshot = await page.evaluate(`(() => {
    function clean(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    function parseDoc(node, docType) {
      if (!node) return null;
      var target = node.querySelector('span.icon-pdf[onclick*="' + docType + '"]');
      if (!target) return null;
      var onclick = target.getAttribute('onclick') || '';
      var match = onclick.match(/GET_DASHBOARD_DOC\('([^']+)','([^']+)'\)/i);
      return {
        document_id: match ? match[1] : null,
        document_type: match ? match[2] : docType,
        onclick: onclick
      };
    }

    function parseRow(tr) {
      var cells = Array.from(tr.querySelectorAll('td'));
      if (cells.length < 10) return null;

      var depositNo = clean((tr.querySelector('span.dpNo') || {}).textContent || (cells[2] && cells[2].textContent) || '');
      if (!depositNo || /deposit no/i.test(depositNo) || /no data found/i.test(depositNo)) {
        return null;
      }

      return {
        deposit_no: depositNo,
        bank_deposit_no: clean(cells[3] && cells[3].textContent),
        transaction_date: clean(cells[4] && cells[4].textContent),
        deposit_date: clean(cells[5] && cells[5].textContent),
        deposit_amount: clean(cells[6] && cells[6].textContent),
        rate_of_interest: clean(cells[7] && cells[7].textContent),
        maturity_date: clean(cells[8] && cells[8].textContent),
        maturity_amount: clean(cells[9] && cells[9].textContent),
        maturity_instruction: clean(cells[10] && cells[10].textContent),
        pre_mature_yn: clean(cells[11] && cells[11].textContent),
        daf_document: parseDoc(cells[1] || tr, 'E_DAF'),
        fdr_document: parseDoc(cells[2] || tr, 'E_FDR'),
        expandable: !!tr.querySelector('a.icon-collapsible')
      };
    }

    var body = clean(document.body && document.body.innerText);
    var openTable = document.querySelector('#tablemydep');
    var pendingTable = document.querySelector('#tablemyHdfcdep');
    var openRows = openTable ? Array.from(openTable.querySelectorAll('tr')).map(parseRow).filter(Boolean) : [];
    var pendingRows = pendingTable ? Array.from(pendingTable.querySelectorAll('tr')).map(parseRow).filter(Boolean) : [];

    var nameMatch = body.match(/last login\s*:[\s\S]*?([A-Z][A-Z\s.]+?)\s+mobile no\.:/i);
    var mobileMatch = body.match(/mobile no\.:\s*([0-9x*]+)/i);
    var dobMatch = body.match(/date of birth\s*:\s*([0-9a-z-]+)/i);
    var emailMatch = body.match(/email\s*:\s*([^\s]+)/i);
    var totalMatch = body.match(/total deposits outstanding:\s*rs\.?\s*([\d,]+)/i);

    return {
      capturedAt: new Date().toISOString(),
      tableType: openRows.length > 0 ? 'dashboard' : 'generic',
      pageUrl: location.href,
      title: document.title,
      profile: {
        customer_name: nameMatch ? clean(nameMatch[1]) : '',
        mobile_no: mobileMatch ? mobileMatch[1] : '',
        date_of_birth: dobMatch ? dobMatch[1].toUpperCase() : '',
        email: emailMatch ? emailMatch[1] : '',
        total_deposits_outstanding: totalMatch ? totalMatch[1] : ''
      },
      openDeposits: openRows,
      pendingAuthorization: pendingRows,
      rawBodyText: body.slice(0, 4000)
    };
  })()`);

  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
  return SNAPSHOT_PATH;
}

function isPdfResponseHeader(header: string): boolean {
  const value = (header || '').toLowerCase();
  return value.includes('application/pdf') || value.includes('application/octet-stream');
}

async function copyLatestPdfFromDownloads(sinceMs: number): Promise<string | null> {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  try {
    const entries = await fs.readdir(downloadsDir);
    const pdfs: Array<{ name: string; mtimeMs: number }> = [];

    for (const file of entries) {
      if (!file.toLowerCase().endsWith('.pdf')) continue;
      const full = path.join(downloadsDir, file);
      const stat = await fs.stat(full);
      if (stat.mtimeMs >= sinceMs) {
        pdfs.push({ name: file, mtimeMs: stat.mtimeMs });
      }
    }

    if (pdfs.length === 0) return null;

    pdfs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = pdfs[0];
    const src = path.join(downloadsDir, newest.name);
    const dest = path.join(PDF_DIR, normalizeFileName(`hdfc-fd-${Date.now()}-${newest.name}`));
    await fs.copyFile(src, dest);
    return dest;
  } catch {
    return null;
  }
}

async function tryDownloadDashboardPdfs(page: Page, snapshotPath: string, allowManualPrompt = false): Promise<string[]> {
  await fs.mkdir(PDF_DIR, { recursive: true });
  await waitForDashboardDeposits(page);

  const savedPaths: string[] = [];
  const actionKeys = await getDashboardPdfActions(snapshotPath);

  for (let index = 0; index < actionKeys.length; index += 1) {
    const actionKey = actionKeys[index];
    const action = parseDashboardAction(actionKey);
    if (!action) continue;

    try {
      let generationResult: any = null;

      for (let attempt = 1; attempt <= DASHBOARD_PDF_MAX_ATTEMPTS; attempt += 1) {
        generationResult = await requestDashboardPdf(page, action.documentId, action.documentType);
        if (generationResult?.ok) {
          break;
        }

        if (isRateLimitedDashboardResponse(generationResult) && attempt < DASHBOARD_PDF_MAX_ATTEMPTS) {
          console.log(
            `Dashboard PDF ${index + 1}/${actionKeys.length} throttled on attempt ${attempt}/${DASHBOARD_PDF_MAX_ATTEMPTS}. Waiting ${Math.round(DASHBOARD_PDF_RATE_LIMIT_BACKOFF_MS / 1000)}s before retry...`,
          );
          await page.waitForTimeout(DASHBOARD_PDF_RATE_LIMIT_BACKOFF_MS);
          continue;
        }

        break;
      }

      if (generationResult?.ok && generationResult.fileBytes) {
        const body = Buffer.from(generationResult.fileBytes, 'base64');
        const savePath = path.join(PDF_DIR, buildDashboardPdfName(actionKey, generationResult.fileName, index));
        await fs.writeFile(savePath, body);
        savedPaths.push(savePath);
        console.log(`Saved dashboard PDF ${index + 1}/${actionKeys.length}: ${path.basename(savePath)}`);
      } else {
        console.log(`Dashboard PDF ${index + 1}/${actionKeys.length} failed: ${generationResult?.reason || 'unknown-error'}${generationResult?.message ? ` (${generationResult.message})` : ''}`);
      }
    } catch (error: any) {
      console.log(`Dashboard PDF ${index + 1}/${actionKeys.length} failed: exception${error?.message ? ` (${error.message})` : ''}`);
    }

    await page.waitForTimeout(DASHBOARD_PDF_REQUEST_GAP_MS);
  }

  if (savedPaths.length > 0) {
    return Array.from(new Set(savedPaths));
  }

  if (allowManualPrompt) {
    const manualPath = await prompt('If PDF downloaded manually, paste full PDF path (or press Enter to skip): ');
    if (manualPath) {
      try {
        await fs.access(manualPath);
        const copiedPath = path.join(PDF_DIR, normalizeFileName(`hdfc-fd-${Date.now()}-${path.basename(manualPath)}`));
        await fs.copyFile(manualPath, copiedPath);
        return [copiedPath];
      } catch {
        console.log('Provided manual PDF path was not readable.');
      }
    }
  }

  return [];
}

async function setupSession() {
  console.log('HDFC FD setup session');
  console.log('This stores PAN and DOB with AES-256-GCM on this machine.');

  const { headed } = parseArgs();
  const creds = await getCredentials();

  const browser = await launchBrowser(headed);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    await autofillLogin(page, creds);
    await waitForPostLogin(page);
    await ensureDepositSection(page);

    await fs.mkdir(AUTH_DIR, { recursive: true });
    await context.storageState({ path: STORAGE_STATE_PATH });

    console.log(`Session saved: ${STORAGE_STATE_PATH}`);
    console.log('You can now run: npm run fd:fetch');
  } finally {
    await browser.close();
  }
}

async function fetchStatement() {
  console.log('HDFC FD statement fetch');

  const args = parseArgs();
  let hasSession = false;

  try {
    await fs.access(STORAGE_STATE_PATH);
    hasSession = true;
  } catch {
    hasSession = false;
  }

  const browser = await launchBrowser(args.headed);
  const contextOptions: any = {
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
  };

  if (hasSession) {
    contextOptions.storageState = STORAGE_STATE_PATH;
    console.log('Trying saved session state');
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    const state = await getPageState(page);
    if (needsLogin(state)) {
      const creds = await loadCreds();
      if (!creds) {
        throw new Error('No saved credentials found. Run npm run fd:setup first.');
      }

      await autofillLogin(page, creds);
      await waitForPostLogin(page);
    } else {
      console.log('Session appears valid.');
    }

    await ensureDepositSection(page);

    const snapshotPath = await captureTableSnapshot(page);
    console.log(`Dashboard snapshot saved: ${snapshotPath}`);

    const expectedPdfCount = (await getDashboardPdfActions(snapshotPath)).length;
    const pdfPaths = await tryDownloadDashboardPdfs(page, snapshotPath, false);
    const hasCompletePdfCapture = expectedPdfCount > 0 && pdfPaths.length === expectedPdfCount;
    const primaryPdfPath = hasCompletePdfCapture ? (pdfPaths[0] || null) : null;
    if (!hasCompletePdfCapture) {
      console.log(`Using dashboard table snapshot because PDF capture is incomplete (${pdfPaths.length}/${expectedPdfCount || 0}).`);
    }

    await fs.mkdir(path.dirname(OUTPUT_JSON_PATH), { recursive: true });

    const metadata = {
      downloadedAt: new Date().toISOString(),
      source: 'hdfc_deposits_portal',
      loginUrl: LOGIN_URL,
      pageUrl: page.url(),
      captureMode: hasCompletePdfCapture ? 'pdf' : 'dashboard_table',
      pdfPath: primaryPdfPath,
      pdfPaths,
      pdfExpectedCount: expectedPdfCount,
      pdfDownloadedCount: pdfPaths.length,
      snapshotPath,
    };

    await fs.writeFile(OUTPUT_JSON_PATH, JSON.stringify(metadata, null, 2), 'utf-8');

    console.log(`Metadata saved: ${OUTPUT_JSON_PATH}`);
    if (pdfPaths.length > 0) {
      console.log(`PDFs saved: ${pdfPaths.length}`);
      for (const pdfPath of pdfPaths) {
        console.log(`PDF saved: ${pdfPath}`);
      }
    }
    if (snapshotPath) {
      console.log(`Snapshot saved: ${snapshotPath}`);
    }

    await fs.mkdir(AUTH_DIR, { recursive: true });
    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await browser.close();
  }
}

const args = parseArgs();

if (args.forgetCreds) {
  clearCreds().then(() => process.exit(0));
} else if (args.setup) {
  setupSession()
    .then(() => process.exit(0))
    .catch((err: any) => {
      console.error('Error:', err.message || err);
      process.exit(1);
    });
} else if (args.fetch) {
  fetchStatement()
    .then(() => process.exit(0))
    .catch((err: any) => {
      console.error('Error:', err.message || err);
      process.exit(1);
    });
} else {
  console.log(`
HDFC Fixed Deposit Workflow
===========================

Usage:
  npm run fd:setup              First-time setup (save creds + session)
  npm run fd:setup:visible      Alias of fd:setup
  npm run fd:fetch              Fetch FD statement/snapshot
  npm run fd:forget-creds       Delete saved credentials and session

Notes:
  - PAN and DOB are encrypted with AES-256-GCM on this machine.
  - OTP/captcha verification remains manual.
  - Fetch tries PDF download first, then table snapshot fallback.
`);
}
