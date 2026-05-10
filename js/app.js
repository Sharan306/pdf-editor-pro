/* ── App Orchestrator ──
   Coordinates PDFViewer, Editor, and AI modules.
   Handles UI events, modals, drag-drop, keyboard shortcuts, export.
*/
const App = (() => {
    let pdfArrayBuffer = null;
    let currentPage = 1;
    let zoom = 1.0;
    let comments = [];
    let sigCanvas = null, sigCtx = null, sigDrawing = false;
    let sigFont = 'cursive';
    let fileName = '';
    const textOverlaidPages = new Set(); // track pages already overlaid

    const settings = (() => {
        try {
            return JSON.parse(localStorage.getItem('pdfeditor-settings') || '{}');
        } catch { return {}; }
    })();

    // ── Init ──

    function init() {
        setupToolbar();
        setupDragDrop();
        setupKeyboard();
        setupPanelTabs();
        setupSigCanvas();
        updateNavBtns();

        // Populate swatches
        Editor.setFillColor('#000000');
        Editor.setStrokeColor('#000000');
    }

    // ── File Loading ──

    function openFile() {
        document.getElementById('file-input').click();
    }

    function handleFileInput(input) {
        if (input.files[0]) loadPDF(input.files[0]);
    }

    function showEditor() {
        const landing = document.getElementById('landing');
        const editor = document.getElementById('editor');
        landing.style.transition = 'opacity 0.4s ease';
        landing.style.opacity = '0';
        setTimeout(() => {
            landing.style.display = 'none';
            editor.style.display = 'flex';
            editor.style.opacity = '0';
            editor.style.transition = 'opacity 0.4s ease';
            requestAnimationFrame(() => { editor.style.opacity = '1'; });
        }, 400);
    }

    function goToLanding() {
        const landing = document.getElementById('landing');
        const editor = document.getElementById('editor');
        editor.style.transition = 'opacity 0.4s ease';
        editor.style.opacity = '0';
        setTimeout(() => {
            editor.style.display = 'none';
            landing.style.display = 'block';
            landing.style.opacity = '0';
            landing.style.transition = 'opacity 0.4s ease';
            requestAnimationFrame(() => { landing.style.opacity = '1'; });
        }, 400);
    }

    async function loadPDF(file) {
        if (!file || file.type !== 'application/pdf') {
            toast('Please select a valid PDF file', 'error'); return;
        }
        fileName = file.name;
        showLoading('Loading PDF…');

        try {
            pdfArrayBuffer = await file.arrayBuffer();
            const pdfDoc = await PDFViewer.load(pdfArrayBuffer);
            const total = PDFViewer.getTotalPages();

            // Transition to editor if on landing page
            const landing = document.getElementById('landing');
            if (landing && landing.style.display !== 'none' && getComputedStyle(landing).display !== 'none') {
                showEditor();
            }

            document.getElementById('total-pages').textContent = total;
            document.getElementById('sb-file').textContent = fileName;
            const tbFilename = document.getElementById('tb-filename');
            if (tbFilename) tbFilename.textContent = fileName;
            document.getElementById('pages-container').style.display = 'flex';
            document.getElementById('btn-save').disabled = false;

            // Update doc info panel
            const info = await PDFViewer.getPageInfo(1);
            document.getElementById('doc-info').innerHTML =
                `<b>${fileName}</b><br>Pages: ${total}<br>Size: ${(file.size/1024).toFixed(1)} KB<br>Dimensions: ${info.width}×${info.height} pt`;

            // Render all pages (lazy render for large docs)
            const container = document.getElementById('pages-container');
            container.innerHTML = '';

            for (let p = 1; p <= total; p++) {
                const wrapper = createPageWrapper(p);
                container.appendChild(wrapper);
            }

            // Render visible pages
            textOverlaidPages.clear();
            await renderPages();
            await renderAllThumbnails();

            currentPage = 1;
            document.getElementById('page-num').value = 1;
            document.getElementById('page-num').max = total;
            updateNavBtns();

            // Bookmarks
            await loadBookmarks(pdfDoc);

            hideLoading();
            toast(`Loaded "${fileName}" — ${total} page${total>1?'s':''}`, 'success');

            // Auto-extract editable text overlay (Apple Preview style)
            autoExtractText(total);
        } catch (e) {
            hideLoading();
            toast('Error loading PDF: ' + e.message, 'error');
            console.error(e);
        }
    }

    function createPageWrapper(pageNum) {
        const wrapper = document.createElement('div');
        wrapper.id = `page-wrapper-${pageNum}`;
        wrapper.className = 'page-wrapper';
        wrapper.setAttribute('data-page', pageNum);

        // Placeholder size until rendered
        wrapper.style.width = '612px';
        wrapper.style.height = '792px';

        return wrapper;
    }

    async function renderPages() {
        const total = PDFViewer.getTotalPages();
        for (let p = 1; p <= total; p++) {
            const wrapper = document.getElementById(`page-wrapper-${p}`);
            if (!wrapper) continue;
            showLoading(`Rendering page ${p}/${total}…`);
            try {
                const { cssW, cssH } = await PDFViewer.renderPage(p, wrapper);
                Editor.initPage(p, wrapper, cssW, cssH);
                Editor.setTool(Editor.getActiveTool()); // reapply tool to new canvas
            } catch (e) { console.error('Render error page', p, e); }
        }
        hideLoading();
    }

    async function autoExtractText(total) {
        let scannedPages = 0;
        for (let p = 1; p <= total; p++) {
            if (textOverlaidPages.has(p)) continue;
            try {
                const items = await PDFViewer.extractTextContent(p);
                if (items && items.length > 0) {
                    Editor.addPageTextOverlay(p, items);
                    textOverlaidPages.add(p);
                } else {
                    scannedPages++;
                }
            } catch (_) {}
        }
        if (scannedPages > 0) {
            toast(`${scannedPages} page${scannedPages > 1 ? 's look' : ' looks'} scanned — click "OCR" in AI Tools to make text editable`, 'info');
        } else {
            toast('Text fields ready — click any text to edit', 'success');
        }
    }

    async function renderAllThumbnails() {
        const container = document.getElementById('thumbnails');
        container.innerHTML = '';
        const total = PDFViewer.getTotalPages();
        for (let p = 1; p <= total; p++) {
            const item = document.createElement('div');
            item.className = 'thumb-item' + (p === currentPage ? ' active' : '');
            item.setAttribute('data-page', p);
            item.onclick = () => goToPage(p);

            const cv = document.createElement('canvas');
            item.appendChild(cv);
            const lbl = document.createElement('span');
            lbl.textContent = `Page ${p}`;
            item.appendChild(lbl);
            container.appendChild(item);

            // Render thumbnail async
            PDFViewer.renderThumbnail(p, cv).catch(() => {});
        }
    }

    async function loadBookmarks(pdfDoc) {
        try {
            const outline = await pdfDoc.getOutline();
            const container = document.getElementById('bookmarks-list');
            if (!outline || outline.length === 0) {
                container.innerHTML = '<div class="empty-state">No bookmarks</div>';
                return;
            }
            container.innerHTML = '';
            function renderOutline(items, parentEl, depth = 0) {
                items.forEach(item => {
                    const div = document.createElement('div');
                    div.style.paddingLeft = (depth * 12 + 10) + 'px';
                    div.style.padding = '6px 10px 6px ' + (depth * 12 + 10) + 'px';
                    div.style.cursor = 'pointer';
                    div.style.fontSize = '12px';
                    div.style.color = '#ccc';
                    div.textContent = item.title;
                    div.addEventListener('mouseover', () => div.style.background = '#383838');
                    div.addEventListener('mouseout', () => div.style.background = '');
                    parentEl.appendChild(div);
                    if (item.items?.length) renderOutline(item.items, parentEl, depth + 1);
                });
            }
            renderOutline(outline, container);
        } catch (_) {}
    }

    // ── Navigation ──

    function goToPage(n) {
        const total = PDFViewer.getTotalPages();
        if (!total) return;
        n = Math.max(1, Math.min(total, n));
        currentPage = n;
        PDFViewer.setCurrentPage(n);
        Editor.setCurrentPage(n);
        document.getElementById('page-num').value = n;
        updateNavBtns();
        updateThumbActive(n);
        const wrapper = document.getElementById(`page-wrapper-${n}`);
        if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function prevPage() { goToPage(currentPage - 1); }
    function nextPage() { goToPage(currentPage + 1); }

    function updateNavBtns() {
        const total = PDFViewer.getTotalPages();
        document.getElementById('btn-prev').disabled = currentPage <= 1;
        document.getElementById('btn-next').disabled = !total || currentPage >= total;
    }

    function updateThumbActive(n) {
        document.querySelectorAll('.thumb-item').forEach(el => {
            el.classList.toggle('active', +el.dataset.page === n);
        });
    }

    // Intersection observer to track current page while scrolling
    function setupPageObserver() {
        const observer = new IntersectionObserver(entries => {
            entries.forEach(e => {
                if (e.isIntersecting) {
                    const p = +e.target.dataset.page;
                    if (p && p !== currentPage) {
                        currentPage = p;
                        PDFViewer.setCurrentPage(p);
                        Editor.setCurrentPage(p);
                        document.getElementById('page-num').value = p;
                        updateNavBtns();
                        updateThumbActive(p);
                    }
                }
            });
        }, { root: document.getElementById('viewer-wrap'), threshold: 0.3 });

        document.querySelectorAll('.page-wrapper').forEach(el => observer.observe(el));
    }

    // ── Zoom ──

    function setZoom(z) {
        zoom = Math.max(0.25, Math.min(4, z));
        PDFViewer.setZoom(zoom);
        document.getElementById('zoom-pct').textContent = Math.round(zoom * 100) + '%';
        if (PDFViewer.getTotalPages()) renderPages();
    }

    function zoomIn() { setZoom(zoom + 0.1); }
    function zoomOut() { setZoom(Math.max(0.25, zoom - 0.1)); }

    function fitPage() {
        const viewerW = document.getElementById('viewer-wrap').clientWidth - 60;
        const pageW = 612; // default PDF width pt (approx)
        setZoom(viewerW / pageW);
    }

    // ── Drag & Drop ──

    function setupDragDrop() {
        const viewer = document.getElementById('viewer-wrap');
        viewer.addEventListener('dragover', e => {
            e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
            viewer.classList.add('drag-over');
        });
        viewer.addEventListener('dragleave', () => viewer.classList.remove('drag-over'));
        viewer.addEventListener('drop', e => {
            e.preventDefault();
            viewer.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) loadPDF(file);
        });
    }

    // ── Toolbar ──

    function setupToolbar() {
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => {
                Editor.setTool(btn.dataset.tool);
                document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    // ── Keyboard Shortcuts ──

    function setupKeyboard() {
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if ((e.ctrlKey || e.metaKey)) {
                switch (e.key.toLowerCase()) {
                    case 'z': e.preventDefault(); Editor.undo(); break;
                    case 'y': e.preventDefault(); Editor.redo(); break;
                    case 's': e.preventDefault(); downloadFile(); break;
                    case 'o': e.preventDefault(); openFile(); break;
                    case 'c': Editor.copySelected(); break;
                    case 'd': e.preventDefault(); Editor.duplicateSelected(); break;
                    case 'f': e.preventDefault(); openFindReplace(); break;
                    case '=': case '+': e.preventDefault(); zoomIn(); break;
                    case '-': e.preventDefault(); zoomOut(); break;
                }
            } else {
                switch (e.key) {
                    case 'v': case 'V': Editor.setTool('select'); break;
                    case 'h': case 'H': Editor.setTool('hand'); break;
                    case 't': case 'T': Editor.setTool('add-text'); break;
                    case 'p': case 'P': Editor.setTool('pencil'); break;
                    case 'r': case 'R': Editor.setTool('rect'); break;
                    case 'c': case 'C': Editor.setTool('circle'); break;
                    case 'l': case 'L': Editor.setTool('line'); break;
                    case 'e': case 'E': Editor.setTool('eraser'); break;
                    case 'Delete': case 'Backspace': Editor.deleteSelected(); break;
                    case 'ArrowRight': goToPage(currentPage + 1); break;
                    case 'ArrowLeft': goToPage(currentPage - 1); break;
                }
            }
        });
    }

    // ── Panel Tabs ──

    function setupPanelTabs() {
        document.querySelectorAll('.rp-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const panel = tab.closest('#right-panel');
                if (!panel) return;
                panel.querySelectorAll('.rp-tab').forEach(t => t.classList.remove('active'));
                panel.querySelectorAll('.rp-section').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                const target = panel.querySelector(`#rptab-${tab.dataset.rptab}`);
                if (target) target.classList.add('active');
            });
        });
    }

    // ── Page Operations ──

    function rotatePage() {
        toast('Rotation applied visually (re-export to embed)', 'info');
        const wrapper = document.getElementById(`page-wrapper-${currentPage}`);
        if (!wrapper) return;
        const current = parseInt(wrapper.style.transform?.replace('rotate(','')?.replace('deg)','') || '0');
        wrapper.style.transform = `rotate(${(current + 90) % 360}deg)`;
    }

    function deletePage() {
        if (PDFViewer.getTotalPages() <= 1) { toast('Cannot delete last page', 'error'); return; }
        if (!confirm(`Delete page ${currentPage}?`)) return;
        const wrapper = document.getElementById(`page-wrapper-${currentPage}`);
        if (wrapper) wrapper.remove();
        // Update thumbnails
        const thumb = document.querySelector(`.thumb-item[data-page="${currentPage}"]`);
        if (thumb) thumb.remove();
        toast(`Page ${currentPage} deleted (visual only — re-export to save)`, 'info');
    }

    // ── Image Insert ──

    function insertImage() {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                Editor.addImageFromDataURL(currentPage, ev.target.result);
                toast('Image added to page', 'success');
            };
            reader.readAsDataURL(file);
        };
        input.click();
    }

    // ── Watermark ──

    function openWatermark() { openModal('modal-watermark'); }

    function applyWatermark() {
        const text = document.getElementById('wm-text').value;
        const color = document.getElementById('wm-color').value;
        const opacity = +document.getElementById('wm-opacity').value;
        const size = +document.getElementById('wm-size').value;
        const allPages = document.getElementById('wm-all').checked;

        const pages = allPages ? Array.from({length: PDFViewer.getTotalPages()}, (_,i) => i+1) : [currentPage];
        pages.forEach(p => Editor.addWatermark(p, text, color, opacity, size));
        closeModal('modal-watermark');
        toast(`Watermark applied to ${pages.length} page(s)`, 'success');
    }

    // ── Find & Replace ──

    function openFindReplace() { openModal('modal-findreplace'); }

    function findNext() {
        const q = document.getElementById('find-text').value;
        toast(`Find next: "${q}" (full text search coming soon)`, 'info');
    }

    function replaceCurrent() {
        const q = document.getElementById('find-text').value;
        const r = document.getElementById('replace-text').value;
        if (!q) { toast('Enter text to find', 'error'); return; }
        toast(`Replace "${q}" → "${r}" on current page`, 'info');
    }

    function replaceAll() {
        const q = document.getElementById('find-text').value;
        const r = document.getElementById('replace-text').value;
        if (!q) { toast('Enter text to find', 'error'); return; }
        // Replace in all Fabric text objects across all pages
        let count = 0;
        for (let p = 1; p <= PDFViewer.getTotalPages(); p++) {
            const fc = Editor.getCanvas(p);
            if (!fc) continue;
            fc.getObjects().forEach(obj => {
                if (obj.type === 'i-text' || obj.type === 'text') {
                    if (obj.text.includes(q)) {
                        obj.set('text', obj.text.split(q).join(r));
                        count++;
                    }
                }
            });
            fc.renderAll();
        }
        closeModal('modal-findreplace');
        toast(`Replaced ${count} instance(s)`, 'success');
    }

    // ── Signature ──

    function openSignature() { openModal('modal-signature'); }

    function setupSigCanvas() {
        sigCanvas = document.getElementById('sig-canvas');
        sigCtx = sigCanvas.getContext('2d');
        sigCtx.lineCap = 'round'; sigCtx.lineJoin = 'round';

        sigCanvas.addEventListener('mousedown', e => {
            sigDrawing = true;
            sigCtx.beginPath();
            const r = sigCanvas.getBoundingClientRect();
            sigCtx.moveTo(e.clientX - r.left, e.clientY - r.top);
        });
        sigCanvas.addEventListener('mousemove', e => {
            if (!sigDrawing) return;
            const r = sigCanvas.getBoundingClientRect();
            sigCtx.lineWidth = +document.getElementById('sig-thick').value;
            sigCtx.strokeStyle = document.getElementById('sig-color').value;
            sigCtx.lineTo(e.clientX - r.left, e.clientY - r.top);
            sigCtx.stroke();
        });
        sigCanvas.addEventListener('mouseup', () => sigDrawing = false);
        sigCanvas.addEventListener('mouseleave', () => sigDrawing = false);

        // Touch support
        sigCanvas.addEventListener('touchstart', e => {
            e.preventDefault();
            const t = e.touches[0];
            const r = sigCanvas.getBoundingClientRect();
            sigDrawing = true;
            sigCtx.beginPath();
            sigCtx.moveTo(t.clientX - r.left, t.clientY - r.top);
        }, { passive: false });
        sigCanvas.addEventListener('touchmove', e => {
            e.preventDefault();
            if (!sigDrawing) return;
            const t = e.touches[0];
            const r = sigCanvas.getBoundingClientRect();
            sigCtx.lineWidth = +document.getElementById('sig-thick').value;
            sigCtx.strokeStyle = document.getElementById('sig-color').value;
            sigCtx.lineTo(t.clientX - r.left, t.clientY - r.top);
            sigCtx.stroke();
        }, { passive: false });
        sigCanvas.addEventListener('touchend', () => sigDrawing = false);

        // Signature tabs
        document.querySelectorAll('.sig-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.sig-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.sig-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('sig-' + tab.dataset.sig).classList.add('active');
            });
        });

        // Signature font buttons
        document.querySelectorAll('.sfont-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.sfont-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                sigFont = btn.dataset.font;
                const input = document.getElementById('sig-type-text');
                input.style.fontFamily = sigFont;
            });
        });
    }

    function clearSig() {
        sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
    }

    function previewSigImage(input) {
        const file = input.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            const img = document.getElementById('sig-preview');
            img.src = e.target.result; img.style.display = 'block';
        };
        reader.readAsDataURL(file);
    }

    function applySig() {
        const activeTab = document.querySelector('.sig-tab.active')?.dataset.sig;
        let dataURL = null;

        if (activeTab === 'draw') {
            // Check if anything was drawn
            const blank = document.createElement('canvas');
            blank.width = sigCanvas.width; blank.height = sigCanvas.height;
            if (sigCanvas.toDataURL() === blank.toDataURL()) {
                toast('Please draw a signature first', 'error'); return;
            }
            dataURL = sigCanvas.toDataURL();
        } else if (activeTab === 'type') {
            const text = document.getElementById('sig-type-text').value.trim();
            if (!text) { toast('Please type a signature', 'error'); return; }
            // Render typed signature to canvas
            const tc = document.createElement('canvas');
            tc.width = 400; tc.height = 100;
            const ctx = tc.getContext('2d');
            ctx.font = `48px ${sigFont}`;
            ctx.fillStyle = document.getElementById('sig-color').value;
            ctx.fillText(text, 10, 70);
            dataURL = tc.toDataURL();
        } else if (activeTab === 'upload') {
            const img = document.getElementById('sig-preview');
            if (!img.src || img.style.display === 'none') {
                toast('Please upload a signature image', 'error'); return;
            }
            dataURL = img.src;
        }

        if (dataURL) {
            Editor.addImageFromDataURL(currentPage, dataURL, 100, 100);
            closeModal('modal-signature');
            toast('Signature placed — drag to position', 'success');
        }
    }

    // ── AI Modal ──

    function openAI(action) {
        const sel = document.getElementById('ai-modal-action');
        if (action && sel) sel.value = action;
        AI.onModalActionChange();
        document.getElementById('ai-modal-result-box').style.display = 'none';
        document.getElementById('ai-modal-spinner').style.display = 'none';
        openModal('modal-ai');
    }

    // ── Settings ──

    function openSettings() {
        document.getElementById('def-zoom').value = settings.defaultZoom || 1;
        document.getElementById('auto-ocr').checked = !!settings.autoOCR;
        openModal('modal-settings');
    }

    function saveSettings() {
        settings.defaultZoom = +document.getElementById('def-zoom').value;
        settings.autoOCR = document.getElementById('auto-ocr').checked;
        localStorage.setItem('pdfeditor-settings', JSON.stringify(settings));
        closeModal('modal-settings');
        toast('Settings saved', 'success');
    }

    function getSettings() { return settings; }

    // ── Export / Download ──

    async function downloadFile() {
        if (!pdfArrayBuffer) { toast('No PDF loaded', 'error'); return; }
        showLoading('Preparing PDF…');
        try {
            const { PDFDocument, rgb, degrees } = PDFLib;
            const pdfDoc = await PDFDocument.load(pdfArrayBuffer);
            const pages = pdfDoc.getPages();

            for (let p = 1; p <= PDFViewer.getTotalPages(); p++) {
                const pdfCanvas = PDFViewer.getPageCanvas(p);
                const merged = await Editor.exportPageImage(p, pdfCanvas);
                if (!merged) continue;

                // Only embed overlay if Fabric canvas has objects
                const fc = Editor.getCanvas(p);
                if (!fc || fc.getObjects().length === 0) continue;

                // Get Fabric overlay as PNG (transparent bg)
                const overlayDataURL = fc.toDataURL({ format: 'png', multiplier: window.devicePixelRatio || 1 });
                const overlayBytes = await fetch(overlayDataURL).then(r => r.arrayBuffer());
                const embeddedImg = await pdfDoc.embedPng(overlayBytes);

                const page = pages[p - 1];
                const { width, height } = page.getSize();
                // Draw overlay at full page size
                page.drawImage(embeddedImg, { x: 0, y: 0, width, height });
            }

            const pdfBytes = await pdfDoc.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName.replace('.pdf', '-edited.pdf');
            a.click();
            URL.revokeObjectURL(url);
            hideLoading();
            toast('PDF downloaded!', 'success');
        } catch (e) {
            hideLoading();
            toast('Export error: ' + e.message, 'error');
            console.error(e);
        }
    }

    // ── Comments ──

    function addComment(c) {
        comments.push({ ...c, id: Date.now() });
        renderComments();
    }

    function renderComments() {
        const list = document.getElementById('comments-list');
        if (!comments.length) { list.innerHTML = '<div class="empty-state">No comments</div>'; return; }
        list.innerHTML = '';
        comments.forEach(c => {
            const div = document.createElement('div');
            div.style.cssText = 'padding:8px 10px;border-bottom:1px solid #333;font-size:12px;color:#ccc';
            div.textContent = `Page ${c.page}: ${c.text}`;
            list.appendChild(div);
        });
    }

    // ── Context Menu ──

    function showCtxMenu(x, y) {
        const menu = document.getElementById('ctx-menu');
        menu.style.display = 'block';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        document.addEventListener('click', hideCtxMenu, { once: true });
    }

    function hideCtxMenu() {
        document.getElementById('ctx-menu').style.display = 'none';
    }

    // ── Modals ──

    function openModal(id) {
        document.getElementById(id).style.display = 'flex';
    }

    function closeModal(id) {
        document.getElementById(id).style.display = 'none';
    }

    function closeModalBg(e, id) {
        if (e.target === e.currentTarget) closeModal(id);
    }

    // ── Loading ──

    function showLoading(msg = 'Processing…') {
        document.getElementById('loading').style.display = 'flex';
        document.getElementById('loading-msg').textContent = msg;
    }

    function hideLoading() {
        document.getElementById('loading').style.display = 'none';
    }

    // ── Toast ──

    function toast(msg, type = 'info') {
        const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };
        const container = document.getElementById('toasts');
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `<i class="fa ${icons[type] || icons.info}"></i><span>${msg}</span>`;
        container.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3000);
    }


    // ── DOM Ready ──

    document.addEventListener('DOMContentLoaded', () => {
        init();
        // Apply default zoom from settings
        if (settings.defaultZoom) setZoom(+settings.defaultZoom);
        // Auto-open right-panel AI tab if user navigates to it
        document.addEventListener('click', hideCtxMenu);
    });

    return {
        openFile, handleFileInput, loadPDF,
        goToLanding,
        goToPage, prevPage, nextPage,
        setZoom, zoomIn, zoomOut, fitPage,
        rotatePage, deletePage, insertImage,
        openWatermark, applyWatermark,
        openFindReplace, findNext, replaceCurrent, replaceAll,
        openSignature, clearSig, previewSigImage, applySig,
        openAI,
        openSettings, saveSettings, getSettings,
        downloadFile,
        addComment,
        showCtxMenu, hideCtxMenu,
        openModal, closeModal, closeModalBg,
        showLoading, hideLoading,
        toast
    };
})();
