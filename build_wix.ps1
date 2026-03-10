$indexHtml = Get-Content -Raw "index.html"
$styleCss = Get-Content -Raw "style.css"
$appJs = Get-Content -Raw "app.js"

$indexHtml = $indexHtml.Replace('<script src="lucide.min.js"></script>', '<script src="https://unpkg.com/lucide@latest"></script>')
$indexHtml = $indexHtml.Replace('<script src="pdf.min.js"></script>', '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>')
$indexHtml = $indexHtml.Replace('<script src="pdf-lib.min.js"></script>', '<script src="https://unpkg.com/pdf-lib/dist/pdf-lib.min.js"></script>')

$indexHtml = $indexHtml.Replace('<link rel="stylesheet" href="style.css">', "<style>`n$styleCss`n</style>")

# Force the worker path directly inside the javascript execution block
# We place it at the very top of app.js just to be safe.
# Convert ALL let and const declarations to var to prevent redeclaration SyntaxErrors in Wix iframe
$appJs = $appJs -replace '\blet\s+', 'var '
$appJs = $appJs -replace '\bconst\s+', 'var '
$appJs = $appJs -replace '(?s)if\s*\(\s*window\.pdfjsLib\s*\)\s*\{[^\}]*\}[ \t\r\n]*', ''

# Prevent Wix forms from treating buttons as form submissions which cause silent reloads
$indexHtml = $indexHtml.Replace('<button ', '<button type="button" ')

$appJsWithWorker = "
// --- WIX INJECTED WORKER CONFIG ---
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
} else if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
// ----------------------------------
" + $appJs

$indexHtml = $indexHtml.Replace('<script src="app.js"></script>', "<script>`n$appJsWithWorker`n</script>")

$indexHtml = $indexHtml.Replace('<link rel="manifest" href="manifest.json">', '')

Set-Content -Path "wix_export.html" -Value $indexHtml -Encoding UTF8
Write-Output "Successfully created wix_export.html"
