// Stability: Global Error Catcher
window.onerror = function (msg, url, line, col, error) {
    console.error("GLOBAL ERROR:", msg, url, line, col, error);
    const banner = document.getElementById('debug-error-banner');
    if (banner) {
        banner.style.display = 'block';
        const detail = error && error.stack ? error.stack : (msg + " at " + line + ":" + col);
        banner.innerHTML = "<strong>FATAL ERROR:</strong><br>" + detail;
    }
    return false;
};

// Configure PDF.js worker
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
}

// --- GLOBAL STATE ---
let supabaseClient = null;
const supabaseUrl = 'https://hdsgnhiofkozsvbqdsey.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhkc2duaGlvZmtvenN2YnFkc2V5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMjgyMDMsImV4cCI6MjA4ODcwNDIwM30.q52Htt6YX-2ruU6cMO7sQdwwvZe1GyixjlpzmWPZQB0';

let currentPdf = null;
let currentPdfBytes = null;
let scale = 1.5;
let currentPage = 1;

let selectedTool = null;
let annotations = [];
let isDragging = false;
let dragTarget = null;
let dragOffset = { x: 0, y: 0 };

let isDrawing = false;
let currentStroke = null;

let stateStack = [];
let currentFileContext = null;

let activeTrip = null;
let activeAnno = null;
let sessionVaultId = null;
let autoSaveTimer = null;
let lastDeletedVaultItem = null;

// UI Element References
let startOverlay, startBtn, driverInput, finishBtn, importBtn, canvasContainer, loadEntryModal, vaultModal, popup, closePopupBtn, shareModal;

// FAST-BOOT: Defined globally for instant login reliability
window.handleStartTrip = () => {
    const overlay = document.getElementById('start-overlay');
    const input = document.getElementById('driver-name');
    const truckInput = document.getElementById('truck-id');
    const rememberCheckbox = document.getElementById('remember-device');

    const driverId = input ? input.value.trim() : '';
    const truckId = truckInput ? truckInput.value.trim() : '';
    const shouldRemember = rememberCheckbox ? rememberCheckbox.checked : false;

    if (!driverId || !truckId) {
        alert("Please enter both Driver ID and Truck ID to begin.");
        return;
    }

    // Save or clear device assignment based on checkbox
    if (shouldRemember) {
        localStorage.setItem('ct_driver_id', driverId);
        localStorage.setItem('ct_truck_id', truckId);
    } else {
        localStorage.removeItem('ct_driver_id');
        localStorage.removeItem('ct_truck_id');
    }

    activeTrip = {
        driver: driverId,
        truck: truckId,
        startTime: new Date().toISOString(),
        inv: "N/A",
        stop: "01",
        logs: []
    };
    sessionVaultId = 'session_' + Date.now();

    if (overlay) overlay.style.display = 'none';
    console.log("Trip Started for Driver:", driverId, "Truck:", truckId);

    if (window.sendGpsPing) window.sendGpsPing();
};

// Auto-fill remembered device info on load
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const savedDriver = localStorage.getItem('ct_driver_id');
        const savedTruck = localStorage.getItem('ct_truck_id');
        if (savedDriver && document.getElementById('driver-name')) {
            document.getElementById('driver-name').value = savedDriver;
        }
        if (savedTruck && document.getElementById('truck-id')) {
            document.getElementById('truck-id').value = savedTruck;
        }
    }, 100);
});

function getEventCoords(e, container) {
    const canvas = container.querySelector('canvas');
    if (!canvas) return { x: 0, y: 0, nx: 0, ny: 0 };
    const rect = canvas.getBoundingClientRect();

    let clientX = e.clientX;
    let clientY = e.clientY;

    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
    }

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;

    return {
        x: x,
        y: y,
        nx: x / canvas.width,
        ny: y / canvas.height
    };
}

function getCanvasCenter() {
    const container = document.getElementById('pdf-canvas-container');
    if (!container) return { x: 300, y: 400, nx: 0.5, ny: 0.5 };
    const rect = container.getBoundingClientRect();

    // Calculate center of the visible container
    const centerX = rect.left + (rect.width / 2);
    const centerY = rect.top + (rect.height / 2);

    return getEventCoords({ clientX: centerX, clientY: centerY }, container);
}

// Global Element References (Initialized in initButtons for safety)

