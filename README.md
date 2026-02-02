# Expense Tracker - Scraper

Automated data collection for stocks, mutual funds, credit card statements, and SMS transactions.

## Features

- **Stock Scraping**: Zerodha/Groww portfolio via Playwright
- **Mutual Fund Statements**: CAMS/KFintech via Gmail API
- **Credit Card Statements**: Parse PDF statements from Gmail (HDFC, ICICI, SBI, Axis, Kotak, etc.)
- **SMS Parsing**: AI-powered transaction extraction (OpenAI GPT-4)
- **Auto Sync**: Push data to PHP backend with duplicate detection

## Setup

### 1. Install Dependencies

```bash
cd scraper
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Install Playwright Browsers

```bash
npx playwright install chromium
```

### 4. Setup Gmail API (for MF statements)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project
3. Enable Gmail API
4. Create OAuth 2.0 credentials
5. Download credentials and add to `.env`
6. Run OAuth flow:
   ```bash
   npm run auth:gmail
   ```

## Usage

### Run All Scrapers

```bash
npm run dev          # Run all scrapers (stocks, MF, CC, SMS)
npm run dev:all      # Same as above
```

### Run Individual Scrapers

```bash
npm run dev:stocks   # Stocks only
npm run dev:mf       # Mutual funds only
npm run dev:cc       # Credit card statements only
npm run dev:sms      # SMS transactions only
```

### Credit Card Statements (Time-Filtered)

Download statements for specific time periods:

```bash
# Fetch single PDF (POC mode)
npm run fetch:cc:raw

# Fetch all statements (default: last 1 year)
npm run fetch:cc:raw:all

# Time-filtered fetching
npm run fetch:cc:3m        # Last 3 months
npm run fetch:cc:6m        # Last 6 months
npm run fetch:cc:1y        # Last 1 year (default)
npm run fetch:cc:2y        # Last 2 years
npm run fetch:cc:all-time  # All available statements

# Manual time filter (custom)
npx tsx src/transactions/extract-raw.ts --all --time=1m  # Last month
```

**Time Filter Options**:
- `1m` - Last 1 month
- `3m` - Last 3 months
- `6m` - Last 6 months
- `1y` - Last 1 year
- `2y` - Last 2 years
- `all` - All time (no filter)

### Or use arguments directly

```bash
npm run dev stocks   # Stocks only
npm run dev mf       # Mutual funds only
npm run dev cc       # Credit card statements only
npm run dev sms      # SMS transactions only
```

## SMS Export

### From Android Device

1. Install SMS Backup & Restore app
2. Export to JSON
3. Transfer file to `./data/sms-export.json`

### Or use ADB (advanced)

```bash
adb shell content query --uri content://sms/inbox
```

## AI SMS Parser

The scraper uses OpenAI GPT-4 to parse bank SMS:

**Supported Banks**:
- HDFC
- SBI
- ICICI
- IDFC
- RBL

**Extracted Fields**:
- Transaction type (debit/credit)
- Amount
- Merchant
- Category (auto-detected)
- Date
- Reference number

## Configuration

### `.env` Variables

```env
API_URL=http://localhost:8000
OPENAI_API_KEY=sk-...
GMAIL_CLIENT_ID=...
ZERODHA_USER_ID=...
SMS_SOURCE=file  # or 'android'
```

### Sync Settings

- `SYNC_STOCKS=true` - Enable stock scraping
- `SYNC_MUTUAL_FUNDS=true` - Enable MF fetching
- `SYNC_TRANSACTIONS=true` - Enable SMS parsing
- `AUTO_SYNC_INTERVAL_HOURS=24` - Sync frequency

## Architecture

```
scraper/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── sync.ts                  # Backend sync logic
│   ├── scrapers/
│   │   ├── stocks.ts            # Playwright stock scraper
│   │   └── mutualFunds.ts       # Gmail API MF fetcher
│   └── parsers/
│       └── smsParser.ts         # AI SMS transaction parser
├── data/
│   ├── sms-export.json          # SMS backup
│   └── mf-statements/           # Downloaded PDFs
└── gmail-token.json             # OAuth token (gitignored)
```

## Security Notes

- Never commit `.env` or `gmail-token.json`
- Use environment variables in production
- Rotate API keys regularly
- SMS data contains sensitive info - encrypt at rest

## Troubleshooting

### Playwright Fails
```bash
npx playwright install --with-deps chromium
```

### Gmail 403 Forbidden
- Check OAuth scopes include `gmail.readonly`
- Regenerate token: delete `gmail-token.json` and re-auth

### SMS Parsing Errors
- Verify OpenAI API key has credits
- Check SMS format matches bank patterns
- Increase batch size if rate-limited

## Next Steps

- [ ] Add Groww scraper
- [ ] PDF parser for MF statements (pdf-parse)
- [ ] ADB SMS reader
- [ ] Webhook triggers for real-time sync
- [ ] Error retry with exponential backoff

---

**Status**: ✅ Phase 3 scaffolding complete. Install deps and configure APIs.
