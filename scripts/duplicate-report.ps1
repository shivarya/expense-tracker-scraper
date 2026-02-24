$out = @()
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
$txFile = "..\data\raw-extracts\enriched-transactions.json"
$cdslFile = "..\data\enriched-cdsl.json"

function Get-EnvMap {
  param([string]$EnvPath)
  $map = @{}
  if (Test-Path $EnvPath) {
    Get-Content $EnvPath | ForEach-Object {
      $line = $_.Trim()
      if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $idx = $line.IndexOf('=')
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim().Trim('"')
        if ($k) { $map[$k] = $v }
      }
    }
  }
  return $map
}

function Invoke-DuplicatePreview {
  param(
    [string]$BaseUrl,
    [string]$Token,
    [string]$Type,
    [array]$Items
  )

  if (-not $BaseUrl -or -not $Token -or -not $Items -or $Items.Count -eq 0) {
    return $null
  }

  $headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }
  $body = @{ type = $Type; items = $Items } | ConvertTo-Json -Depth 8

  $urls = @(
    ($BaseUrl.TrimEnd('/') + '/api/duplicates/preview'),
    ($BaseUrl.TrimEnd('/') + '/duplicates/preview')
  )

  foreach ($u in $urls) {
    try {
      return Invoke-RestMethod -Uri $u -Method Post -Headers $headers -Body $body
    } catch {
      continue
    }
  }

  return $null
}

if (Test-Path $txFile) {
  $j = Get-Content $txFile -Raw | ConvertFrom-Json
  $txs = $j.transactions
  $out += "Transactions: total = $($j.totalTransactions)"

  # By transaction_hash
  $hashGroups = @{}
  foreach ($t in $txs) {
    $h = $t.transaction_hash
    if (-not $h) { $h = ([Guid]::NewGuid().ToString()) }
    if ($hashGroups.ContainsKey($h)) { $hashGroups[$h].Add($t) } else { $hashGroups[$h] = [System.Collections.ArrayList]@($t) }
  }
  $dupHashGroups = $hashGroups.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 }
  $out += "Duplicate transaction_hash groups: $($dupHashGroups.Count)"
  if ($dupHashGroups.Count -gt 0) {
    $sample = $dupHashGroups | Select-Object -First 5
    foreach ($g in $sample) {
      $out += "--- Hash: $($g.Key) Count: $($g.Value.Count)"
      foreach ($item in $g.Value | Select-Object -First 3) {
        $out += ("  " + (ConvertTo-Json $item -Depth 5))
      }
    }
  }

  # By composite key (date|amount|merchant_canonical|payment_method)
  $comp = @{}
  foreach ($t in $txs) {
    $k = "{0}|{1}|{2}|{3}" -f ($t.date), ($t.amount), ($t.merchant_canonical -replace '\s+',' '), ($t.payment_method -replace '\s+',' ')
    if ($comp.ContainsKey($k)) { $comp[$k].Add($t) } else { $comp[$k] = [System.Collections.ArrayList]@($t) }
  }
  $dupComp = $comp.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 }
  $out += "Duplicate composite-key groups: $($dupComp.Count)"
  if ($dupComp.Count -gt 0) {
    $sample = $dupComp | Select-Object -First 5
    foreach ($g in $sample) {
      $out += "--- Key: $($g.Key) Count: $($g.Value.Count)"
      foreach ($item in $g.Value | Select-Object -First 3) {
        $out += ("  " + (ConvertTo-Json $item -Depth 5))
      }
    }
  }
} else {
  $out += "Transactions file not found: $txFile"
}

