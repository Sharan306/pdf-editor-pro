/* ── AI Engine Module ──
   Tesseract.js OCR + Claude API for AI text editing.
   Works via a local proxy server (server.js) to protect the API key.
   Falls back to direct API call if server is not running.
*/
const AI = (() => {
    let worker = null;
    let workerReady = false;
    let lastOCRText = '';
    let lastModalInput = '';
    let applyTarget = null; // { pageNum, x, y, width, height, fabricObj }

    // ── OCR ──

    async function initOCR() {
        if (workerReady) return;
        worker = await Tesseract.createWorker('eng', 1, {
            logger: m => {
                if (m.status === 'recognizing text') {
                    const pct = Math.round(m.progress * 100);
                    const bar = document.getElementById('ocr-bar');
                    if (bar) bar.style.width = pct + '%';
                    const msg = document.getElementById('ocr-msg');
                    if (msg) msg.textContent = `OCR: ${pct}%`;
                }
            }
        });
        workerReady = true;
    }

    async function runOCR() {
        const totalPages = PDFViewer.getTotalPages();
        if (!totalPages) { App.toast('No PDF loaded', 'error'); return; }
        App.openModal('modal-ocr');
        document.getElementById('ocr-bar').style.width = '0%';
        document.getElementById('ocr-msg').textContent = 'Initializing OCR engine…';
        document.getElementById('ocr-result-preview').style.display = 'none';
        document.getElementById('ocr-done-btn').style.display = 'none';

        try {
            await initOCR();
            let allText = '';
            for (let p = 1; p <= totalPages; p++) {
                document.getElementById('ocr-msg').textContent = `OCR: page ${p} of ${totalPages}…`;
                const canvas = PDFViewer.getPageCanvas(p);
                if (!canvas) continue;
                const result = await worker.recognize(canvas);
                allText += `--- Page ${p} ---\n${result.data.text}\n\n`;
                await applyOCROverlay(p, result.data);
            }
            lastOCRText = allText;
            document.getElementById('ocr-msg').textContent = 'OCR complete!';
            document.getElementById('ocr-bar').style.width = '100%';
            document.getElementById('ocr-result-preview').style.display = 'block';
            document.getElementById('ocr-text-out').value = allText;
            document.getElementById('ocr-done-btn').style.display = 'inline-flex';
            App.toast('OCR complete — text is now editable', 'success');
        } catch (e) {
            document.getElementById('ocr-msg').textContent = 'OCR failed: ' + e.message;
            document.getElementById('ocr-done-btn').style.display = 'inline-flex';
            App.toast('OCR error: ' + e.message, 'error');
        }
    }

    async function runOCRCurrentPage() {
        const pageNum = PDFViewer.getCurrentPage();
        if (!pageNum) { App.toast('No PDF loaded', 'error'); return; }
        App.openModal('modal-ocr');
        document.getElementById('ocr-bar').style.width = '0%';
        document.getElementById('ocr-msg').textContent = `OCR: page ${pageNum}…`;
        document.getElementById('ocr-result-preview').style.display = 'none';
        document.getElementById('ocr-done-btn').style.display = 'none';

        try {
            await initOCR();
            const canvas = PDFViewer.getPageCanvas(pageNum);
            if (!canvas) { throw new Error('Page not rendered yet'); }
            const result = await worker.recognize(canvas);
            await applyOCROverlay(pageNum, result.data);
            document.getElementById('ocr-msg').textContent = `OCR page ${pageNum} done!`;
            document.getElementById('ocr-bar').style.width = '100%';
            document.getElementById('ocr-result-preview').style.display = 'block';
            document.getElementById('ocr-text-out').value = result.data.text;
            document.getElementById('ocr-done-btn').style.display = 'inline-flex';
            App.toast(`Page ${pageNum} OCR done — text is now editable`, 'success');
        } catch (e) {
            document.getElementById('ocr-msg').textContent = 'OCR failed: ' + e.message;
            document.getElementById('ocr-done-btn').style.display = 'inline-flex';
            App.toast('OCR error: ' + e.message, 'error');
        }
    }

    async function applyOCROverlay(pageNum, ocrData) {
        const fc = Editor.getCanvas(pageNum);
        if (!fc) return;
        // Scale factor: OCR runs on the raw pixel canvas, Fabric is at CSS px
        const pdfCanvas = PDFViewer.getPageCanvas(pageNum);
        if (!pdfCanvas) return;
        const scaleX = fc.getWidth() / pdfCanvas.width;
        const scaleY = fc.getHeight() / pdfCanvas.height;

        // Word-level overlay for editability
        (ocrData.words || []).forEach(word => {
            if (!word.text.trim()) return;
            const { x0, y0, x1, y1 } = word.bbox;
            const fx = x0 * scaleX;
            const fy = y0 * scaleY;
            const fw = (x1 - x0) * scaleX;
            const fh = (y1 - y0) * scaleY;
            const estFontSize = Math.max(8, fh * 0.75);
            Editor.addOCRText(pageNum, fx, fy, word.text, {
                fontSize: estFontSize,
                width: fw, height: fh
            });
        });
        fc.renderAll();
        // Badge
        const wrapper = document.getElementById(`page-wrapper-${pageNum}`);
        if (wrapper && !wrapper.querySelector('.ocr-badge')) {
            const badge = document.createElement('div');
            badge.className = 'ocr-badge'; badge.textContent = 'OCR';
            wrapper.appendChild(badge);
        }
    }

    // ── Claude API ──

    async function callClaude(prompt) {
        const settings = App.getSettings();
        const model = settings.model || 'claude-haiku-4-5-20251001'; // cheapest model by default
        const userKey = settings.apiKey;

        // Always try the server proxy first — if ANTHROPIC_API_KEY is set on the server,
        // users don't need their own key (shared/hosted mode).
        try {
            const resp = await fetch('/api/claude', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, model, maxTokens: 2048 })
            });
            if (resp.ok) {
                const data = await resp.json();
                return data.content;
            }
            // Server returned an error (e.g. rate limited or no server key)
            const errData = await resp.json().catch(() => ({}));
            if (resp.status === 429) throw new Error('Rate limit reached — try again in a moment.');
            if (resp.status === 400 && errData.error === 'ANTHROPIC_API_KEY env var not set') {
                // Server has no key — fall through to user key below
            } else {
                throw new Error(errData.error || `Server error ${resp.status}`);
            }
        } catch (e) {
            if (e.message !== 'Failed to fetch' && !e.message.includes('ANTHROPIC_API_KEY')) throw e;
            // Proxy unreachable — fall through to direct call
        }

        // Fallback: use the user's own API key (self-hosted / local dev)
        if (!userKey) {
            throw new Error('AI features need an API key. Add yours in ⚙ Settings, or deploy with ANTHROPIC_API_KEY set on the server.');
        }

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': userKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-allow-browser': 'true'
            },
            body: JSON.stringify({
                model,
                max_tokens: 2048,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error?.message || `API error ${resp.status}`);
        }
        const data = await resp.json();
        return data.content[0].text;
    }

    function buildPrompt(action, text, extra) {
        const lang = extra?.lang || 'Spanish';
        const custom = extra?.custom || '';
        const prompts = {
            'rewrite':      `Rewrite the following text to be clearer and more professional. Return only the rewritten text, no explanations:\n\n${text}`,
            'fix-grammar':  `Fix the grammar, spelling, and punctuation in the following text. Return only the corrected text:\n\n${text}`,
            'improve':      `Improve the writing quality of the following text. Make it more engaging and clear. Return only the improved text:\n\n${text}`,
            'shorten':      `Shorten the following text while preserving all key information. Return only the shortened version:\n\n${text}`,
            'expand':       `Expand the following text with more detail and context. Return only the expanded version:\n\n${text}`,
            'formal':       `Rewrite the following text in a formal, professional tone. Return only the rewritten text:\n\n${text}`,
            'casual':       `Rewrite the following text in a friendly, casual tone. Return only the rewritten text:\n\n${text}`,
            'bullet':       `Convert the following text into a concise bulleted list. Return only the bullet points:\n\n${text}`,
            'translate':    `Translate the following text to ${lang}. Return only the translation:\n\n${text}`,
            'summarize':    `Write a concise summary of the following text in 3-5 sentences. Return only the summary:\n\n${text}`,
            'custom':       `${custom}\n\nText:\n${text}`
        };
        return prompts[action] || `Process this text: ${text}`;
    }

    // ── Right-Panel AI ──

    async function processAI() {
        const action = document.getElementById('ai-action').value;
        const text = document.getElementById('ai-input').value.trim();
        const lang = document.getElementById('ai-lang')?.value;
        const custom = document.getElementById('ai-custom')?.value;

        if (!text) { App.toast('Please enter some text first', 'error'); return; }

        document.getElementById('ai-result-box').style.display = 'none';
        document.getElementById('ai-spinner').style.display = 'flex';
        document.getElementById('ai-status').textContent = 'AI thinking…';
        document.getElementById('ai-status').className = 'ai-busy';

        try {
            const prompt = buildPrompt(action, text, { lang, custom });
            const result = await callClaude(prompt);
            document.getElementById('ai-result').value = result;
            document.getElementById('ai-result-box').style.display = 'block';
            App.toast('AI processing done!', 'success');
        } catch (e) {
            App.toast('AI error: ' + e.message, 'error');
        } finally {
            document.getElementById('ai-spinner').style.display = 'none';
            document.getElementById('ai-status').textContent = 'AI Ready';
            document.getElementById('ai-status').className = 'ai-ready';
        }
    }

    function applyResult() {
        const result = document.getElementById('ai-result').value;
        if (!result) return;
        const pageNum = PDFViewer.getCurrentPage();
        const fc = Editor.getCanvas(pageNum);
        if (fc) {
            const t = new fabric.IText(result, {
                left: 50, top: 50, fontSize: 12, fill: '#000', fontFamily: 'Arial'
            });
            fc.add(t); fc.setActiveObject(t); fc.renderAll();
            App.toast('Text added to page', 'success');
        }
    }

    function copyResult() {
        const result = document.getElementById('ai-result').value;
        if (result) { navigator.clipboard.writeText(result); App.toast('Copied!', 'success'); }
    }

    // ── Modal AI ──

    function onModalActionChange() {
        const action = document.getElementById('ai-modal-action').value;
        document.getElementById('ai-modal-lang-row').style.display = action === 'translate' ? 'block' : 'none';
        document.getElementById('ai-modal-custom-row').style.display = action === 'custom' ? 'block' : 'none';
    }

    async function processModalAI() {
        const action = document.getElementById('ai-modal-action').value;
        const text = document.getElementById('ai-modal-input').value.trim();
        const lang = document.getElementById('ai-modal-lang')?.value;
        const custom = document.getElementById('ai-modal-custom')?.value;

        if (action !== 'summarize' && !text) { App.toast('Enter some text', 'error'); return; }

        const inputText = action === 'summarize' && !text ? '(see full document)' : text;

        document.getElementById('ai-modal-result-box').style.display = 'none';
        document.getElementById('ai-modal-spinner').style.display = 'flex';

        try {
            let finalText = inputText;
            // For summarize with no text, grab all text content from PDF
            if (action === 'summarize' && !text) {
                finalText = await getAllPageText();
            }
            const prompt = buildPrompt(action, finalText, { lang, custom });
            const result = await callClaude(prompt);
            document.getElementById('ai-modal-result').value = result;
            document.getElementById('ai-modal-result-box').style.display = 'block';
            App.toast('Done!', 'success');
        } catch (e) {
            App.toast('AI error: ' + e.message, 'error');
        } finally {
            document.getElementById('ai-modal-spinner').style.display = 'none';
        }
    }

    async function getAllPageText() {
        let text = '';
        for (let p = 1; p <= PDFViewer.getTotalPages(); p++) {
            const items = await PDFViewer.extractTextContent(p);
            if (items) text += items.map(i => i.str).join(' ') + '\n\n';
        }
        return text || 'No text content found in PDF.';
    }

    function applyModalResult() {
        const result = document.getElementById('ai-modal-result').value;
        if (!result) return;
        const pageNum = PDFViewer.getCurrentPage();
        const fc = Editor.getCanvas(pageNum);
        if (fc) {
            const t = new fabric.IText(result, {
                left: 50, top: 50, fontSize: 12, fill: '#000', fontFamily: 'Arial'
            });
            fc.add(t); fc.setActiveObject(t); fc.renderAll();
            App.closeModal('modal-ai');
            App.toast('Text added to page', 'success');
        }
    }

    function copyModalResult() {
        const result = document.getElementById('ai-modal-result').value;
        if (result) { navigator.clipboard.writeText(result); App.toast('Copied!', 'success'); }
    }

    // AI edit on right-click selected object
    async function editSelectedWithAI() {
        const fc = Editor.getCanvas(PDFViewer.getCurrentPage());
        const obj = fc?.getActiveObject();
        const text = obj?.text || obj?.toSVG?.() || '';
        if (!text) { App.toast('Select a text object first', 'error'); return; }

        document.getElementById('ai-modal-input').value = text;
        document.getElementById('ai-modal-action').value = 'rewrite';
        onModalActionChange();
        App.openModal('modal-ai');
    }

    // Setup right-panel action/language toggles
    document.addEventListener('DOMContentLoaded', () => {
        const sel = document.getElementById('ai-action');
        if (sel) {
            sel.addEventListener('change', () => {
                const v = sel.value;
                document.getElementById('ai-lang-row').style.display = v === 'translate' ? 'block' : 'none';
                document.getElementById('ai-custom-row').style.display = v === 'custom' ? 'block' : 'none';
            });
        }
    });

    return {
        runOCR, runOCRCurrentPage,
        processAI, applyResult, copyResult,
        processModalAI, applyModalResult, copyModalResult,
        onModalActionChange, editSelectedWithAI
    };
})();