// 1. INITIALIZATION & BUTTONS
window.initButtons = () => {
    if (window.buttonsInitialized) return;
    window.buttonsInitialized = true;
    try {
        console.log("initButtons: Starting initialization...");

        startOverlay = document.getElementById('start-overlay');
        startBtn = document.getElementById('btn-start-trip');
        driverInput = document.getElementById('driver-name');
        finishBtn = document.getElementById('btn-finish');
        importBtn = document.getElementById('btn-import');
        canvasContainer = document.getElementById('pdf-canvas-container');
        loadEntryModal = document.getElementById('load-entry-modal');
        vaultModal = document.getElementById('vault-modal');
        popup = document.getElementById('attachment-popup');
        closePopupBtn = document.getElementById('close-popup');
        shareModal = document.getElementById('share-modal');
        const btnSaveForm = document.getElementById('btn-save-load');

        // Check for Shared Files from PWA Share Target
        if (window.location.search.includes('shared=1')) {
            (async () => {
                try {
                    const cache = await caches.open('shared-files');
                    const resp = await cache.match('/last-shared-file');
                    if (resp) {
                        const blob = await resp.blob();
                        const type = blob.type || 'application/pdf';
                        console.log("PWA Share Target: Received file of type", type);
                        if (confirm("Received external edits! Would you like to load them into the current session?")) {
                            await loadDocument(blob, type);
                            await cache.delete('/last-shared-file');
                            // Clean URL
                            window.history.replaceState({}, document.title, window.location.pathname);
                        }
                    }
                } catch (e) {
                    console.error("Share Target Error:", e);
                }
            })();
        }

        if (!startBtn || !startOverlay) {
            console.warn("Init: Core elements missing.");
            return;
        }

        // Initialize Supabase only when buttons are ready
        if (window.supabase && !supabaseClient) {
            try {
                supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
                console.log("Supabase client initialized in initButtons.");
            } catch (e) {
                console.error("Supabase Init Error:", e);
            }
        }

        // Physically attach the event listener, preventing duplicate bindings
        startBtn.removeEventListener('click', window.handleStartTrip);
        startBtn.addEventListener('click', window.handleStartTrip);

        // Tool selection
        document.querySelectorAll('.tool-btn').forEach(btn => {
            if (btn.getAttribute('onclick')) return; // DON'T overwrite if already has handler
            btn.onclick = (e) => {
                const ignore = ['btn-save', 'btn-import', 'btn-finish', 'btn-reset', 'btn-start-trip', 'btn-clear-sig', 'btn-save-sig', 'btn-zoom-in', 'btn-zoom-out', 'btn-demo', 'btn-scan-camera', 'btn-upload-file', 'btn-manual-load', 'btn-vault', 'btn-save-load', 'btn-share', 'btn-reset-view', 'btn-mobile-toggle', 'btn-mobile-fab', 'btn-undo', 'btn-quick-scan', 'btn-route-map', 'btn-show-route', 'btn-calendar', 'btn-calc', 'close-admin', 'btn-refresh-admin', 'btn-admin-portal'];
                if (ignore.includes(btn.id)) return;

                if (btn.classList.contains('active')) {
                    btn.classList.remove('active');
                    selectedTool = null;
                } else {
                    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    if (btn.id === 'btn-text') selectedTool = 'text';
                    else if (btn.id === 'btn-attach') selectedTool = 'attach';
                    else if (btn.id === 'btn-stamp') selectedTool = 'stamp';
                    else if (btn.id === 'btn-sign') selectedTool = 'sign';
                    else if (btn.id === 'btn-pen') selectedTool = 'pen';
                    else if (btn.id === 'btn-eraser') selectedTool = 'eraser';

                    // Auto-close any open overlay/popup when switching tools
                    if (popup) {
                        popup.style.display = 'none';
                        activeAnno = null; // Clear context if switching tools
                    }
                    const sPicker = document.getElementById('stamp-picker');
                    if (sPicker) sPicker.style.display = 'none';

                    // Center Staging: Spawn in center immediately
                    if (['btn-text', 'btn-stamp', 'btn-sign', 'btn-attach'].includes(btn.id)) {
                        const center = getCanvasCenter();
                        if (btn.id === 'btn-stamp') openStampPicker(center.nx, center.ny);
                        else if (btn.id === 'btn-sign') openSignatureModal(center.nx, center.ny);
                        else if (btn.id === 'btn-text') {
                            const t = prompt("Enter Blue Text:");
                            if (t) {
                                annotations.push({ type: 'text', x: center.nx, y: center.ny, content: t, id: Date.now() });
                                drawAnnotations();
                                saveToVault(); // AUTO-SAVE after text
                            }
                        } else if (btn.id === 'btn-attach') {
                            const a = { type: 'attach', x: center.nx, y: center.ny, files: [], id: Date.now(), name: 'New Attachment' };
                            annotations.push(a); openPopup(a); drawAnnotations();
                            saveToVault(); // AUTO-SAVE new attachment point
                        }
                    }
                }
            };
        });

        // Sidebar Special Buttons
        const searchInput = document.getElementById('header-search');
        if (searchInput) {
            searchInput.oninput = () => {
                const query = searchInput.value.toLowerCase();
                const items = document.querySelectorAll('.vault-item');
                items.forEach(item => {
                    const text = item.innerText.toLowerCase();
                    item.style.display = text.includes(query) ? 'flex' : 'none';
                });
            };
        }


        const btnUndo = document.getElementById('btn-undo');
        if (btnUndo) {
            btnUndo.onpointerdown = (e) => { e.stopPropagation(); };
            btnUndo.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log("Undo: Removing last pen stroke...");
                let found = false;
                for (let i = annotations.length - 1; i >= 0; i--) {
                    if (annotations[i].type === 'pen') {
                        annotations.splice(i, 1);
                        await window.redrawBaseDocument();
                        drawAnnotations();
                        saveToVault(null, true);
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    // Fallback to any annotation if no pen strokes
                    if (annotations.length > 0) {
                        annotations.pop();
                        drawAnnotations();
                        saveToVault();
                    } else {
                        alert("No actions to undo.");
                    }
                }
            };
        }

        // Admin UI Logic Integrated into Fast-Boot
        const adminModal = document.getElementById('admin-modal');
        const btnAdminPortal = document.getElementById('btn-admin-portal');
        if (btnAdminPortal && adminModal) {
            btnAdminPortal.onclick = (e) => {
                e.preventDefault();
                adminModal.style.display = 'flex';
                if (typeof refreshAdminList === 'function') refreshAdminList();
            };
        }

        const btnRefreshAdmin = document.getElementById('btn-refresh-admin');
        if (btnRefreshAdmin) btnRefreshAdmin.onclick = () => {
            if (typeof refreshAdminList === 'function') refreshAdminList();
        };

        const closeAdminBtn = document.getElementById('close-admin');
        if (closeAdminBtn && adminModal) {
            closeAdminBtn.onclick = () => {
                adminModal.style.display = 'none';
            };

        }

        // Helper to clear canvas ink when deleting strokes
        window.redrawBaseDocument = async () => {
            if (currentPdf) await renderPage(currentPage);
            else if (currentPdfBytes) {
                if (currentDocType.startsWith('image/')) await renderImage(currentPdfBytes);
                else if (currentDocType.includes('text/plain')) await renderTextDocument(currentPdfBytes);
            }
        };

        window.isErasing = false;
        window.handleEraser = async (p) => {
            if (window.isErasing) return;
            window.isErasing = true;
            const mainCanvas = canvasContainer.querySelector('canvas');
            if (!mainCanvas) { window.isErasing = false; return; }
            let found = false;
            for (let i = annotations.length - 1; i >= 0; i--) {
                const a = annotations[i];
                if (a.type !== 'pen') continue;
                for (const pt of a.points) {
                    const px = p.nx * mainCanvas.width;
                    const py = p.ny * mainCanvas.height;
                    const ptx = pt.nx * mainCanvas.width;
                    const pty = pt.ny * mainCanvas.height;
                    if (Math.hypot(px - ptx, py - pty) < 25) { // 25px forgiving eraser radius
                        annotations.splice(i, 1);
                        found = true;
                        break;
                    }
                }
                if (found) break; // Only erase one stroke per interaction frame for performance
            }
            if (found) {
                await window.redrawBaseDocument();
                drawAnnotations();
                saveToVault(null, true);
            }
            window.isErasing = false;
        };

        const btnManual = document.getElementById('btn-manual-load');
        if (btnManual) btnManual.onclick = () => {
            console.log("New Load: Showing form...");
            // DO NOT resetView here anymore - let user choose to clear or keep work


            // 2. Clear all form inputs
            const inputs = ['manual-inv', 'manual-po', 'manual-load', 'manual-order', 'manual-truck', 'manual-trailer',
                'manual-driver-id', 'manual-payment', 'manual-billed-to', 'manual-from', 'manual-to',
                'manual-details', 'manual-miles', 'manual-notes', 'manual-total'];
            inputs.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });

            // 3. Show the modal
            loadEntryModal.style.display = 'flex';
        };

        const btnVault = document.getElementById('btn-vault');
        if (btnVault) btnVault.onclick = () => { // Changed to onclick
            vaultModal.style.display = 'flex';
            renderVault();
        };

        const btnShare = document.getElementById('btn-share');
        if (btnShare) btnShare.onclick = () => { // Changed to onclick
            if (!currentPdfBytes) return alert("Please load a document first.");
            shareModal.style.display = 'flex';
            window.setShareFormat('pdf'); // Set default format to PDF
        };

        const btnReset = document.getElementById('btn-reset-view');
        if (btnReset) btnReset.onclick = resetView; // Changed to onclick

        // Lifecycle
        startBtn.onclick = window.handleStartTrip; // Changed to onclick

        if (finishBtn) {
            finishBtn.onclick = async () => {
                if (!currentPdfBytes) return alert("Please import or generate a load first.");

                // Check if we are in Attachment Editing Mode
                if (currentFileContext && stateStack.length > 0) {
                    if (!confirm("Save these annotations to the attachment?")) return;

                    try {
                        const originalFormat = shareFormat;
                        shareFormat = 'image'; // Force image format for attachment thumbnails

                        // FIX: Must BAKE the packet to include floating stamps/signatures!
                        const blobOrUrl = await bakeFullPacket(true); // pass true to get direct dataUrl
                        shareFormat = originalFormat; // restore

                        if (blobOrUrl) {
                            currentFileContext.data = blobOrUrl;
                            currentFileContext.type = 'image/jpeg';
                            currentFileContext.annotated = true;

                            alert("Success! Changes saved to attachment.");

                            const prevState = stateStack.pop();
                            currentPdfBytes = prevState.bytes;
                            currentPdf = prevState.doc;
                            annotations = prevState.annos;
                            currentDocType = prevState.type;
                            currentFileContext = null;

                            if (currentPdf) await renderPage(currentPage);
                            else if (currentPdfBytes) {
                                if (currentDocType.startsWith('image/')) await renderImage(currentPdfBytes);
                                else if (currentDocType.includes('text/plain')) await renderTextDocument(currentPdfBytes);
                            }

                            drawAnnotations();
                            finishBtn.innerHTML = `<i data-lucide="send"></i> Finish & Submit`;
                            if (window.lucide) lucide.createIcons();

                            saveToVault(null, true); // ALWAYS AUTO-SAVE
                        }
                    } catch (e) {
                        console.error("Attachment Save Fail:", e);
                        alert("Failed to save attachment edits: " + e.message);
                    }
                    return;
                }

                const defaultName = activeTrip && activeTrip.inv ? activeTrip.inv : "Daily Load Packet";
                const customName = prompt("Enter a name for this Load Packet:", "");
                if (customName === null) return;
                saveToVault(customName.trim() || defaultName, true); // IMMEDIATE SAVE
                resetView(true); // Auto-reset after finish
            };
        }

        const btnEditInMain = document.getElementById('btn-edit-in-main');
        if (btnEditInMain) {
            btnEditInMain.onclick = async () => {
                const previewModal = document.getElementById('attachment-preview-modal');
                if (!currentPreviewFile) return;

                // Save current state to stack before switching
                stateStack.push({
                    bytes: currentPdfBytes,
                    doc: currentPdf,
                    annos: [...annotations],
                    type: currentDocType || 'application/pdf',
                    context: currentFileContext,
                    sessionVaultId: sessionVaultId
                });

                // Load attachment into main
                console.log("Switching to Attachment Edit Mode...");
                annotations = [];
                currentFileContext = currentPreviewFile;
                // DO NOT reset sessionVaultId - we want to update the same session entry if possible, 
                // but child edits are volatile until baked into parent.

                let data = currentPreviewFile.data;
                // If it's a PDF and we have raw bytes, use them
                if (currentPreviewFile.type === 'application/pdf' && typeof data === 'string' && data.includes('base64,')) {
                    data = base64ToBytes(data.split('base64,')[1]);
                }

                await loadDocument(data, currentPreviewFile.type);
                previewModal.style.display = 'none';
                popup.style.display = 'none'; // Also hide the point popup

                // Update Finish button label
                if (finishBtn) {
                    finishBtn.innerHTML = `<i data-lucide="save"></i> Save to Attachment`;
                    if (window.lucide) lucide.createIcons();
                }

                alert(`Now editing: ${currentPreviewFile.name}\nUse the sidebar tools to annotate. Click "Save to Attachment" when done.`);
            };
        }

        const btnReturn = document.getElementById('btn-reset-view');
        if (btnReturn) {
            btnReturn.onclick = () => {
                if (stateStack.length > 0) {
                    if (confirm("Discard edits and return to main document?")) {
                        const prevState = stateStack.pop();
                        currentPdfBytes = prevState.bytes;
                        currentPdf = prevState.doc;
                        annotations = prevState.annos;
                        currentDocType = prevState.type;
                        currentFileContext = prevState.context;
                        sessionVaultId = prevState.sessionVaultId;

                        if (currentPdf) renderPage(currentPage);
                        else if (currentPdfBytes) {
                            if (currentDocType.startsWith('image/')) renderImage(currentPdfBytes);
                            else if (currentDocType.includes('text/plain')) renderTextDocument(currentPdfBytes);
                        }

                        drawAnnotations();
                        if (finishBtn) {
                            finishBtn.innerHTML = `<i data-lucide="send"></i> Finish & Submit`;
                            if (window.lucide) lucide.createIcons();
                        }
                    }
                } else {
                    resetView();
                }
            };
        }

        const closePreview = document.getElementById('close-preview');
        if (closePreview) closePreview.onclick = () => {
            document.getElementById('attachment-preview-modal').style.display = 'none';
        };

        if (importBtn) {
            importBtn.onclick = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'application/pdf,image/*,text/plain';
                input.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const type = getMimeByType(file);
                        const reader = new FileReader();
                        reader.onload = async (re) => {
                            let data = re.target.result;
                            if (!(type.startsWith('image/') || type === 'text/plain')) data = new Uint8Array(data);
                            annotations = [];
                            await loadDocument(data, type);
                            ensureDefaultDots(true); // Add specialized dots on import
                        };
                        if (type.startsWith('image/') || type === 'text/plain') reader.readAsDataURL(file);
                        else reader.readAsArrayBuffer(file);
                    }
                };
                input.click();
            };
        }

        // --- DRAG & DROP SUPPORT ---
        // Global prevention to stop browser from opening files in new tab
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', (e) => e.preventDefault());

        if (canvasContainer) {
            canvasContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                canvasContainer.style.borderColor = '#0ea5e9';
                canvasContainer.style.background = 'rgba(14, 165, 233, 0.05)';
            });
            canvasContainer.addEventListener('dragleave', () => {
                canvasContainer.style.borderColor = 'var(--border)';
                canvasContainer.style.background = 'transparent';
            });
            canvasContainer.addEventListener('drop', async (e) => {
                e.preventDefault();
                canvasContainer.style.borderColor = 'var(--border)';
                canvasContainer.style.background = 'transparent';

                const file = e.dataTransfer.files[0];
                if (file) {
                    const type = getMimeByType(file);
                    console.log("Dropped file detected:", file.name, type);
                    const reader = new FileReader();
                    reader.onload = async (re) => {
                        let data = re.target.result;
                        if (!(type.startsWith('image/') || type === 'text/plain')) data = new Uint8Array(data);
                        annotations = [];
                        await loadDocument(data, type);
                    };
                    if (type.startsWith('image/') || type === 'text/plain') reader.readAsDataURL(file);
                    else reader.readAsArrayBuffer(file);
                    ensureDefaultDots(true); // Add specialized dots on drop
                }
            });
        }

        if (btnSaveForm) {
            btnSaveForm.onclick = async () => {
                try {
                    console.log("Generating Manual PDF: Start");
                    const inv = document.getElementById('manual-inv')?.value || "M-" + Date.now();
                    const po = document.getElementById('manual-po')?.value || "N/A";
                    const loadNum = document.getElementById('manual-load')?.value || "N/A";
                    const orderNum = document.getElementById('manual-order')?.value || "N/A";
                    const billedFull = document.getElementById('manual-billed-to')?.value || "N/A";
                    // Split billedFull into name and address if possible (e.g. by comma)
                    let billedTo = "N/A";
                    let billedAddr = "N/A";
                    if (billedFull !== "N/A") {
                        const billedSplit = billedFull.split(',');
                        billedTo = billedSplit[0].trim();
                        billedAddr = billedSplit.length > 1 ? billedSplit.slice(1).join(',').trim() : "N/A";
                    }

                    const from = document.getElementById('manual-from')?.value || "N/A";
                    const to = document.getElementById('manual-to')?.value || "N/A";
                    const truck = document.getElementById('manual-truck')?.value || "N/A";
                    const trailer = document.getElementById('manual-trailer')?.value || "N/A";
                    const driverId = document.getElementById('manual-driver-id')?.value || "N/A";
                    const payment = document.getElementById('manual-payment')?.value || "N/A";
                    const driver = (activeTrip ? activeTrip.driver : "Driver");
                    const date = new Date().toLocaleDateString();
                    const terms = payment; // Use payment field for Terms
                    const details = document.getElementById('manual-details')?.value || "N/A";
                    const miles = document.getElementById('manual-miles')?.value || "N/A";
                    const notes = document.getElementById('manual-notes')?.value || "N/A";
                    const total = document.getElementById('manual-total')?.value || "0.00";

                    // Ensure activeTrip is consistent
                    activeTrip = activeTrip || { driver: driver, startTime: new Date() };
                    activeTrip.inv = inv;
                    activeTrip.load = loadNum;
                    activeTrip.order = orderNum;

                    // Clear previous doc data to avoid ghosting
                    currentPdfBytes = null;
                    currentPdf = null;

                    btnSaveForm.innerText = "GENERATING...";
                    btnSaveForm.disabled = true;

                    if (typeof PDFLib === 'undefined') {
                        const msg = "PDF library not loaded. Please refresh or check your connection.";
                        console.error(msg);
                        alert(msg);
                        btnSaveForm.innerText = "Create Shipment";
                        btnSaveForm.disabled = false;
                        return;
                    }

                    const pdfDoc = await PDFLib.PDFDocument.create();
                    const page = pdfDoc.addPage([600, 800]);
                    const { rgb, StandardFonts } = PDFLib;
                    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
                    const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);

                    // Header & Branding
                    page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.06, 0.09, 0.16) });
                    page.drawText("BILL OF LADING / INVOICE", { x: 40, y: 755, size: 24, font: fontBold, color: rgb(1, 1, 1) });

                    const prefixText = "Date,Name of PaperWork and Job ID#: ";
                    const prefixSize = 10;
                    page.drawText(prefixText, { x: 40, y: 730, size: prefixSize, font: fontBold, color: rgb(0.05, 0.65, 0.9) });
                    const prefixWidth = fontBold.widthOfTextAtSize(prefixText, prefixSize);
                    page.drawText(inv, { x: 40 + prefixWidth, y: 730, size: prefixSize, font: fontBold, color: rgb(1, 1, 1) });

                    page.drawText("COLUMBIA TRANSPORT LLC LOGISTICS PORTAL", { x: 350, y: 755, size: 10, font: fontBold, color: rgb(0.05, 0.65, 0.9) });
                    page.drawText("Automated Payload System", { x: 400, y: 740, size: 9, font: fontReg, color: rgb(0.6, 0.6, 0.6) });

                    // Data Grid - Section 1: Parties
                    page.drawText("BILL TO:", { x: 40, y: 670, size: 10, font: fontBold, color: rgb(0.05, 0.65, 0.9) });
                    page.drawText(billedTo, { x: 40, y: 655, size: 12, font: fontBold });
                    page.drawText(billedAddr, { x: 40, y: 640, size: 9, font: fontReg, color: rgb(0.3, 0.3, 0.3) });

                    page.drawText("CARRIER DETAILS:", { x: 300, y: 670, size: 10, font: fontBold, color: rgb(0.05, 0.65, 0.9) });
                    page.drawText(`Driver: ${driver} (${driverId})`, { x: 300, y: 655, size: 10, font: fontReg });
                    page.drawText(`Truck: ${truck} | Trailer: ${trailer}`, { x: 300, y: 640, size: 10, font: fontReg });
                    page.drawText(`Payment: ${payment}`, { x: 300, y: 625, size: 10, font: fontReg });

                    // Section 2: Reference & Dates
                    page.drawRectangle({ x: 40, y: 560, width: 520, height: 65, color: rgb(0.96, 0.97, 0.99) });
                    // Row 1
                    page.drawText("CUST PO / REF", { x: 50, y: 612, size: 8, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                    page.drawText(po, { x: 50, y: 598, size: 10, font: fontReg });

                    page.drawText("DATE", { x: 200, y: 612, size: 8, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                    page.drawText(date, { x: 200, y: 598, size: 10, font: fontReg });

                    page.drawText("TERMS", { x: 350, y: 612, size: 8, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                    page.drawText(terms, { x: 350, y: 598, size: 10, font: fontReg });

                    // Row 2
                    page.drawText("LOAD #", { x: 50, y: 580, size: 8, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                    page.drawText(loadNum, { x: 50, y: 566, size: 10, font: fontReg });

                    page.drawText("ORDER #", { x: 200, y: 580, size: 8, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                    page.drawText(orderNum, { x: 200, y: 566, size: 10, font: fontReg });

                    page.drawText("MILES", { x: 350, y: 580, size: 8, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                    page.drawText(miles, { x: 350, y: 566, size: 10, font: fontReg });

                    // Section 3: Routes
                    page.drawText("SHIPMENT PATH", { x: 40, y: 535, size: 10, font: fontBold, color: rgb(0.05, 0.65, 0.9) });
                    page.drawText("FROM:", { x: 40, y: 520, size: 8, font: fontBold });
                    page.drawText(from, { x: 40, y: 507, size: 11, font: fontReg });
                    page.drawText("TO:", { x: 300, y: 520, size: 8, font: fontBold });
                    page.drawText(to, { x: 300, y: 507, size: 11, font: fontReg });

                    // Section 4: Items Table Header
                    page.drawRectangle({ x: 40, y: 455, width: 520, height: 25, color: rgb(0.06, 0.09, 0.16) });
                    page.drawText("DESCRIPTION OF ARTICLES / SPECIAL MARKS", { x: 50, y: 463, size: 9, font: fontBold, color: rgb(1, 1, 1) });

                    // Item Row
                    page.drawRectangle({ x: 40, y: 415, width: 520, height: 40, color: rgb(1, 1, 1), borderVisible: true, borderDark: true });
                    page.drawText(details, { x: 50, y: 430, size: 12, font: fontReg });

                    // Section 5: Notes & Total
                    page.drawText("SPECIAL INSTRUCTIONS:", { x: 40, y: 385, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.4) });
                    page.drawText(notes, { x: 40, y: 370, size: 10, font: fontReg, maxWidth: 300 });

                    page.drawRectangle({ x: 380, y: 345, width: 180, height: 60, color: rgb(0.95, 0.98, 1) });
                    page.drawText("TOTAL CHARGES", { x: 390, y: 390, size: 10, font: fontBold, color: rgb(0.05, 0.65, 0.9) });
                    page.drawText(`$${total}`, { x: 390, y: 360, size: 22, font: fontBold, color: rgb(0.06, 0.09, 0.16) });

                    // Legal Footer
                    page.drawText("I hereby certify that the above named articles are properly classified and described.", { x: 40, y: 60, size: 8, font: fontReg, color: rgb(0.5, 0.5, 0.5) });

                    const bytes = await pdfDoc.save();
                    currentPdfBytes = bytes;
                    annotations = [];

                    // AUTO-SAVE TO VAULT FIRST (before loadDocument can detach the buffer)
                    saveToVault(inv);

                    await loadDocument(bytes, 'application/pdf');
                    ensureDefaultDots(false); // Specialized dots for New Load papers
                    drawAnnotations();
                    saveToVault();

                    if (loadEntryModal) loadEntryModal.style.display = 'none';
                    console.log("Manual PDF Generation: Success & Auto-Saved.");
                } catch (err) {
                    console.error("Manual PDF Generation Fail:", err);
                    alert("Error generating PDF: " + err.message);
                } finally {
                    btnSaveForm.innerText = "GENERATE LOAD PAPERWORK";
                    btnSaveForm.disabled = false;
                }
            };
        }

        // Closer Handlers
        ['close-vault', 'close-load', 'close-popup', 'close-share', 'close-stamps'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.onclick = () => {
                const mod = id.includes('vault') ? vaultModal : id.includes('load') ? loadEntryModal : id.includes('popup') ? popup : id.includes('stamps') ? document.getElementById('stamp-picker') : document.getElementById('share-modal');
                if (mod) mod.style.display = 'none';
                if (id === 'close-popup') {
                    activeAnno = null;
                    saveToVault(); // AUTO-SAVE when closing the attachment point
                }
            };
        });
        const dotNameInput = document.getElementById('popup-dot-name');
        if (dotNameInput) {
            dotNameInput.oninput = (e) => {
                if (activeAnno && activeAnno.type === 'attach') {
                    activeAnno.name = e.target.value;
                    drawAnnotations();
                    saveToVault(); // AUTO-SAVE when renaming the dot
                }
            };
        }

        // Renaming Packet Sync
        const packetNameInput = document.getElementById('share-packet-name');
        if (packetNameInput) {
            packetNameInput.oninput = (e) => {
                if (activeTrip) {
                    activeTrip.inv = e.target.value;
                    saveToVault();
                }
            };
        }

        // Attachment Actions (Scan & Upload) - REAL CAMERA IMPLEMENTATION
        const btnScan = document.getElementById('btn-scan-camera');
        if (btnScan) {
            btnScan.onclick = async () => {
                const modal = document.getElementById('camera-modal');
                const video = document.getElementById('video-preview');
                const captureBtn = document.getElementById('btn-capture');
                const closeBtn = document.getElementById('close-camera');

                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                    video.srcObject = stream;
                    modal.style.display = 'flex';

                    captureBtn.onclick = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = video.videoWidth;
                        canvas.height = video.videoHeight;
                        canvas.getContext('2d').drawImage(video, 0, 0);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

                        if (activeAnno && activeAnno.type === 'attach') {
                            activeAnno.files.push({ type: 'image/jpeg', name: 'Scan_' + Date.now() + '.jpg', data: dataUrl });
                            renderFileList();
                            saveToVault(); // AUTO-SAVE after scan capture
                        }

                        stream.getTracks().forEach(t => t.stop());
                        modal.style.display = 'none';
                    };

                    closeBtn.onclick = () => {
                        stream.getTracks().forEach(t => t.stop());
                        modal.style.display = 'none';
                    };
                } catch (err) {
                    console.error("Camera access denied:", err);
                    alert("Could not access camera: " + err.message);
                }
            };
        }

        // ---- QUICK SCAN BUTTON ----
        // Opens rear camera, captures image, loads directly into the main viewer
        const btnQuickScan = document.getElementById('btn-quick-scan');
        if (btnQuickScan) {
            btnQuickScan.onclick = async () => {
                const modal = document.getElementById('camera-modal');
                const video = document.getElementById('video-preview');
                const captureBtn = document.getElementById('btn-capture');
                const closeBtn = document.getElementById('close-camera');

                // Update button label for context
                captureBtn.textContent = 'Capture & Load';

                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                    video.srcObject = stream;
                    modal.style.display = 'flex';

                    const doCapture = async () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = video.videoWidth;
                        canvas.height = video.videoHeight;
                        canvas.getContext('2d').drawImage(video, 0, 0);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

                        stream.getTracks().forEach(t => t.stop());
                        modal.style.display = 'none';
                        captureBtn.textContent = 'Capture';

                        // Load the scan directly into the main viewer
                        annotations = [];
                        await loadDocument(dataUrl, 'image/jpeg');
                        saveToVault();
                    };

                    captureBtn.onclick = doCapture;
                    closeBtn.onclick = () => {
                        stream.getTracks().forEach(t => t.stop());
                        modal.style.display = 'none';
                        captureBtn.textContent = 'Capture';
                    };
                } catch (err) {
                    console.error('Quick Scan camera error:', err);
                    alert('Could not access camera: ' + err.message);
                }
            };
        }

        const btnUpload = document.getElementById('btn-upload-file');
        if (btnUpload) {
            btnUpload.onclick = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*,application/pdf,text/plain';
                input.onchange = (e) => {
                    const file = e.target.files[0];
                    if (file && activeAnno && activeAnno.type === 'attach') {
                        const type = getMimeByType(file);
                        const reader = new FileReader();
                        reader.onload = async (re) => {
                            let data = re.target.result;
                            let thumbData = null;
                            if (type === 'application/pdf') {
                                try {
                                    const b64 = data.includes('base64,') ? data.split('base64,')[1] : data;
                                    const pdfBytes = base64ToBytes(b64);
                                    const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
                                    const page = await pdf.getPage(1);
                                    const viewport = page.getViewport({ scale: 0.5 });
                                    const canvas = document.createElement('canvas');
                                    canvas.width = viewport.width; canvas.height = viewport.height;
                                    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                                    thumbData = canvas.toDataURL('image/jpeg', 0.8);
                                } catch (err) { console.error("PDF Thumb Fail", err); }
                            }
                            activeAnno.files.push({ type: type, name: file.name, data: data, thumbData: thumbData });
                            renderFileList();
                            saveToVault(); // Auto-save on upload
                            alert("File attached: " + file.name);
                        };
                        reader.readAsDataURL(file);
                    }
                };
                input.click();
            };
        }

        const mobileBtn = document.getElementById('btn-mobile-fab');
        if (mobileBtn) {
            mobileBtn.onclick = () => {
                try {
                    console.log("Mobile Toggle Flow: Start");
                    const hasClassBefore = document.body.classList.contains('mobile-preview-mode');
                    document.body.classList.toggle('mobile-preview-mode');
                    const hasClassAfter = document.body.classList.contains('mobile-preview-mode');
                    console.log("Mobile Toggle: Class toggled from", hasClassBefore, "to", hasClassAfter);

                    mobileBtn.innerHTML = hasClassAfter ? `<i data-lucide="monitor"></i>` : `<i data-lucide="smartphone"></i>`;
                    if (window.lucide) {
                        try { lucide.createIcons(); } catch (e) { console.error("Lucide inner fail", e); }
                    }
                    setTimeout(() => {
                        console.log("Mobile Toggle: Redrawing annotations...");
                        drawAnnotations();
                    }, 100);
                } catch (e) {
                    console.error("Critical Toggle Crash:", e);
                    alert("Mobile Toggle Failed: " + e.message);
                }
            };
        }

        window.addEventListener('resize', () => { if (currentPdfBytes) drawAnnotations(); });

        // ---- CALENDAR (dynamic modal, no HTML dependency) ----
        window.openCalendar = function () {
            var existing = document.getElementById('_cal_modal');
            if (existing) { existing.remove(); }
            var now = new Date(), y = now.getFullYear(), m = now.getMonth();
            var state = { y: y, m: m };

            function buildHTML(sy, sm) {
                var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                var first = new Date(sy, sm, 1).getDay(), days = new Date(sy, sm + 1, 0).getDate();
                var today = new Date(), td = today.getDate(), tm = today.getMonth(), ty = today.getFullYear();
                var cells = '';
                for (var i = 0; i < first; i++) cells += '<span></span>';
                for (var d = 1; d <= days; d++) {
                    var isT = d === td && sm === tm && sy === ty;
                    cells += '<span style="padding:5px 2px;border-radius:6px;font-size:13px;color:' + (isT ? '#0f172a' : '#cbd5e1') + ';background:' + (isT ? '#0ea5e9' : 'transparent') + ';font-weight:' + (isT ? '700' : '400') + '">' + d + '</span>';
                }
                var todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
                return '<div style="background:#0f172a;border:2px solid #0ea5e9;border-radius:16px;width:320px;padding:1.25rem;box-shadow:0 0 30px rgba(14,165,233,0.3);">\
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">\
                        <button id="_cal_prev" style="background:none;border:none;color:#93c5fd;font-size:1.3rem;cursor:pointer;">&#8592;</button>\
                        <span style="color:white;font-weight:700;font-size:1rem;">'+ months[sm] + ' ' + sy + '</span>\
                        <button id="_cal_next" style="background:none;border:none;color:#93c5fd;font-size:1.3rem;cursor:pointer;">&#8594;</button>\
                        <button onclick="document.getElementById(\'_cal_modal\').remove()" style="background:none;border:none;color:white;font-size:1.1rem;cursor:pointer;margin-left:6px;">✕</button>\
                    </div>\
                    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;margin-bottom:6px;">\
                        <span style="color:#64748b;font-size:11px">Su</span><span style="color:#64748b;font-size:11px">Mo</span><span style="color:#64748b;font-size:11px">Tu</span><span style="color:#64748b;font-size:11px">We</span><span style="color:#64748b;font-size:11px">Th</span><span style="color:#64748b;font-size:11px">Fr</span><span style="color:#64748b;font-size:11px">Sa</span>\
                    </div>\
                    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center;">'+ cells + '</div>\
                    <div style="margin-top:0.75rem;text-align:center;color:#34d399;font-size:12px;">Today: '+ todayStr + '</div>\
                </div>';
            }

            function refresh() {
                var inner = document.getElementById('_cal_inner');
                if (inner) { inner.innerHTML = buildHTML(state.y, state.m); }
                var prev = document.getElementById('_cal_prev'), next = document.getElementById('_cal_next');
                if (prev) prev.onclick = function () { state.m--; if (state.m < 0) { state.m = 11; state.y--; } refresh(); };
                if (next) next.onclick = function () { state.m++; if (state.m > 11) { state.m = 0; state.y++; } refresh(); };
            }

            var overlay = document.createElement('div');
            overlay.id = '_cal_modal';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = '<div id="_cal_inner">' + buildHTML(state.y, state.m) + '</div>';
            overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);
            var prev = document.getElementById('_cal_prev'), next = document.getElementById('_cal_next');
            if (prev) prev.onclick = function () { state.m--; if (state.m < 0) { state.m = 11; state.y--; } refresh(); };
            if (next) next.onclick = function () { state.m++; if (state.m > 11) { state.m = 0; state.y++; } refresh(); };
        };

        // ---- CALCULATOR (dynamic modal, no HTML dependency) ----
        window.openCalc = function () {
            var existing = document.getElementById('_calc_modal');
            if (existing) { existing.remove(); }
            var expr = '';
            var overlay = document.createElement('div');
            overlay.id = '_calc_modal';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = '<div style="background:#0f172a;border:2px solid #0ea5e9;border-radius:16px;width:275px;padding:1.25rem;box-shadow:0 0 30px rgba(14,165,233,0.3);">\
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">\
                    <span style="color:white;font-weight:700;">Calculator</span>\
                    <button onclick="document.getElementById(\'_calc_modal\').remove()" style="background:none;border:none;color:white;font-size:1.1rem;cursor:pointer;">✕</button>\
                </div>\
                <div id="_calc_disp" style="background:#1e293b;color:white;font-size:1.6rem;font-weight:700;text-align:right;padding:0.75rem 1rem;border-radius:10px;margin-bottom:0.75rem;min-height:54px;word-break:break-all;">0</div>\
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;" id="_calc_btns"></div>\
            </div>';
            overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
            document.body.appendChild(overlay);

            var disp = document.getElementById('_calc_disp');
            var btns = document.getElementById('_calc_btns');
            var keys = [['C', 'C', 1, '#ef4444'], ['%', '%', 1, '#374151'], ['⌫', '⌫', 1, '#374151'], ['÷', '/', 1, '#0ea5e9'], ['7', '7'], ['8', '8'], ['9', '9'], ['×', '*', 1, '#0ea5e9'], ['4', '4'], ['5', '5'], ['6', '6'], ['−', '-', 1, '#0ea5e9'], ['1', '1'], ['2', '2'], ['3', '3'], ['+', '+', 1, '#0ea5e9'], ['0', '0', 2], ['.', '.'], ['=', '=', 1, '#22c55e']];
            keys.forEach(function (k) {
                var b = document.createElement('button');
                b.textContent = k[0];
                b.style.cssText = 'background:' + (k[3] || '#1e293b') + ';color:white;border:none;border-radius:8px;padding:0.65rem;font-size:1rem;font-weight:600;cursor:pointer;' + (k[2] === 2 ? 'grid-column:span 2;' : '');
                b.onclick = function () {
                    var v = k[1];
                    if (v === 'C') { expr = ''; }
                    else if (v === '⌫') { expr = expr.slice(0, -1); }
                    else if (v === '%') { try { expr = String(parseFloat(Function('"use strict";return(' + expr + ')')()) / 100); } catch (e) { expr = 'Error'; } }
                    else if (v === '=') { try { expr = String(Function('"use strict";return(' + expr + ')')()); } catch (e) { expr = 'Error'; } }
                    else { expr += v; }
                    disp.textContent = expr || '0';
                };
                btns.appendChild(b);
            });
        };

        var bCal = document.getElementById('btn-calendar');
        var bCalc = document.getElementById('btn-calc');
        if (bCal) bCal.onclick = window.openCalendar;
        if (bCalc) bCalc.onclick = window.openCalc;


        // 3. ANNOTATION EVENT LISTENERS (Moved inside for scope safety)
        canvasContainer.addEventListener('mousedown', (e) => {
            if (!currentPdfBytes || !selectedTool || isDragging) return;
            const clickCoords = getEventCoords(e, canvasContainer);
            const center = getCanvasCenter();

            if (selectedTool === 'text') {
                const t = prompt("Enter Blue Text:");
                if (t) annotations.push({ type: 'text', x: clickCoords.nx, y: clickCoords.ny, content: t, id: Date.now() });
            } else if (selectedTool === 'attach') {
                const a = { type: 'attach', x: clickCoords.nx, y: clickCoords.ny, files: [], id: Date.now(), name: 'New Attachment' };
                annotations.push(a); openPopup(a);
            } else if (selectedTool === 'stamp') {
                openStampPicker(clickCoords.nx, clickCoords.ny);
            } else if (selectedTool === 'sign') {
                openSignatureModal(clickCoords.nx, clickCoords.ny);
            } else if (selectedTool === 'pen') {
                isDrawing = true;
                currentStroke = { type: 'pen', points: [{ nx: clickCoords.nx, ny: clickCoords.ny }], color: '#ef4444', id: Date.now() };
                drawAnnotations();
            } else if (selectedTool === 'eraser') {
                isDrawing = true;
                window.handleEraser(clickCoords);
            }
        });

        const mainTouchMove = (e) => {
            if (isDrawing && selectedTool === 'pen') {
                e.preventDefault();
                const p = getEventCoords(e, canvasContainer);
                if (currentStroke) {
                    currentStroke.points.push({ nx: p.nx, ny: p.ny });
                    drawAnnotations();
                }
            } else if (isDrawing && selectedTool === 'eraser') {
                e.preventDefault();
                const p = getEventCoords(e, canvasContainer);
                window.handleEraser(p);
            }
        };
        canvasContainer.addEventListener('mousemove', mainTouchMove);
        canvasContainer.addEventListener('touchmove', mainTouchMove, { passive: false });
        canvasContainer.addEventListener('touchstart', (e) => {
            if (selectedTool === 'pen') {
                e.preventDefault();
                isDrawing = true;
                const p = getEventCoords(e, canvasContainer);
                currentStroke = { type: 'pen', points: [{ nx: p.nx, ny: p.ny }], color: '#ef4444', id: Date.now() };
                drawAnnotations();
            } else if (selectedTool === 'eraser') {
                e.preventDefault();
                isDrawing = true;
                const p = getEventCoords(e, canvasContainer);
                window.handleEraser(p);
            }
        }, { passive: false });

        const dragMove = (e) => {
            if (isDragging && dragTarget) {
                if (e.type === 'touchmove') e.preventDefault();
                const c = getEventCoords(e, canvasContainer);
                dragTarget.x = c.nx - dragOffset.x;
                dragTarget.y = c.ny - dragOffset.y;
                drawAnnotations();
            }
        };
        window.addEventListener('mousemove', dragMove);
        window.addEventListener('touchmove', dragMove, { passive: false });
        const handleStrokeEnd = () => {
            if (isDrawing && selectedTool === 'pen' && currentStroke) {
                annotations.push(currentStroke);
                currentStroke = null;
                isDrawing = false;
                drawAnnotations(); // Critically missing! Redraw to create the red X delete overlay
                saveToVault(); // AUTO-SAVE after pen stroke
            }
            isDragging = false; dragTarget = null; isDrawing = false; currentStroke = null;
        };

        window.addEventListener('touchend', handleStrokeEnd);
        window.addEventListener('touchcancel', handleStrokeEnd);
        window.addEventListener('mouseup', handleStrokeEnd);
        window.addEventListener('pointerup', handleStrokeEnd);
        window.addEventListener('pointercancel', handleStrokeEnd);

        console.log("initButtons: Completed successfully.");
    } catch (err) {
        console.error("CRITICAL INIT ERROR:", err);
        const b = document.getElementById('debug-error-banner');
        if (b) {
            b.style.display = 'block';
            b.innerHTML = "<strong>CRITICAL INIT ERROR:</strong><br>" + err.stack;
        }
    }
}