# CDSL stocks
if (Test-Path $cdslFile) {
  $c = Get-Content $cdslFile -Raw | ConvertFrom-Json
  $stocks = $c.stocks
  $out += "\nCDSL stocks: total = $($stocks.Count)"
  $isinGroups = @{}
  foreach ($s in $stocks) {
    $k = $s.isin
    if ($isinGroups.ContainsKey($k)) { $isinGroups[$k].Add($s) } else { $isinGroups[$k] = [System.Collections.ArrayList]@($s) }
  }
  $dupIsin = $isinGroups.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 }
  $out += "Duplicate ISIN groups: $($dupIsin.Count)"
  if ($dupIsin.Count -gt 0) {
    foreach ($g in $dupIsin) {
      $out += "--- ISIN: $($g.Key) Count: $($g.Value.Count)"
      foreach ($item in $g.Value | Select-Object -First 3) { $out += ("  " + (ConvertTo-Json $item -Depth 5)) }
    }
  }
} else {
  $out += "CDSL enriched file not found: $cdslFile"
}

# Mutual funds
$mfFile = "..\data\enriched-cdsl.json"
if (Test-Path $mfFile) {
  $m = Get-Content $mfFile -Raw | ConvertFrom-Json
  $mfs = $m.mutualFunds
  $out += "\nMutual funds: total = $($mfs.Count)"
  $folioGroups = @{}
  foreach ($f in $mfs) {
    $k = "{0}|{1}" -f ($f.folio), ($f.fund_name)
    if ($folioGroups.ContainsKey($k)) { $folioGroups[$k].Add($f) } else { $folioGroups[$k] = [System.Collections.ArrayList]@($f) }
  }
  $dupFolio = $folioGroups.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 }
  $out += "Duplicate MF folio+name groups: $($dupFolio.Count)"
  if ($dupFolio.Count -gt 0) {
    foreach ($g in $dupFolio | Select-Object -First 5) {
      $out += "--- Key: $($g.Key) Count: $($g.Value.Count)"
      foreach ($item in $g.Value | Select-Object -First 3) { $out += ("  " + (ConvertTo-Json $item -Depth 5)) }
    }
  }
} else {
  $out += "Mutual funds file not found: $mfFile"
}

# Write report
$envMap = Get-EnvMap "..\.env"
$apiUrl = $envMap['API_URL']
$apiToken = $envMap['API_TOKEN']

if (-not $apiUrl) { $apiUrl = 'http://localhost:8000' }

if ($apiToken) {
  $out += "\nDB duplicate preview (via PHP API):"

  if (Test-Path $txFile) {
    $txJson = Get-Content $txFile -Raw | ConvertFrom-Json
    $txPreview = Invoke-DuplicatePreview -BaseUrl $apiUrl -Token $apiToken -Type 'transactions' -Items @($txJson.transactions)
    if ($txPreview -and $txPreview.success) {
      $out += "Transactions in DB matches: $($txPreview.data.duplicate_items)/$($txPreview.data.total_items)"
    } else {
      $out += "Transactions in DB matches: preview failed"
    }
  }

  if (Test-Path $cdslFile) {
    $cdslJson = Get-Content $cdslFile -Raw | ConvertFrom-Json

    $stockPreview = Invoke-DuplicatePreview -BaseUrl $apiUrl -Token $apiToken -Type 'stocks' -Items @($cdslJson.stocks)
    if ($stockPreview -and $stockPreview.success) {
      $out += "Stocks in DB matches: $($stockPreview.data.duplicate_items)/$($stockPreview.data.total_items)"
    } else {
      $out += "Stocks in DB matches: preview failed"
    }

    $mfPreview = Invoke-DuplicatePreview -BaseUrl $apiUrl -Token $apiToken -Type 'mutual_funds' -Items @($cdslJson.mutualFunds)
    if ($mfPreview -and $mfPreview.success) {
      $out += "Mutual funds in DB matches: $($mfPreview.data.duplicate_items)/$($mfPreview.data.total_items)"
    } else {
      $out += "Mutual funds in DB matches: preview failed"
    }
  }
} else {
  $out += "\nDB duplicate preview skipped: API_TOKEN missing in scraper/.env"
}

$reportPath = "..\data\duplicate-report.txt"
$out | Out-File -FilePath $reportPath -Encoding utf8
Write-Output "Duplicate report written to $reportPath"
