# Export SMS from Android device via ADB
# Requires: Android device connected with USB debugging enabled

Write-Host "📱 SMS Export Tool" -ForegroundColor Cyan
Write-Host "==================`n"

# Check if ADB is available
try {
    $adbVersion = adb version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ ADB not found. Please install Android SDK Platform Tools." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "❌ ADB not found. Please install Android SDK Platform Tools." -ForegroundColor Red
    exit 1
}

# Check device connection
Write-Host "Checking device connection..." -ForegroundColor Yellow
$devices = adb devices | Select-String "device$"
if ($devices.Count -eq 0) {
    Write-Host "❌ No Android device connected. Please:" -ForegroundColor Red
    Write-Host "   1. Connect your device via USB"
    Write-Host "   2. Enable USB debugging in Developer Options"
    Write-Host "   3. Authorize the computer on your phone"
    exit 1
}

Write-Host "✓ Device connected`n" -ForegroundColor Green

# Create data directory if it doesn't exist
$dataDir = Join-Path $PSScriptRoot "data"
if (!(Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

$outputFile = Join-Path $dataDir "sms-export.json"

Write-Host "Exporting SMS messages..." -ForegroundColor Yellow
Write-Host "This may take a minute...`n"

# Export SMS using content query
# URI: content://sms/inbox
$smsJson = adb shell "content query --uri content://sms --projection address:body:date:type" 2>$null

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($smsJson)) {
    Write-Host "❌ Failed to export SMS. Trying alternative method..." -ForegroundColor Red
    
    # Alternative: Use SMS backup app or manual export
    Write-Host "`nManual Export Instructions:" -ForegroundColor Cyan
    Write-Host "1. Install 'SMS Backup & Restore' app from Play Store"
    Write-Host "2. Backup SMS to JSON format"
    Write-Host "3. Transfer the JSON file to: $outputFile"
    Write-Host "4. Run this script again with the file in place`n"
    
    # Check if file already exists
    if (Test-Path $outputFile) {
        Write-Host "✓ Found existing SMS export file" -ForegroundColor Green
        $content = Get-Content $outputFile -Raw | ConvertFrom-Json
        Write-Host "  → Contains $($content.Count) messages`n"
    }
    
    exit 1
}

# Parse the output and convert to JSON
Write-Host "Parsing SMS data..." -ForegroundColor Yellow

$smsMessages = @()
$lines = $smsJson -split "`n"

foreach ($line in $lines) {
    if ($line -match "Row:\s+\d+\s+address=(.*?),\s+body=(.*?),\s+date=(\d+),\s+type=(\d+)") {
        $smsMessages += @{
            address = $matches[1]
            body = $matches[2]
            date = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$matches[3]).DateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            type = $matches[4]
        }
    }
}

if ($smsMessages.Count -eq 0) {
    Write-Host "❌ No SMS messages found" -ForegroundColor Red
    exit 1
}

# Save to JSON file
$smsMessages | ConvertTo-Json -Depth 10 | Set-Content $outputFile -Encoding UTF8

Write-Host "✓ Successfully exported $($smsMessages.Count) SMS messages" -ForegroundColor Green
Write-Host "  → Saved to: $outputFile`n"

# Filter and show bank SMS count
$bankSMS = $smsMessages | Where-Object {
    $sender = $_.address.ToLower()
    $sender -match 'hdfc|sbi|icici|idfc|rbl|axis|kotak'
}

Write-Host "📊 Summary:" -ForegroundColor Cyan
Write-Host "  Total SMS: $($smsMessages.Count)"
Write-Host "  Bank SMS: $($bankSMS.Count)"
Write-Host "`n✓ Ready to parse with scraper!" -ForegroundColor Green
Write-Host "  Run: npm run sync`n"
