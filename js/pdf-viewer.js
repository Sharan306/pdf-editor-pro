/* ── PDF Viewer Module ──
   Wraps PDF.js. Renders pages to canvas elements and provides
   page navigation, zoom, and text-layer extraction.
*/
const PDFViewer = (() => {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    let pdfDoc = null;
    let zoom = 1.0;
    let currentPage = 1;
    let totalPages = 0;
    const pageCanvases = {};   // pageNum → { pdfCanvas, containerEl }
    const renderTasks = {};    // pageNum → renderTask (to cancel stale renders)

    async function load(arrayBuffer) {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;
        currentPage = 1;
        return pdfDoc;
    }

    async function renderPage(pageNum, containerEl) {
        if (!pdfDoc) return;
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: zoom * window.devicePixelRatio });
        const cssW = page.getViewport({ scale: zoom }).width;
        const cssH = page.getViewport({ scale: zoom }).height;

        // Create or reuse PDF canvas
        let pdfCanvas = containerEl.querySelector('.pdf-canvas');
        if (!pdfCanvas) {
            pdfCanvas = document.createElement('canvas');
            pdfCanvas.className = 'pdf-canvas';
            containerEl.appendChild(pdfCanvas);
        }
        pdfCanvas.width = viewport.width;
        pdfCanvas.height = viewport.height;
        pdfCanvas.style.width = cssW + 'px';
        pdfCanvas.style.height = cssH + 'px';

        // Size the wrapper
        containerEl.style.width = cssW + 'px';
        containerEl.style.height = cssH + 'px';

        // Cancel any prior render of this page
        if (renderTasks[pageNum]) {
            try { renderTasks[pageNum].cancel(); } catch (_) {}
        }

        const ctx = pdfCanvas.getContext('2d');
        const renderTask = page.render({
            canvasContext: ctx,
            viewport: viewport
        });
        renderTasks[pageNum] = renderTask;

        try {
            await renderTask.promise;
        } catch (e) {
            if (e.name !== 'RenderingCancelledException') throw e;
        }

        pageCanvases[pageNum] = { pdfCanvas, containerEl };
        return { cssW, cssH };
    }

    async function renderThumbnail(pageNum, targetCanvas, thumbWidth = 140) {
        if (!pdfDoc) return;
        const page = await pdfDoc.getPage(pageNum);
        const nativeVP = page.getViewport({ scale: 1 });
        const scale = thumbWidth / nativeVP.width;
        const vp = page.getViewport({ scale });
        targetCanvas.width = vp.width;
        targetCanvas.height = vp.height;
        const ctx = targetCanvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }

    async function extractTextContent(pageNum) {
        if (!pdfDoc) return null;
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();
        const vp = page.getViewport({ scale: zoom });
        const items = textContent.items.map(item => {
            const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
            return {
                str: item.str,
                x: tx[4],
                y: tx[5] - item.height,
                width: item.width * zoom,
                height: item.height,
                fontSize: Math.abs(tx[0]) || item.height
            };
        }).filter(i => i.str.trim().length > 0);
        return items;
    }

    async function getPageInfo(pageNum) {
        if (!pdfDoc) return null;
        const page = await pdfDoc.getPage(pageNum);
        const vp = page.getViewport({ scale: 1 });
        return {
            width: Math.round(vp.width),
            height: Math.round(vp.height),
            rotation: page.rotate,
            pageNum,
            totalPages
        };
    }

    function setZoom(z) { zoom = Math.max(0.25, Math.min(4, z)); }
    function getZoom() { return zoom; }
    function getDoc() { return pdfDoc; }
    function getTotalPages() { return totalPages; }
    function getCurrentPage() { return currentPage; }
    function setCurrentPage(n) { currentPage = Math.max(1, Math.min(totalPages, n)); }

    // Get the raw pixel canvas for a rendered page (for OCR / export)
    function getPageCanvas(pageNum) {
        return pageCanvases[pageNum]?.pdfCanvas || null;
    }

    return {
        load, renderPage, renderThumbnail,
        extractTextContent, getPageInfo,
        setZoom, getZoom,
        getDoc, getTotalPages, getCurrentPage, setCurrentPage,
        getPageCanvas
    };
})();