// Global scope definition removed (moved to top)

function resetView(force = false) {
    if (!force && !confirm("Clear current work and start over?")) return;
    annotations = [];
    currentPdf = null;
    currentPdfBytes = null;
    activeTrip = null; // CRITICAL: Reset the trip data too!
    sessionVaultId = null; // Clear session tracking
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    canvasContainer.innerHTML = `
        <div style="color: var(--text-dim); text-align: center; padding: 10rem;">
            <i data-lucide="file-up" style="width: 64px; height: 64px; margin-bottom: 1.5rem; opacity: 0.2;"></i>
            <p style="font-weight: 600; font-size: 1.2rem;">Drop an Invoice to start editing</p>
        </div>
    `;
    if (window.lucide) lucide.createIcons();
}

// 2. UNIVERSAL LOADING
let currentDocType = 'application/pdf';
async function loadDocument(data, type = 'application/pdf') {
    console.log("loadDocument: Start", type);
    if (!data) return;
    if (startOverlay) startOverlay.style.display = 'none';
    currentDocType = type || 'application/pdf';
    currentPdfBytes = data;
    try {
        currentPage = 1; scale = 1.5;
        if (!type || type.includes('pdf')) {
            let bytes = data;
            if (typeof data === 'string') {
                if (data.includes('base64,')) bytes = base64ToBytes(data.split('base64,')[1]);
                else bytes = base64ToBytes(data);
            }
            currentPdfBytes = bytes;
            console.log("PDF.js loading task creation...");
            const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0) });
            currentPdf = await loadingTask.promise;
            console.log("PDF.js doc loaded, rendering page 1");
            await renderPage(1);
        } else if (type.startsWith('image/')) {
            currentPdf = null;
            await renderImage(data);
        } else if (type.includes('text/plain')) {
            currentPdf = null;
            await renderTextDocument(data);
        }
        saveToVault(); // Ensure document state is initially captured in vault
    } catch (e) {
        console.error("loadDocument Crash:", e);
        alert("Error loading document: " + e.message);
    }
}

