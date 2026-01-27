# SMS Export & Parsing Guide

This guide explains how to export SMS from your Android device and parse them for expense tracking.

## Method 1: PowerShell Script (Recommended)

### Prerequisites
- Android device with USB debugging enabled
- Android SDK Platform Tools (includes ADB)

### Steps

1. **Enable USB Debugging on Android:**
   - Go to Settings → About Phone
   - Tap "Build Number" 7 times to enable Developer Options
   - Go to Settings → Developer Options
   - Enable "USB Debugging"

2. **Connect device and run export:**
   ```powershell
   cd c:\Users\Ash\Documents\Projects\apps\expense-tracker\scraper
   .\export-sms.ps1
   ```

3. **Parse and sync to database:**
   ```bash
   npm run dev
   ```

## Method 2: Manual Export with SMS Backup App

### Steps

1. **Install SMS Backup & Restore:**
   - Download from Google Play Store
   - Open the app

2. **Backup SMS to JSON:**
   - Tap "Backup"
   - Select "SMS" only
   - Choose "Local Backup"
   - Set format to "JSON"
   - Tap "Backup Now"

3. **Transfer file to computer:**
   - Connect phone to computer
   - Find backup file in `Internal Storage/SMSBackupRestore/`
   - Copy to `scraper/data/sms-export.json`

4. **Parse and sync:**
   ```bash
   cd expense-tracker/scraper
   npm run dev
   ```

## Configuration

Update `.env` file:

```dotenv
# Azure OpenAI for parsing
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_DEPLOYMENT=gpt-4-turbo

# Backend API
API_URL=https://shivarya.dev/expense_tracker
API_TOKEN=your-jwt-token  # Get from app after login

# SMS settings
SMS_SOURCE=file
SMS_FILE_PATH=./data/sms-export.json
SYNC_TRANSACTIONS=true
```

## Expected SMS Format

The exported JSON should have this structure:

```json
[
  {
    "address": "AX-ICICIT",
    "body": "ICICI Bank Credit Card XX2003 debited for INR 249.00...",
    "date": "2026-01-26T14:13:10.883Z",
    "type": "1"
  }
]
```

## Parsing Process

1. **Filter:** Only bank SMS are processed (HDFC, ICICI, SBI, IDFC, RBL, Axis, Kotak)
2. **AI Parse:** Azure OpenAI extracts:
   - Bank name
   - Account number (last 4 digits)
   - Transaction type (debit/credit)
   - Amount
   - Merchant name
   - Category
   - Date
   - Reference number

3. **Save to Database:**
   - Creates bank account if doesn't exist
   - Creates category if doesn't exist
   - Inserts transaction
   - Skips duplicates

## Sync State

The scraper tracks processed messages in `data/sync-state.json`:

```json
{
  "lastSyncTimestamp": "2026-01-27T12:00:00Z",
  "processedMessageIds": ["msg-id-1", "msg-id-2"]
}
```

This prevents re-processing the same SMS on subsequent runs.

## Troubleshooting

### ADB Not Found
```bash
# Install Android SDK Platform Tools
# Windows: Download from https://developer.android.com/tools/releases/platform-tools
# Add to PATH: C:\platform-tools
```

### Device Not Authorized
- Check phone screen for authorization prompt
- Tap "Allow" when asked to authorize computer

### No Bank SMS Found
- Check if SMS export includes inbox messages
- Verify sender addresses contain bank keywords (HDFC, ICICI, etc.)

### Parsing Errors
- Check Azure OpenAI credentials in `.env`
- Verify deployment name is correct
- Check logs in console for detailed errors

## Logs

The scraper provides detailed logs:

```
📱 SMS Export Tool
==================

✓ Device connected

Exporting SMS messages...

✓ Successfully exported 500 SMS messages
  → Saved to: data/sms-export.json

📊 Summary:
  Total SMS: 500
  Bank SMS: 48

✓ Ready to parse with scraper!
```

## Advanced: Automated Sync

For regular syncing, create a scheduled task:

1. Save this as `sync-sms.ps1`:
```powershell
cd "c:\Users\Ash\Documents\Projects\apps\expense-tracker\scraper"
.\export-sms.ps1
npm run dev
```

2. Create Windows Task Scheduler job:
   - Run daily at 8 AM
   - Action: `powershell.exe -File "path\to\sync-sms.ps1"`

## Next Steps

After parsing:
- View transactions in the mobile app (Dashboard screen)
- Transactions are automatically categorized
- Bank accounts are created automatically
- Duplicates are skipped based on amount, date, and account
