# Supabase Connectivity Diagnostic Script for Columbia Transport

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Supabase Desktop Connection Diagnostic   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$domains = @(
    "supabase.com",
    "app.supabase.com",
    "hdsgnhiofkozsvbqdsey.supabase.co"
)

Write-Host "1. Testing DNS Resolution & Connectivity..." -ForegroundColor Yellow
foreach ($domain in $domains) {
    Write-Host "Testing $domain..." -NoNewline
    try {
        $result = Test-NetConnection -ComputerName $domain -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($result) {
            Write-Host " [SUCCESS]" -ForegroundColor Green
        }
        else {
            Write-Host " [FAILED] - Cannot reach port 443" -ForegroundColor Red
        }
    }
    catch {
        Write-Host " [ERROR] - $($_.Exception.Message)" -ForegroundColor Red
    }
}
Write-Host ""

Write-Host "2. Checking for known ad-blocker / hosts file interference..." -ForegroundColor Yellow
$hostsPath = "$env:windir\System32\drivers\etc\hosts"
if (Test-Path $hostsPath) {
    $hostsContent = Get-Content $hostsPath
    $supabaseBlocked = $hostsContent | Where-Object { $_ -match "supabase" }
    
    if ($supabaseBlocked) {
        Write-Host "WARNING: Found 'supabase' entries in your Windows Hosts file!" -ForegroundColor Red
        $supabaseBlocked | ForEach-Object { Write-Host "  -> $_" -ForegroundColor DarkGray }
        Write-Host "This is likely blocking your access. You need to edit your hosts file as Administrator to remove these lines." -ForegroundColor Red
    }
    else {
        Write-Host "Hosts file is clean." -ForegroundColor Green
    }
}
else {
    Write-Host "Hosts file checking skipped (not found)." -ForegroundColor DarkGray
}
Write-Host ""

Write-Host "3. Clear Browser DNS Cache Instructions:" -ForegroundColor Yellow
Write-Host "If the tests above passed but your browser still says 'Site can't be reached':"
Write-Host " - Chrome/Edge/Brave: Type 'chrome://net-internals/#dns' in the URL bar and click 'Clear host cache'"
Write-Host " - Try opening Supabase in an 'Incognito' or 'InPrivate' window."
Write-Host " - Turn off any VPNs or strict Ad-Blockers (like uBlock Origin) temporarily."
Write-Host ""
Write-Host "Diagnostic Complete." -ForegroundColor Cyan