async function renderPage(num) {
    if (!currentPdf) return;
    const page = await currentPdf.getPage(num);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.height = viewport.height; canvas.width = viewport.width;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const wrapper = document.createElement('div');
    wrapper.id = 'canvas-wrapper';
    wrapper.style.cssText = 'position: relative; box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.7); background: white; border-radius: 4px;';
    wrapper.appendChild(canvas);

    canvasContainer.innerHTML = '';
    canvasContainer.appendChild(wrapper);
    drawAnnotations();
}

async function renderImage(data) {
    const img = new Image();
    img.src = data;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);

    const wrapper = document.createElement('div');
    wrapper.id = 'canvas-wrapper';
    wrapper.style.cssText = 'position: relative; box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.7); background: white; border-radius: 4px;';
    wrapper.appendChild(canvas);

    canvasContainer.innerHTML = '';
    canvasContainer.appendChild(wrapper);
    drawAnnotations();
}

async function renderTextDocument(data) {
    const textStr = data.includes('base64,') ? atob(data.split(',')[1]) : data;
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = 'black'; ctx.font = '14px Courier';
    textStr.split('\n').forEach((l, i) => ctx.fillText(l, 20, 30 + (i * 18)));

    const wrapper = document.createElement('div');
    wrapper.id = 'canvas-wrapper';
    wrapper.style.cssText = 'position: relative; box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.7); background: white; border-radius: 4px;';
    wrapper.appendChild(canvas);

    canvasContainer.innerHTML = '';
    canvasContainer.appendChild(wrapper);
    drawAnnotations();
}

function ensureDefaultDots(isImport = false) {
    const labels = ["SHIPPER PAPERS", "RECEIVER PAPERS"];
    labels.forEach((label, i) => {
        let nx = 0.8, ny = 0.1 + (i * 0.1);
        if (!isImport) {
            if (i === 0) { nx = 0.31; ny = 0.43; }
            else { nx = 0.81; ny = 0.43; }
        }

        let dot = annotations.find(a => a.type === 'attach' && a.name === label);
        if (!dot) {
            dot = { type: 'attach', x: nx, y: ny, files: [], id: Date.now() + i, name: label };
            annotations.push(dot);
        } else if (dot.x === 0 && dot.y === 0) {
            // Self-healing: Reset if stuck at 0,0
            dot.x = nx; dot.y = ny;
        }
    });
}

