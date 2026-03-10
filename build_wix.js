const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Replace local scripts with CDNs
let bundled = indexHtml.replace('<script src="lucide.min.js"></script>', '<script src="https://unpkg.com/lucide@latest"></script>');
bundled = bundled.replace('<script src="pdf.min.js"></script>', '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>');
bundled = bundled.replace('<script src="pdf-lib.min.js"></script>', '<script src="https://unpkg.com/pdf-lib/dist/pdf-lib.min.js"></script>');

// Replace style link with inline CSS
bundled = bundled.replace('<link rel="stylesheet" href="style.css">', `<style>\n${styleCss}\n</style>`);

// Replace app.js script with inline JS (and include pdfjs worker config)
const workerConfig = `
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
`;

bundled = bundled.replace('<script src="app.js"></script>', `<script>\n${workerConfig}\n${appJs}\n</script>`);

// Remove manifest and PWA stuff that shouldn't be in an iframe
bundled = bundled.replace('<link rel="manifest" href="manifest.json">', '');
bundled = bundled.replace(/<script>\s*console\.log\("Bootstrapping icons\.\.\."\);[\s\S]*?<\/script>/, `<script>
    console.log("Bootstrapping icons...");
    if (window.lucide) {
        try { lucide.createIcons(); } catch (e) { console.error("Lucide Error", e); }
    } else {
        console.warn("Lucide not loaded!");
    }
</script>`);

fs.writeFileSync(path.join(__dirname, 'wix_export.html'), bundled, 'utf8');
console.log('Successfully created wix_export.html');
