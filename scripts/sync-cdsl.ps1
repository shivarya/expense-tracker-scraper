$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir
$text = Get-Content ..\.env -Raw
if ($text -match 'API_URL=(.*)') { $apiUrl = $matches[1].Trim() } else { Write-Error "API_URL not found"; exit 1 }
if ($text -match 'API_TOKEN=(.*)') { $token = $matches[1].Trim() } else { Write-Error "API_TOKEN not found"; exit 1 }
$j = Get-Content ..\data\enriched-cdsl.json -Raw | ConvertFrom-Json
$stocks = $j.stocks | ForEach-Object { [PSCustomObject]@{ platform='cdsl'; symbol=$_.symbol; company_name=$_.company_name; quantity=$_.quantity; average_price=$_.avg_price; current_price=$_.current_price; invested_amount=$_.invested_amount; current_value=$_.current_value } }
$body = @{ stocks = $stocks } | ConvertTo-Json -Depth 5
Write-Output "Posting stocks to $apiUrl/sync/stocks"
try {
    $respStocks = Invoke-RestMethod -Uri ("$apiUrl/sync/stocks") -Method Post -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } -Body $body -ErrorAction Stop
    Write-Output "Stocks response:"
    $respStocks | ConvertTo-Json -Depth 5
} catch {
    Write-Output "Stocks POST failed: $_"
    exit 1
}

$mf = $j.mutualFunds | ForEach-Object { [PSCustomObject]@{ folio_number=$_.folio; fund_name=$_.fund_name; amc=$_.amc; units=$_.units; nav=$_.nav; invested_amount=$_.amount; current_value=$_.amount; plan_type=$_.plan_type; option_type=$_.option_type } }
$body2 = @{ funds = $mf } | ConvertTo-Json -Depth 5
Write-Output "Posting mutual funds to $apiUrl/sync/mutual-funds"
try {
    $respMf = Invoke-RestMethod -Uri ("$apiUrl/sync/mutual-funds") -Method Post -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } -Body $body2 -ErrorAction Stop
    Write-Output "Mutual funds response:"
    $respMf | ConvertTo-Json -Depth 5
} catch {
    Write-Output "Mutual funds POST failed: $_"
    exit 1
}