// 3. ANNOTATIONS
function drawAnnotations() {
    const wrapper = document.getElementById('canvas-wrapper');
    const mainCanvas = canvasContainer.querySelector('canvas');
    if (!mainCanvas || !wrapper) return;

    const rect = mainCanvas.getBoundingClientRect();
    const scX = rect.width / mainCanvas.width;

    // NEW: Use the wrapper as the coordinate source
    const seenIds = new Set();
    const currentOverlays = Array.from(wrapper.querySelectorAll('.overlay-item, .overlay-point'));

    annotations.forEach((anno, idx) => {
        seenIds.add(anno.id.toString());
        let el = currentOverlays.find(o => o.dataset.id === anno.id.toString());

        if (!el) {
            el = document.createElement('div');
            el.dataset.id = anno.id;
            el.draggable = false;
            wrapper.appendChild(el);
        }

        el.className = 'overlay-item';

        if (anno.type !== 'pen') {
            // Percent-based positioning relative to the wrapper!
            const posX = (anno.x * 100).toFixed(4) + '%';
            const posY = (anno.y * 100).toFixed(4) + '%';

            let scaleVal = scX;
            if (anno.type === 'text') scaleVal = Math.min(1.2, Math.max(0.5, scX) * 0.8);
            else if (anno.type === 'stamp' || anno.type === 'sign') scaleVal = Math.max(0.75, scX);
            else if (anno.type === 'attach') scaleVal = Math.max(0.5, scX);

            el.style.left = posX;
            el.style.top = posY;
            el.style.transform = `translate(-50%, -50%) scale(${scaleVal})`;
            el.style.touchAction = 'none'; // Prevent browser scrolling during drag
            el.style.webkitUserSelect = 'none'; // Prevent text selection
        }
        el.style.zIndex = 100 + idx;

        if (anno.type === 'text') {
            el.innerText = anno.content;
            el.className += ' overlay-text';
            el.style.color = '#3b82f6'; el.style.fontWeight = '800'; el.style.cursor = 'move';

            // Improved Editing: Single click with distance check to allow drag
            let startEditX, startEditY;
            el.addEventListener('mousedown', (e) => {
                startEditX = e.clientX;
                startEditY = e.clientY;
            });

            el.onclick = (e) => {
                e.stopPropagation();
                if (startEditX === undefined) return;
                const dist = Math.hypot(e.clientX - startEditX, e.clientY - startEditY);
                if (dist < 5) {
                    const newT = prompt("Edit Text content:", anno.content);
                    if (newT !== null && newT.trim() !== '') {
                        anno.content = newT;
                        drawAnnotations();
                        saveToVault(); // AUTO-SAVE after edit
                    }
                }
            };

        } else if (anno.type === 'stamp') {
            el.classList.add('stamp-item');
            el.classList.add(`stamp-${anno.content.toLowerCase().replace(/\s+/g, '-')}`);
            el.style.cursor = 'move';

            // Ensure text span exists
            let txt = el.querySelector('.stamp-text');
            if (!txt) {
                txt = document.createElement('span');
                txt.className = 'stamp-text';
                el.appendChild(txt);
            }
            txt.innerText = anno.content;

            // Add Delete Button for stamps
            let del = el.querySelector('.delete-anno');
            if (!del) {
                del = document.createElement('div');
                del.className = 'delete-anno'; del.innerText = '×';
                el.appendChild(del);
                del.onpointerdown = (e) => {
                    e.stopPropagation();
                    const idx = annotations.findIndex(a => a.id === anno.id);
                    if (idx !== -1) {
                        annotations.splice(idx, 1);
                        drawAnnotations();
                        saveToVault(null, true);
                    }
                };
            }
        } else if (anno.type === 'sign') {
            el.classList.add('sig-item'); el.style.cursor = 'move';

            // Ensure image exists
            let img = el.querySelector('img');
            if (!img) {
                img = document.createElement('img');
                img.style.cssText = 'width: 150px; pointer-events: none;';
                el.appendChild(img);
            }
            img.src = anno.content;

            // Add Delete Button for signatures
            let del = el.querySelector('.delete-anno');
            if (!del) {
                del = document.createElement('div');
                del.className = 'delete-anno'; del.innerText = '×';
                el.appendChild(del);
                del.onpointerdown = (e) => {
                    e.stopPropagation();
                    const idx = annotations.findIndex(a => a.id === anno.id);
                    if (idx !== -1) {
                        annotations.splice(idx, 1);
                        drawAnnotations();
                        saveToVault(null, true);
                    }
                };
            }
        } else if (anno.type === 'attach') {
            el.className = 'overlay-point'; // Replace item class

            // Add Label if missing
            let label = el.querySelector('.overlay-label');
            if (!label) {
                label = document.createElement('div');
                label.className = 'overlay-label';
                el.appendChild(label);
            }
            label.innerText = (anno.name || 'Unnamed Attachment').toUpperCase();
            label.style.cssText = `
                position: absolute;
                top: 25px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(15, 23, 42, 0.9);
                color: #ffffff;
                font-size: 10px;
                font-weight: 800;
                padding: 2px 8px;
                border-radius: 6px;
                white-space: nowrap;
                pointer-events: none;
                border: 1px solid rgba(14, 165, 233, 0.3);
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                text-transform: uppercase;
                letter-spacing: 0.02em;
            `;

            // Setup click listeners ONLY ONCE if possible, or update them
            // Clean up old listeners to prevent stacking if we aren't careful
            // For now, we'll just re-bind if it's new, otherwise let them be.
            if (!el.dataset.bound) {
                el.dataset.bound = "true";
                let startX, startY;
                const handleStart = (e) => {
                    startX = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
                    startY = (e.touches && e.touches.length > 0) ? e.touches[0].clientY : e.clientY;
                };
                const handleEnd = (e) => {
                    if (startX === undefined) return;
                    const endX = (e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0].clientX : e.clientX;
                    const endY = (e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0].clientY : e.clientY;
                    const dist = Math.hypot(endX - startX, endY - startY);
                    if (dist < 5) {
                        e.preventDefault(); e.stopPropagation();
                        openPopup(anno);
                    }
                    startX = undefined;
                };
                el.addEventListener('mousedown', handleStart);
                el.addEventListener('touchstart', handleStart, { passive: false });
                el.addEventListener('mouseup', handleEnd);
                el.addEventListener('touchend', handleEnd, { passive: false });
            }

            // Display file count inside the dot (clear text first)
            const count = (anno.files && anno.files.length > 0) ? anno.files.length : '';
            if (el.childNodes[0] && el.childNodes[0].nodeType === 3) {
                el.childNodes[0].nodeValue = count;
            } else {
                el.insertBefore(document.createTextNode(count), el.firstChild);
            }

            // Only add delete button if it is NOT a default required folder
            if (anno.name !== 'SHIPPER PAPERS' && anno.name !== 'RECEIVER PAPERS') {
                let del = el.querySelector('.delete-overlay');
                if (!del) {
                    del = document.createElement('div');
                    del.className = 'delete-overlay'; del.innerText = '×';
                    el.appendChild(del);

                    del.onpointerdown = async (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const targetIdx = annotations.findIndex(a => a.id === anno.id);
                        if (targetIdx !== -1) {
                            annotations.splice(targetIdx, 1);
                            drawAnnotations();
                            saveToVault(null, true);
                        }
                    };
                    del.onclick = (e) => { e.preventDefault(); e.stopPropagation(); };
                }
            }
        } else if (anno.type === 'pen') {
            // Pen strokes purely use the canvas context now. 
            // The Eraser tool handles their deletion. No HTML overlay needed.
            return;
        }

        if (!el.dataset.dragBound) {
            el.dataset.dragBound = "true";
            const startDragInt = (e) => {
                e.stopPropagation();
                isDragging = true; dragTarget = anno;
                const click = getEventCoords(e, canvasContainer);
                dragOffset.x = click.nx - (anno.x || 0);
                dragOffset.y = click.ny - (anno.y || 0);
            };
            el.addEventListener('mousedown', startDragInt);
            el.addEventListener('touchstart', startDragInt, { passive: false });
        }
    });

    // Remove old elements that aren't in the current annotations list
    currentOverlays.forEach(o => {
        if (!seenIds.has(o.dataset.id)) o.remove();
    });

    const ctx = mainCanvas.getContext('2d');
    const penStrokes = [...annotations.filter(a => a.type === 'pen')];
    if (currentStroke) penStrokes.push(currentStroke);

    penStrokes.forEach(s => {
        if (!s.points || s.points.length < 2) return;
        ctx.strokeStyle = s.color || '#ef4444'; ctx.lineWidth = 3;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();

        const startX = s.points[0].nx * mainCanvas.width;
        const startY = s.points[0].ny * mainCanvas.height;
        ctx.moveTo(startX, startY);

        for (let i = 1; i < s.points.length; i++) {
            ctx.lineTo(s.points[i].nx * mainCanvas.width, s.points[i].ny * mainCanvas.height);
        }
        ctx.stroke();
    });
}

// 4. VAULT (Optimized Session-Based Storage)
function saveToVault(name, immediate = false) {
    if (!currentPdfBytes) return;

    if (name && activeTrip) activeTrip.inv = name;

    if (immediate) {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        performSave(name);
        return;
    }

    // Debounce: Only save once every 2 seconds to prevent UI stutter
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        performSave(name);
    }, 2000);
}

function performSave(name) {
    let saved = [];
    try {
        const raw = localStorage.getItem('vault');
        saved = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(saved)) {
            console.error("Vault is not an array, resetting.");
            saved = [];
        }
    } catch (e) {
        console.warn("Vault recovery: Resetting corrupted or full storage.", e);
        // If storage is corrupted, we must clear it to allow fresh saves
        localStorage.removeItem('vault');
        saved = [];
    }

    let dataToSave = currentPdfBytes;
    if (currentPdfBytes && typeof currentPdfBytes !== 'string') {
        dataToSave = bytesToBase64(new Uint8Array(currentPdfBytes));
    }

    if (!dataToSave || (typeof dataToSave === 'string' && dataToSave.length < 10)) {
        console.error("Vault Save Aborted: Empty or invalid data.");
        return;
    }

    const itemName = name || (activeTrip && activeTrip.inv ? activeTrip.inv : "Daily Load Packet");

    // Check if we already have an entry for this session
    let existingIdx = sessionVaultId ? saved.findIndex(item => item.id === sessionVaultId) : -1;

    const newItem = {
        id: sessionVaultId || Date.now(),
        date: new Date().toLocaleDateString(),
        driver: activeTrip ? activeTrip.driver : "Driver",
        inv: itemName,
        load: activeTrip ? activeTrip.load : "N/A",
        order: activeTrip ? activeTrip.order : "N/A",
        annotations: JSON.parse(JSON.stringify(annotations || [], (key, value) => {
            // FIX: Convert ArrayBuffers in attachments to base64 before stringifying
            if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
                return bytesToBase64(new Uint8Array(value));
            }
            return value;
        })),
        pdfData: dataToSave,
        type: currentDocType || 'application/pdf'
    };

    try {
        if (existingIdx !== -1) {
            saved[existingIdx] = newItem;
        } else {
            sessionVaultId = newItem.id;
            saved.push(newItem);
        }

        localStorage.setItem('vault', JSON.stringify(saved));
        console.log("Vault: Saved/Updated item with ID", newItem.id);

        // Synchronize the custom name with activeTrip for UI consistency
        if (activeTrip) activeTrip.inv = itemName;
    } catch (e) {
        console.error("Vault Save Error:", e);
        // If storage is full, try to remove older items to make room for current work
        if (saved.length > 5) {
            console.warn("Vault Full: Evicting oldest item.");
            saved.shift();
            try { localStorage.setItem('vault', JSON.stringify(saved)); } catch (ee) { }
        }
    }
}

function renderVault() {
    const list = document.getElementById('vault-list');
    let saved = [];
    try {
        saved = JSON.parse(localStorage.getItem('vault')) || [];
    } catch (e) {
        console.warn("Vault Parse Fail:", e);
        saved = [];
    }

    const undoContainer = document.getElementById('vault-undo-container');
    if (undoContainer) undoContainer.innerHTML = '';

    list.innerHTML = '';

    // Add Undo banner if an item was just deleted
    if (lastDeletedVaultItem && undoContainer) {
        const undoBanner = document.createElement('div');
        undoBanner.style.cssText = `
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.2);
            border-radius: 12px;
            padding: 10px 14px;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            animation: slideDown 0.3s ease-out;
        `;
        undoBanner.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; color: #10b981;">
                <i data-lucide="rotate-ccw" style="width: 16px;"></i>
                <span style="font-size: 13px; font-weight: 600;">Recover deleted item?</span>
            </div>
            <button id="btn-undo-vault" style="background: #10b981; color: white; border: none; padding: 6px 14px; border-radius: 8px; font-weight: 800; font-size: 11px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em;">UNDO NOW</button>
        `;
        undoBanner.querySelector('#btn-undo-vault').onclick = (e) => {
            e.stopPropagation();
            if (lastDeletedVaultItem) {
                // Determine insertion point: try to put it back exactly where it was
                const insertionIdx = Math.min(lastDeletedVaultItem.index, saved.length);
                saved.splice(insertionIdx, 0, lastDeletedVaultItem.item);
                localStorage.setItem('vault', JSON.stringify(saved));
                lastDeletedVaultItem = null;
                renderVault();
            }
        };
        undoContainer.appendChild(undoBanner);
    }

    if (saved.length === 0 && !lastDeletedVaultItem) {
        list.innerHTML = '<div style="text-align:center; padding: 3rem 1rem; opacity: 0.5;">' +
            '<i data-lucide="archive" style="width: 48px; height: 48px; margin-bottom: 1rem;"></i>' +
            '<p>Your vault is currently empty.</p></div>';
        if (window.lucide) lucide.createIcons();
        return;
    }

    saved.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'vault-item';
        div.innerHTML = `
            <div class="item-meta">
                <span class="item-driver" style="font-size: 0.7rem; color: var(--accent-blue); font-weight: 800; text-transform: uppercase;">${item.driver}</span>
                <span class="item-inv" style="font-size: 1.1rem;">${item.inv}</span>
                <span class="item-date">${item.date}</span>
            </div>
            <div class="vault-actions">
                <button class="delete-vault-item" style="background:rgba(239, 68, 68, 0.1); border:1px solid rgba(239, 68, 68, 0.2); color:#ef4444; cursor:pointer; padding: 5px 10px; border-radius: 6px; display: flex; align-items: center; gap: 4px;">
                    <i data-lucide="trash-2" style="width: 14px;"></i>
                    <span style="font-size: 10px; font-weight: 700;">DELETE</span>
                </button>
            </div>
        `;
        div.onclick = async (e) => {
            if (e.target.closest('.delete-vault-item')) {
                lastDeletedVaultItem = { index: idx, item: saved[idx] };
                saved.splice(idx, 1);
                localStorage.setItem('vault', JSON.stringify(saved));
                renderVault(); return;
            }
            try {
                console.log("Vault: Loading item", item.inv);
                vaultModal.style.display = 'none';

                // FIX: Restore session state so updates target the same vault entry
                sessionVaultId = item.id;
                activeTrip = activeTrip || { driver: item.driver, startTime: new Date() };
                activeTrip.inv = item.inv;
                activeTrip.load = item.load;
                activeTrip.order = item.order;

                // Show loading indicator
                canvasContainer.innerHTML = `
                    <div style="color: var(--accent-blue); text-align: center; padding: 10rem;">
                        <div class="loader-v" style="border: 4px solid rgba(14, 165, 233, 0.1); border-top: 4px solid #0ea5e9; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 1.5rem;"></div>
                        <p style="font-weight: 600; font-size: 1.1rem; opacity: 0.8;">Restoring ${item.inv}...</p>
                    </div>
                `;

                console.log("Vault: Restoration starting for " + item.inv + ". Data length: " + (item.pdfData ? item.pdfData.length : 0));
                if (item.pdfData && item.pdfData.length > 50) {
                    await loadDocument(item.pdfData, item.type || 'application/pdf');

                    // FIX: Ensure file data in annotations is restored correctly (base64 strings are fine as is)
                    annotations = item.annotations || [];

                    console.log("Vault: Restoration complete, drawing annotations count:", annotations.length);
                    setTimeout(() => drawAnnotations(), 100);
                } else {
                    console.error("Vault: Item has no data", item);
                    throw new Error("This vault entry is corrupt or has no document data.");
                }
            } catch (err) {
                console.error("Vault Restore Fail:", err);
                alert("Could not load from vault: " + err.message);
                resetView();
            }
        };
        list.appendChild(div);
    });
    if (window.lucide) { try { lucide.createIcons(); } catch (e) { } }
}

function openPopup(anno) {
    activeAnno = anno;
    if (popup) {
        popup.style.display = 'block';
        const nameInput = document.getElementById('popup-dot-name');
        if (nameInput) nameInput.value = anno.name || '';
    }
    renderFileList();
}

function renderFileList() {
    const list = document.getElementById('file-list');
    if (!list || !activeAnno || !activeAnno.files) return;
    list.innerHTML = '';
    activeAnno.files.forEach((f, i) => {
        const item = document.createElement('div');
        item.style.cssText = `
            background: rgba(255,255,255,0.05);
            border-radius: 8px;
            padding: 8px;
            display: flex;
            flex-direction: column;
            align-items: center;
            position: relative;
            border: 1px solid rgba(255,255,255,0.1);
        `;

        let previewContent = '';
        if (f.thumbData || (f.type.startsWith('image/') && f.data !== 'placeholder')) {
            const imgSrc = f.thumbData || ((f.data && typeof f.data === 'string' && f.data.startsWith('data:')) ? f.data : `data:${f.type};base64,${f.data}`);
            previewContent = `
                <div style="width: 100%; height: 120px; background: rgba(0,0,0,0.2); border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05);">
                    <img src="${imgSrc}" class="preview-thumb" style="max-width: 100%; max-height: 100%; object-fit: contain; cursor: zoom-in;">
                </div>`;
        } else if (f.type === 'text/plain') {
            let textPreview = "Preview not available";
            if (f.data && typeof f.data === 'string' && f.data.startsWith('data:')) {
                textPreview = atob(f.data.split('base64,')[1]).substring(0, 150) + "...";
            }
            previewContent = `<div class="preview-thumb" style="height: 120px; display: flex; align-items: flex-start; justify-content: flex-start; background: white; color: black; border-radius: 6px; margin-bottom: 6px; cursor: zoom-in; width: 100%; border: 1px solid rgba(255,255,255,0.05); padding: 6px; box-sizing: border-box; font-size: 7px; font-family: monospace; overflow: hidden; white-space: pre-wrap; word-break: break-word;">${textPreview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
        } else {
            const iconSvg = f.type.startsWith('image/')
                ? `<svg viewBox="0 0 24 24" width="32" height="32" stroke="#0ea5e9" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
                : `<svg viewBox="0 0 24 24" width="32" height="32" stroke="#0ea5e9" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
            previewContent = `<div class="preview-thumb" style="height: 120px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 6px; cursor: zoom-in; width: 100%; border: 1px solid rgba(255,255,255,0.05);">${iconSvg}</div>`;
        }

        item.innerHTML = `
            ${previewContent}
            <input type="text" id="file-rename-${i}" name="file-rename-${i}" value="${f.name}" class="file-rename-input" 
                style="font-size: 10px; color: white; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; width: 100%; text-align: center; padding: 2px;">
            <button class="delete-file" style="position: absolute; top: -5px; right: -5px; background: #ef4444; color: white; border: none; border-radius: 50%; width: 18px; height: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">×</button>
        `;

        const input = item.querySelector('.file-rename-input');
        input.onchange = (e) => {
            f.name = e.target.value;
            saveToVault(); // AUTO-SAVE when renaming a file
        };
        input.onclick = (e) => e.stopPropagation();

        item.querySelector('.preview-thumb').onclick = (e) => {
            e.stopPropagation();
            openAttachmentPreview(f);
        };

        item.querySelector('.delete-file').onclick = (e) => {
            e.stopPropagation();
            activeAnno.files.splice(i, 1);
            renderFileList();
            saveToVault(); // AUTO-SAVE after file deletion
        };

        list.appendChild(item);
    });
    if (window.lucide) lucide.createIcons();
}

let currentPreviewFile = null;
async function openAttachmentPreview(file) {
    currentPreviewFile = file;
    const modal = document.getElementById('attachment-preview-modal');
    const body = document.getElementById('preview-body');
    if (!modal || !body) return;

    body.innerHTML = '<div style="color:white; opacity:0.5;">Loading preview...</div>';
    modal.style.display = 'flex';

    if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = (file.data === 'placeholder' || !file.data) ? '' : (file.data.startsWith('data:') ? file.data : `data:${file.type};base64,${file.data}`);
        img.style.cssText = 'max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);';
        body.innerHTML = '';
        body.appendChild(img);
        if (file.data === 'placeholder') body.innerHTML = '<p style="color:white; font-weight:600;">(Demo Scan Placeholder)</p>';
    } else if (file.type === 'application/pdf') {
        try {
            let bytes = file.data;
            if (typeof bytes === 'string') {
                const b64 = bytes.includes('base64,') ? bytes.split('base64,')[1] : bytes;
                bytes = base64ToBytes(b64);
            } else if (bytes instanceof ArrayBuffer) {
                bytes = new Uint8Array(bytes);
            }
            const loadingTask = pdfjsLib.getDocument({ data: bytes });
            const pdf = await loadingTask.promise;
            const page = await pdf.getPage(1);
            const viewport = page.getViewport({ scale: 1.0 });
            const canvas = document.createElement('canvas');
            canvas.height = viewport.height; canvas.width = viewport.width;
            canvas.style.maxWidth = '100%'; canvas.style.height = 'auto';
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            body.innerHTML = '';
            body.appendChild(canvas);
        } catch (e) {
            console.error("Preview PDF fail:", e);
            body.innerHTML = `
                <div style="text-align:center; color:white;">
                    <svg viewBox="0 0 24 24" width="64" height="64" stroke="#ef4444" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:1rem; opacity:0.5;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <p style="font-size:1.1rem; font-weight:600;">Preview Unavailable</p>
                    <p style="opacity:0.6; font-size:0.8rem;">Click EDIT IN MAIN to view and annotate</p>
                </div>
            `;
        }
    } else if (file.type === 'text/plain') {
        let textContent = "Preview not available";
        if (typeof file.data === 'string' && file.data.startsWith('data:')) {
            textContent = atob(file.data.split('base64,')[1]);
        }
        body.innerHTML = `<div style="background:white; color:black; padding:2rem; width:100%; min-height:100%; white-space:pre-wrap; font-family:monospace; box-sizing:border-box; overflow-y:auto;">${textContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
    }
}

// 5. PDF BAKING & SHARING
let shareFormat = 'pdf';
window.setShareFormat = (fmt) => {
    shareFormat = fmt;
    console.log("Share Format Set:", fmt);
    const pdfBtn = document.getElementById('btn-fmt-pdf');
    const imgBtn = document.getElementById('btn-fmt-img');
    if (pdfBtn && imgBtn) {
        pdfBtn.style.background = fmt === 'pdf' ? '#0ea5e9' : 'transparent';
        pdfBtn.style.color = fmt === 'pdf' ? 'white' : 'rgba(255,255,255,0.6)';
        pdfBtn.style.border = fmt === 'pdf' ? 'none' : '1px solid rgba(255,255,255,0.15)';
        imgBtn.style.background = fmt === 'image' ? '#0ea5e9' : 'transparent';
        imgBtn.style.color = fmt === 'image' ? 'white' : 'rgba(255,255,255,0.6)';
        imgBtn.style.border = fmt === 'image' ? 'none' : '1px solid rgba(255,255,255,0.15)';
    }
};

async function bakeFullPacket(asDataUrl = false) {
    console.log("Baking Start... Format:", shareFormat);
    const mainCanvas = canvasContainer.querySelector('canvas');
    if (!mainCanvas) return null;

    // Create a canvas with all physical overlays baked in
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = mainCanvas.width; finalCanvas.height = mainCanvas.height;
    const ctx = finalCanvas.getContext('2d');
    ctx.drawImage(mainCanvas, 0, 0);

    const rect = mainCanvas.getBoundingClientRect();
    const ratioX = mainCanvas.width / rect.width;
    const ratioY = mainCanvas.height / rect.height;

    // BAKE OVERLAYS (Physical marks)
    annotations.forEach(anno => {
        const x = anno.x * mainCanvas.width;
        const y = anno.y * mainCanvas.height;

        if (anno.type === 'stamp') {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-15 * Math.PI / 180);
            const stampText = anno.content;

            const STAMP_COLORS = {
                'PAID': '#f87171',
                'COMPLETED': '#34d399',
                'URGENT': '#fb923c',
                'RECEIVED': '#38bdf8',
                'SEND TO BILLING': '#a78bfa',
                'REFUSED': '#94a3b8',
                'VOID': '#64748b',
                'ON HOLD': '#fbbf24',
                'PICKED UP': '#2dd4bf',
                'IN ROUTE': '#818cf8',
                'DELIVERED': '#f472b6',
                'EXTRA PICK UP': '#fb923c',
                'EXTRA DELIVERY': '#34d399',
                'NO CHARGE': '#f472b6',
                'PARTIAL PAYMENT': '#60a5fa'
            };

            ctx.strokeStyle = STAMP_COLORS[stampText] || '#10b981';
            ctx.lineWidth = 4 * ratioX;
            ctx.strokeRect(-80 * ratioX, -25 * ratioY, 160 * ratioX, 50 * ratioY);
            ctx.font = `bold ${24 * ratioX}px Inter`; ctx.fillStyle = ctx.strokeStyle;
            ctx.textAlign = 'center'; ctx.fillText(stampText, 0, 8 * ratioY);
            ctx.restore();
        } else if (anno.type === 'sign') {
            const img = new Image();
            img.src = anno.content;
            ctx.drawImage(img, x - (75 * ratioX), y - (35 * ratioY), 150 * ratioX, 70 * ratioY);
        } else if (anno.type === 'attach') {
            // Draw a blue circle to represent the attachment point in the PDF
            ctx.beginPath();
            ctx.arc(x, y, 12 * ratioX, 0, Math.PI * 2);
            ctx.fillStyle = '#0ea5e9'; ctx.fill();

            // Draw file count inside the dot for the PDF export
            if (anno.files && anno.files.length > 0) {
                ctx.font = `bold ${10 * ratioX}px Inter`; ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.fillText(anno.files.length.toString(), x, y + (4 * ratioY));
            }

            if (anno.name) {
                ctx.font = `bold ${12 * ratioX}px Inter`; ctx.fillStyle = '#3b82f6';
                ctx.textAlign = 'center';
                ctx.fillText(anno.name.toUpperCase(), x, y + (30 * ratioY));
            }
        } else if (anno.type === 'text') {
            ctx.font = `bold ${20 * ratioX}px Inter`; ctx.fillStyle = '#3b82f6';
            ctx.fillText(anno.content, x, y);
        } else if (anno.type === 'pen') {
            if (!anno.points || anno.points.length < 2) return;
            ctx.strokeStyle = anno.color || '#ef4444';
            ctx.lineWidth = 3 * ratioX;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(anno.points[0].nx * mainCanvas.width, anno.points[0].ny * mainCanvas.height);
            for (let i = 1; i < anno.points.length; i++) {
                ctx.lineTo(anno.points[i].nx * mainCanvas.width, anno.points[i].ny * mainCanvas.height);
            }
            ctx.stroke();
        }
    });

    if (shareFormat === 'image') {
        const segments = [];
        segments.push({ type: 'main', canvas: finalCanvas, height: finalCanvas.height });

        // Pre-calculate segments and images
        for (const a of annotations) {
            if (a.type === 'attach' && a.files && a.files.length > 0) {
                segments.push({ type: 'header', text: `Logistics Documents: ${a.name || 'Group'}`, count: a.files.length });
                for (const f of a.files) {
                    if (f.type.startsWith('image/')) {
                        const img = new Image();
                        img.src = (f.data && f.data.startsWith('data:')) ? f.data : `data:${f.type};base64,${f.data}`;
                        await new Promise(resolve => img.onload = resolve);
                        const scaledH = (finalCanvas.width / img.width) * img.height;
                        segments.push({ type: 'image', img, height: scaledH });
                    } else if (f.type === 'application/pdf') {
                        segments.push({ type: 'pdf-notice', name: f.name });
                    }
                }
            }
        }

        const totalHeight = segments.reduce((sum, s) => {
            if (s.type === 'header') return sum + 100;
            if (s.type === 'pdf-notice') return sum + 80;
            return sum + s.height;
        }, 0);
        const longCanvas = document.createElement('canvas');
        longCanvas.width = finalCanvas.width;
        longCanvas.height = totalHeight;
        const lctx = longCanvas.getContext('2d');
        let currentY = 0;

        for (const s of segments) {
            if (s.type === 'main') {
                lctx.drawImage(s.canvas, 0, currentY);
                currentY += s.height;
            } else if (s.type === 'header') {
                lctx.fillStyle = '#0f172a';
                lctx.fillRect(0, currentY, longCanvas.width, 100);
                lctx.fillStyle = '#0ea5e9';
                lctx.font = `bold ${32}px Inter`;
                lctx.textAlign = 'left';
                lctx.fillText(s.text.toUpperCase(), 40, currentY + 45);
                lctx.fillStyle = 'rgba(255,255,255,0.6)';
                lctx.font = `${20}px Inter`;
                lctx.fillText(`${s.count} Document(s) Attached Below`, 40, currentY + 75);
                currentY += 100;
            } else if (s.type === 'image') {
                lctx.drawImage(s.img, 0, currentY, longCanvas.width, s.height);
                currentY += s.height;
            } else if (s.type === 'pdf-notice') {
                lctx.fillStyle = '#1e293b';
                lctx.fillRect(40, currentY + 10, longCanvas.width - 80, 60);
                lctx.fillStyle = '#94a3b8';
                lctx.font = `italic ${18}px Inter`;
                lctx.textAlign = 'left';
                lctx.fillText(`[PDF Document: ${s.name} - See PDF packet for full content]`, 60, currentY + 45);
                currentY += 80;
            }
        }

        const dataUrl = longCanvas.toDataURL('image/jpeg', 0.85); // Slightly lower quality to save bandwidth on long images
        if (asDataUrl) return dataUrl; // <--- Return string directly if requested
        return await (await fetch(dataUrl)).blob();
    }

    // FULL PDF PACKET BAKING
    if (typeof PDFLib === 'undefined') {
        console.error("CRITICAL ERROR: PDFLib is not loaded!");
        alert("CRITICAL ERROR: PDF Generation Library (PDF-Lib) is missing or failed to load. Please refresh the page. If the issue persists, check your internet connection.");
        return null;
    }
    const masterPdf = await PDFLib.PDFDocument.create();
    const page1Img = await masterPdf.embedJpg(finalCanvas.toDataURL('image/jpeg', 0.95));
    const page1 = masterPdf.addPage([finalCanvas.width, finalCanvas.height]);
    page1.drawImage(page1Img, { x: 0, y: 0, width: finalCanvas.width, height: finalCanvas.height });

    // ATTACHMENTS LOOP (Full Packet)
    const { rgb } = PDFLib;
    for (const a of annotations) {
        if (a.type === 'attach' && a.files && a.files.length > 0) {
            console.log(`Processing attachment group: ${a.name || 'Untitled'}`);

            // Add Section Header Page
            const headerPage = masterPdf.addPage([600, 150]);
            headerPage.drawRectangle({ x: 0, y: 0, width: 600, height: 150, color: rgb(0.06, 0.09, 0.16) });
            headerPage.drawText(`Logistics Documents: ${a.name || 'Group'}`, { x: 40, y: 70, size: 22, color: rgb(0.05, 0.65, 0.9) });
            headerPage.drawText(`${a.files.length} Document(s) Attached`, { x: 40, y: 45, size: 12, color: rgb(1, 1, 1) });

            for (const f of a.files) {
                try {
                    if (f.type === 'application/pdf') {
                        let bytes = f.data;
                        if (typeof bytes === 'string') {
                            if (bytes.includes('base64,')) bytes = bytes.split('base64,')[1];
                            bytes = base64ToBytes(bytes);
                        }
                        const attachmentDoc = await PDFLib.PDFDocument.load(bytes);
                        const copiedPages = await masterPdf.copyPages(attachmentDoc, attachmentDoc.getPageIndices());
                        copiedPages.forEach(p => masterPdf.addPage(p));
                    } else if (f.type.startsWith('image/')) {
                        const isPng = f.type.includes('png') || (typeof f.data === 'string' && f.data.startsWith('data:image/png'));
                        const img = isPng ? await masterPdf.embedPng(f.data) : await masterPdf.embedJpg(f.data);
                        const p = masterPdf.addPage([img.width, img.height]);
                        p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
                    } else if (f.type === 'text/plain') {
                        const text = typeof f.data === 'string' && f.data.includes('base64,') ? atob(f.data.split(',')[1]) : f.data;
                        const p = masterPdf.addPage([600, 800]);
                        const font = await masterPdf.embedFont(PDFLib.StandardFonts.Courier);
                        const lines = text.toString().split('\n');
                        lines.forEach((l, i) => {
                            if (i < 40) { // Safety limit for text pages
                                p.drawText(l, { x: 40, y: 760 - (i * 18), size: 12, font });
                            }
                        });
                    }
                } catch (err) {
                    console.error("Failed to embed attachment:", f.name, err);
                }
            }
        }
    }
    const pdfBytes = await masterPdf.save();
    return new Blob([pdfBytes], { type: 'application/pdf' });
}

window.shareTo = async (method) => {
    try {
        if (!currentPdfBytes) return alert("Please load a document first.");
        const blob = await bakeFullPacket();
        if (!blob) return alert("Failed to generate Packet.");

        const url = URL.createObjectURL(blob);
        const nameInput = document.getElementById('share-packet-name');
        const customBase = nameInput ? nameInput.value.trim() : "";
        const defaultBase = shareFormat === 'pdf' ? "Columbia_Load_Packet" : "Columbia_Quick_Shot";
        const fileName = (customBase || defaultBase).replace(/[^a-z0-9_\-]/gi, '_') + (shareFormat === 'pdf' ? ".pdf" : ".jpg");
        const file = new File([blob], fileName, { type: blob.type });

        const isSecure = (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

        // 1. FORK LOGIC BY METHOD
        if (method === 'download') {
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.click();
            return showToast(`Downloaded: ${fileName}`);
        }

        if (method === 'copy') {
            // OPEN IN NEW TAB (Blob URL for native editing)
            window.open(url, '_blank');
            // ALSO COPY TO CLIPBOARD
            if (navigator.clipboard) {
                await navigator.clipboard.writeText(url).catch(() => { });
                showToast("Blob Link Opened & Copied!");
            } else {
                showToast("Blob Link Opened!");
            }
            return;
        }

        // 2. NATIVE SHARING (For Gmail, SMS, and other apps)
        const canUseNativeShare = navigator.share && navigator.canShare && navigator.canShare({ files: [file] });

        if (isSecure && canUseNativeShare) {
            console.log("Triggering Native Share for: " + method);
            try {
                await navigator.share({
                    files: [file],
                    title: 'Columbia Transport LLC Load Packet',
                    text: `Attached is the ${shareFormat === 'pdf' ? 'PDF Packet' : 'Image'} for ${fileName}.`
                });
                return;
            } catch (e) {
                console.warn("Native Share cancelled or failed:", e);
                if (e.name === 'AbortError') return; // User cancelled
            }
        }

        // 3. FALLBACKS (If native share is missing or failed)
        if (method === 'gmail') {
            alert("To send via Gmail: Please click 'DOWNLOAD' then attach that file to your Gmail app manually.");
        } else if (method === 'sms') {
            alert("To send via SMS: Please click 'DOWNLOAD' then attach that file to your message manually.");
        } else {
            // Final fallback: just download
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            link.click();
        }

    } catch (e) {
        console.error("Share Logic Crash:", e);
        alert("Sharing Error: " + e.message);
    }
};

window.addStamp = (type) => {
    const p = document.getElementById('stamp-picker');
    annotations.push({ type: 'stamp', x: parseFloat(p.dataset.nx), y: parseFloat(p.dataset.ny), content: type, id: Date.now() });
    p.style.display = 'none'; drawAnnotations();
    saveToVault(null, true); // IMMEDIATE SAVE for stamps
};

function openStampPicker(nx, ny) {
    const p = document.getElementById('stamp-picker');
    if (!p) return;
    p.dataset.nx = nx; p.dataset.ny = ny;
    p.style.display = 'block';
}

function openSignatureModal(nx, ny) {
    const m = document.getElementById('sign-modal'); m.style.display = 'flex';
    const c = document.getElementById('sig-canvas'); const ctx = c.getContext('2d');
    c.width = 400; c.height = 200; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    let d = false;

    const getP = (e) => {
        const r = c.getBoundingClientRect();
        // Use clientX for desktop and the touch list for mobile
        const cx = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
        const cy = (e.touches && e.touches.length > 0) ? e.touches[0].clientY : e.clientY;
        const scaleX = c.width / r.width;
        const scaleY = c.height / r.height;
        return { x: (cx - r.left) * scaleX, y: (cy - r.top) * scaleY };
    };

    c.onmousedown = (e) => { d = true; const p = getP(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
    c.onmousemove = (e) => { if (d) { const p = getP(e); ctx.lineTo(p.x, p.y); ctx.stroke(); } };
    c.onmouseup = () => d = false;
    c.onmouseleave = () => d = false;

    // Mobile/Touch Support
    c.ontouchstart = (e) => {
        e.preventDefault();
        d = true;
        const p = getP(e);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
    };
    c.ontouchmove = (e) => {
        if (d) {
            e.preventDefault();
            const p = getP(e);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
        }
    };
    c.ontouchend = () => d = false;

    document.getElementById('btn-save-sig').onclick = () => {
        const dataUrl = c.toDataURL();
        const a = { type: 'sign', x: nx, y: ny, content: dataUrl, id: Date.now() };
        annotations.push(a);
        drawAnnotations();
        saveToVault(null, true); // IMMEDIATE SAVE for signatures
        m.style.display = 'none';
    };
    document.getElementById('close-sign').onclick = () => m.style.display = 'none';
}

function bytesToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    const chunk = 8192;
    for (let i = 0; i < len; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
function base64ToBytes(base64) {
    try {
        const pure = base64.includes('base64,') ? base64.split('base64,')[1] : base64;
        const s = atob(pure);
        const b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        return b;
    } catch (e) {
        console.error("Base64 Error", e);
        throw new Error("Invalid PDF data.");
    }
}

function getMimeByType(file) {
    if (file.type && file.type !== 'application/octet-stream') return file.type;
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) return 'application/pdf';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.txt')) return 'text/plain';
    return 'application/pdf'; // Default
}

// --- GPS TRACKING LOGIC ---
let gpsPingTimer = null;

window.sendGpsPing = async () => {
    if (!activeTrip || !supabaseClient) return;

    if (!navigator.geolocation) {
        console.warn("Geolocation not supported.");
        return;
    }

    navigator.geolocation.getCurrentPosition(async (pos) => {
        const pingData = {
            trip_id: sessionVaultId, // Using session ID for tracking
            driver_name: activeTrip.driver,
            truck_number: activeTrip.truck,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            created_at: new Date().toISOString()
        };

        try {
            // Note: Ensure 'gps_pings' table exists in Supabase
            const { error } = await supabaseClient.from('gps_pings').insert([pingData]);
            if (error) {
                // If table missing, we'll silently fail or log for debug
                if (error.code === 'PGRST116' || error.message.includes('not find')) {
                    console.warn("Supabase: 'gps_pings' table not found. GPS tracking inactive.");
                } else {
                    console.error("GPS Ping Error:", error);
                }
            } else {
                console.log("GPS Ping Sent:", pos.coords.latitude, pos.coords.longitude);
            }
        } catch (e) {
            console.error("GPS Logic Crash:", e);
        }
    }, (err) => {
        console.warn("Geolocation Error:", err.message);
    });

    // Schedule next ping in 60 seconds
    if (gpsPingTimer) clearTimeout(gpsPingTimer);
    gpsPingTimer = setTimeout(window.sendGpsPing, 60000);
};

// --- SUPABASE & BACKEND INTEGRATION ---
// (Initialization handled in initButtons)

async function uploadToSupabase(bytes, fileName, type = 'application/pdf') {
    if (!supabaseClient) return null;
    try {
        const { data, error } = await supabaseClient.storage
            .from('load-packets')
            .upload(`${activeTrip.inv}/${fileName}`, bytes, {
                contentType: type,
                upsert: true
            });
        if (error) throw error;
        const { data: urlData } = supabaseClient.storage.from('load-packets').getPublicUrl(data.path);
        return urlData.publicUrl;
    } catch (e) {
        console.error("Upload error:", e);
        return null;
    }
}

window.submitToOffice = async () => {
    if (!activeTrip || !currentPdfBytes) {
        alert("No active load to submit.");
        return;
    }

    const btn = document.getElementById('btn-share-finish');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" style="width:18px; animation: spin 1s linear infinite;"></i> SUBMITTING...';
    btn.disabled = true;

    try {
        console.log("Submitting to office...");

        const nameInput = document.getElementById('share-packet-name');
        if (nameInput && nameInput.value.trim()) {
            activeTrip.inv = nameInput.value.trim();
        }

        const blob = await bakeFullPacket();
        if (!blob) throw new Error("Could not bake final document.");

        currentPdfBytes = await blob.arrayBuffer();

        let pdfUrl = null;
        if (supabaseClient) {
            pdfUrl = await uploadToSupabase(currentPdfBytes, `final_load_${activeTrip.inv}.pdf`);
        }

        const loadData = {
            invoice_number: activeTrip.inv,
            pdf_url: pdfUrl,
            billed_to: document.getElementById('manual-billed-to')?.value || "Unknown",
            total_amount: parseFloat(document.getElementById('manual-total')?.value) || 0,
            truck_number: activeTrip.truck, // Correct column name from schema
            created_at: new Date().toISOString()
        };

        saveToVault(activeTrip.inv, true);

        if (supabaseClient) {
            // Attempt to insert into 'loads' table
            const { error } = await supabaseClient.from('loads').insert([loadData]);
            if (error) {
                console.error("Supabase Load Insert Error:", error);
                throw new Error(error.message || "Table insertion failed.");
            }

            for (const anno of annotations) {
                if (anno.type === 'attachment' && anno.fileData) {
                    await uploadToSupabase(anno.fileData, `attachment_${anno.id}.bin`, anno.mimeType || 'application/octet-stream');
                }
            }
        }

        alert(supabaseClient ? "Packets successfully submitted to OFFICE CLOUD!" : "Saved to Weekly Vault (Local Only).");
        document.getElementById('share-modal').style.display = 'none';
        resetView();

    } catch (e) {
        console.error("Submission failed:", e);
        alert("Submission failed, but saved to local Vault: " + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
};

// Admin UI Logic (Moved to initButtons)

async function refreshAdminList() {
    const list = document.getElementById('admin-load-list');
    if (!supabaseClient) {
        list.innerHTML = `
            <div style="text-align:center; padding: 3rem 1rem; opacity:0.7;">
                <i data-lucide="info" style="width: 48px; height: 48px; margin-bottom: 1rem; color: #0ea5e9;"></i>
                <h3 style="margin-bottom:0.5rem;">Local Mode Active</h3>
                <p style="font-size: 0.9rem; margin-bottom: 1.5rem;">Connect to <strong>Office Cloud</strong> to view live submissions.</p>
                <div style="background: rgba(255,255,255,0.05); padding: 1rem; border-radius: 12px; font-size: 0.8rem; text-align: left; border: 1px solid rgba(255,255,255,0.1);">
                    <p style="margin-bottom: 0.5rem;"><i data-lucide="check-circle-2" style="width:12px; color:#10b981;"></i> All entries are safely stored in your <strong>Weekly Vault</strong>.</p>
                    <p><i data-lucide="check-circle-2" style="width:12px; color:#10b981;"></i> Use the Search Bar to find specific Invoice #s.</p>
                </div>
            </div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }

    list.innerHTML = '<div style="text-align:center; padding: 2rem;"><i data-lucide="loader-2" style="width:32px; animation: spin 1s linear infinite;"></i> Loading...</div>';
    if (window.lucide) lucide.createIcons();

    try {
        const { data, error } = await supabaseClient
            .from('loads')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (data.length === 0) {
            list.innerHTML = '<p style="text-align:center; opacity:0.5; padding: 2rem;">No submissions found yet.</p>';
            return;
        }

        list.innerHTML = data.map(load => `
            <div class="vault-item glass" style="margin-bottom: 0.5rem; padding: 1.25rem; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.05);">
                <div>
                    <h4 style="margin:0; color: #0ea5e9; font-size: 1.1rem;">${load.invoice_number || 'No BOL#'}</h4>
                    <p style="font-size: 0.75rem; opacity: 0.6; margin: 4px 0;">Billed to: ${load.billed_to || 'N/A'}</p>
                    <p style="font-size: 0.65rem; opacity: 0.4; margin: 0;">Date: ${new Date(load.created_at).toLocaleString()}</p>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <a href="${load.pdf_url}" target="_blank" class="tool-btn" style="height: auto; padding: 0.5rem 1rem; flex-direction: row; gap: 8px; background: rgba(14, 165, 233, 0.1); border: 1px solid rgba(14, 165, 233, 0.2); border-radius: 8px; color: #0ea5e9;">
                        <i data-lucide="external-link" style="width: 14px;"></i> View
                    </a>
                </div>
            </div>
        `).join('');
        if (window.lucide) lucide.createIcons();

    } catch (e) {
        list.innerHTML = `<p style="color:#ef4444; text-align:center; padding: 2rem;">Error: ${e.message}</p>`;
    }
}

// BOOT
// BOOT
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initButtons();
        initEbol();
    });
} else {
    initButtons();
    initEbol();
}

// --- eBOL Scale View Logic ---
function initEbol() {
    const btnEbol = document.getElementById('btn-ebol');
    const closeEbol = document.getElementById('close-ebol');
    const ebolModal = document.getElementById('ebol-modal');
    const ebolIframe = document.getElementById('ebol-iframe');

    if (btnEbol) {
        btnEbol.addEventListener('click', async () => {
            if (!activeTrip || !pdfDoc) {
                alert("No active trip to show eBOL for.");
                return;
            }
            try {
                // Ensure UI reflects saving process
                btnEbol.innerHTML = '<i class="spin" data-lucide="loader-2"></i> Loading...';
                if (window.lucide) lucide.createIcons();

                // Finalize current state into bytes
                const pdfBytes = await finalizePdf();

                // Create object URL
                const blob = new Blob([pdfBytes], { type: 'application/pdf' });
                const url = URL.createObjectURL(blob);

                // Set iframe and show modal
                ebolIframe.src = url;
                ebolModal.style.display = 'flex';

            } catch (err) {
                console.error("eBOL Error:", err);
                alert("Failed to generate scale view: " + err.message);
            } finally {
                btnEbol.innerHTML = '<i data-lucide="file-badge"></i> Scale eBOL';
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    if (closeEbol) {
        closeEbol.addEventListener('click', () => {
            ebolModal.style.display = 'none';
            // Free memory
            if (ebolIframe.src) {
                URL.revokeObjectURL(ebolIframe.src);
                ebolIframe.src = '';
            }
        });
    }
}
// --- UI UTILITIES ---
function showToast(message, duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = `
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'glass';
    toast.style.cssText = `
        padding: 12px 24px;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(14, 165, 233, 0.3);
        color: white;
        font-weight: 600;
        font-size: 14px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
        pointer-events: auto;
        animation: toastSlideUp 0.3s ease-out forwards;
    `;
    toast.innerText = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastSlideDown 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Add CSS animations for toast if not already in style.css
const style = document.createElement('style');
style.textContent = `
    @keyframes toastSlideUp {
        from { transform: translateY(100px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }
    @keyframes toastSlideDown {
        from { transform: translateY(0); opacity: 1; }
        to { transform: translateY(100px); opacity: 0; }
    }
`;
document.head.appendChild(style);

// --- APP INITIALIZATION ---
// (Already initialized via BOOT section above)
// --- Cloud Submission (Supabase) ---
async function submitToOffice() {
    const btn = document.getElementById('btn-share-finish');
    if (!btn || !supabaseClient) return;

    if (!activeTrip) {
        alert("Please start a trip first.");
        return;
    }

    try {
        btn.disabled = true;
        btn.innerHTML = '<i class="spin" data-lucide="refresh-cw"></i> UPLOADING...';
        if (window.lucide) lucide.createIcons();

        // 1. Finalize the PDF
        const pdfBytes = await finalizePdf();
        const fileName = (activeTrip.inv || 'Load') + '_' + Date.now() + '.pdf';

        // 2. Try to upload to Supabase Storage (optional — proceeds even if storage fails)
        let pdfUrl = null;
        try {
            const { data: uploadData, error: uploadError } = await supabaseClient.storage
                .from('attachments')
                .upload(fileName, pdfBytes, { contentType: 'application/pdf', upsert: true });

            if (!uploadError && uploadData) {
                const { data: urlData } = supabaseClient.storage
                    .from('attachments')
                    .getPublicUrl(uploadData.path);
                pdfUrl = urlData?.publicUrl || null;
            } else {
                console.warn('Upload error (non-fatal):', uploadError?.message);
            }
        } catch (storageErr) {
            console.warn('Storage upload skipped:', storageErr.message);
        }

        // 3. Save Record to Supabase Tables (always happens)
        const loadData = {
            trip_id: sessionVaultId,
            driver_name: activeTrip.driver,
            truck_number: activeTrip.truck,
            invoice_number: activeTrip.inv || 'N/A',
            billed_to: activeTrip.driver || 'N/A',
            pdf_url: pdfUrl,
            status: 'submitted',
            created_at: new Date().toISOString()
        };

        const { error: dbError } = await supabaseClient
            .from('loads')
            .insert([loadData]);

        if (dbError) throw dbError;

        btn.style.background = '#22c55e';
        btn.innerHTML = '<i data-lucide="check"></i> SUBMITTED!';
        if (window.lucide) lucide.createIcons();

        setTimeout(() => {
            if (shareModal) shareModal.style.display = 'none';
            btn.disabled = false;
            btn.style.background = '#0ea5e9';
            btn.innerHTML = '<i data-lucide="send"></i> SUBMIT TO OFFICE';
            if (window.lucide) lucide.createIcons();
        }, 2000);

    } catch (err) {
        console.error("Submission Error:", err);
        alert("Failed to submit: " + err.message);
        btn.disabled = false;
        btn.style.background = '#0ea5e9';
        btn.innerHTML = '<i data-lucide="send"></i> SUBMIT TO OFFICE';
        if (window.lucide) lucide.createIcons();
    }
}

async function finalizePdf() {
    // This is a placeholder for the actual PDF preparation logic
    // Usually involves pdf-lib merging annotations
    if (typeof prepareFinalPdfBytes === 'function') {
        return await prepareFinalPdfBytes();
    }
    return currentPdfBytes || new Uint8Array();
}
