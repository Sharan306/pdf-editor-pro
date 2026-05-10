/* ── Editor Module ──
   Manages Fabric.js canvases overlaid on PDF pages.
   Handles all drawing tools, text, shapes, annotations.
*/
const Editor = (() => {
    const canvases = {};           // pageNum → fabric.Canvas
    const history = {};            // pageNum → { stack:[], pos }
    let activeTool = 'select';
    let fillColor = '#000000';
    let strokeColor = '#000000';
    let fontSize = 12;
    let strokeWidth = 2;
    let currentPageNum = 1;
    let clipboard = null;
    let isDrawingShape = false;
    let shapeStart = null;
    let activeShape = null;
    let onSelectionCb = null;

    // ── Init ──

    function initPage(pageNum, containerEl, cssW, cssH) {
        if (canvases[pageNum]) {
            // Resize existing canvas if zoom changed
            const fc = canvases[pageNum];
            fc.setWidth(cssW);
            fc.setHeight(cssH);
            fc.renderAll();
            return fc;
        }

        const canvasEl = document.createElement('canvas');
        canvasEl.className = 'edit-canvas-el';
        canvasEl.id = `edit-canvas-${pageNum}`;
        containerEl.appendChild(canvasEl);

        const fc = new fabric.Canvas(canvasEl, {
            width: cssW, height: cssH,
            selection: true,
            preserveObjectStacking: true
        });

        // Intercept context menu
        fc.wrapperEl.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (fc.getActiveObject()) App.showCtxMenu(e.clientX, e.clientY);
        });

        fc.on('object:added', () => { pushHistory(pageNum); notifyChange(); });
        fc.on('object:modified', () => { pushHistory(pageNum); notifyChange(); });
        fc.on('object:removed', () => { pushHistory(pageNum); notifyChange(); });
        fc.on('selection:created', e => onSelection(pageNum, e));
        fc.on('selection:updated', e => onSelection(pageNum, e));
        fc.on('selection:cleared', () => clearSelection());

        canvases[pageNum] = fc;
        history[pageNum] = { stack: [fc.toJSON()], pos: 0 };
        return fc;
    }

    function notifyChange() {
        // Signal unsaved changes
        const saveBtn = document.getElementById('btn-save');
        if (saveBtn) saveBtn.disabled = false;
    }

    // ── Tool Switching ──

    function setTool(tool) {
        activeTool = tool;
        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
            b.classList.toggle('active', b.dataset.tool === tool);
        });
        document.getElementById('sb-tool').textContent = 'Tool: ' + toolLabel(tool);

        // Apply tool state to all canvases
        Object.values(canvases).forEach(fc => applyToolToCanvas(fc, tool));
    }

    function toolLabel(t) {
        const m = {
            select:'Select', hand:'Pan', 'add-text':'Add Text', pencil:'Draw',
            rect:'Rectangle', circle:'Circle', line:'Line', arrow:'Arrow',
            highlight:'Highlight', underline:'Underline', strikethrough:'Strikethrough',
            sticky:'Sticky Note', redact:'Redact', eraser:'Eraser',
            'form-text':'Text Field', 'form-check':'Checkbox', 'form-radio':'Radio',
            sign:'Signature', 'stamp-approved':'Stamp'
        };
        return m[t] || t;
    }

    function applyToolToCanvas(fc, tool) {
        fc.off('mouse:down');
        fc.off('mouse:move');
        fc.off('mouse:up');
        fc.isDrawingMode = false;
        fc.selection = true;
        fc.defaultCursor = 'default';

        switch (tool) {
            case 'select':
                fc.selection = true;
                break;
            case 'hand':
                fc.selection = false;
                fc.defaultCursor = 'grab';
                setupPan(fc);
                break;
            case 'pencil':
                fc.isDrawingMode = true;
                fc.freeDrawingBrush.color = fillColor;
                fc.freeDrawingBrush.width = strokeWidth;
                break;
            case 'eraser':
                fc.isDrawingMode = true;
                fc.freeDrawingBrush = new fabric.PencilBrush(fc);
                fc.freeDrawingBrush.color = '#ffffff';
                fc.freeDrawingBrush.width = strokeWidth * 4;
                break;
            case 'add-text':
                fc.selection = false;
                fc.defaultCursor = 'text';
                fc.on('mouse:down', opt => addTextAt(fc, opt));
                break;
            case 'sticky':
                fc.selection = false;
                fc.defaultCursor = 'cell';
                fc.on('mouse:down', opt => addStickyNote(fc, opt));
                break;
            case 'highlight':
            case 'underline':
            case 'strikethrough':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                setupAnnotationDraw(fc, tool);
                break;
            case 'redact':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                setupRectDraw(fc, { fill: '#000000', stroke: null, opacity: 1, tag: 'redact' });
                break;
            case 'rect':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                setupRectDraw(fc, { fill: 'transparent', stroke: strokeColor });
                break;
            case 'circle':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                setupCircleDraw(fc);
                break;
            case 'line':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                setupLineDraw(fc, false);
                break;
            case 'arrow':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                setupLineDraw(fc, true);
                break;
            case 'form-text':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                setupFormField(fc, 'text');
                break;
            case 'form-check':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                fc.on('mouse:down', opt => addCheckbox(fc, opt));
                break;
            case 'form-radio':
                fc.selection = false;
                fc.defaultCursor = 'crosshair';
                fc.on('mouse:down', opt => addRadio(fc, opt));
                break;
            case 'stamp-approved':
                fc.selection = false;
                fc.defaultCursor = 'cell';
                fc.on('mouse:down', opt => addStamp(fc, opt, 'APPROVED'));
                break;
        }
    }

    // ── Pan ──
    function setupPan(fc) {
        let isPanning = false, lastX, lastY;
        fc.on('mouse:down', opt => {
            isPanning = true; lastX = opt.e.clientX; lastY = opt.e.clientY;
            fc.defaultCursor = 'grabbing';
        });
        fc.on('mouse:move', opt => {
            if (!isPanning) return;
            const dx = opt.e.clientX - lastX, dy = opt.e.clientY - lastY;
            const vpt = fc.viewportTransform;
            vpt[4] += dx; vpt[5] += dy;
            fc.requestRenderAll();
            lastX = opt.e.clientX; lastY = opt.e.clientY;
        });
        fc.on('mouse:up', () => { isPanning = false; fc.defaultCursor = 'grab'; });
    }

    // ── Text ──
    function addTextAt(fc, opt) {
        const p = fc.getPointer(opt.e);
        const t = new fabric.IText('Type here…', {
            left: p.x, top: p.y,
            fontSize, fill: fillColor,
            fontFamily: 'Arial',
            editable: true
        });
        fc.add(t);
        fc.setActiveObject(t);
        t.enterEditing();
        t.selectAll();
        setTool('select'); // return to select after placing
    }

    function addTextObject(fc, x, y, text, opts = {}) {
        const t = new fabric.IText(text, {
            left: x, top: y,
            fontSize: opts.fontSize || fontSize,
            fill: opts.fill || fillColor,
            fontFamily: opts.fontFamily || 'Arial',
            ...opts
        });
        fc.add(t);
        return t;
    }

    // ── Sticky Note ──
    function addStickyNote(fc, opt) {
        const p = fc.getPointer(opt.e);
        const bg = new fabric.Rect({ width: 160, height: 110, fill: '#fffaa0', rx: 4, ry: 4, shadow: '2px 2px 6px rgba(0,0,0,0.25)' });
        const txt = new fabric.IText('Note…', { fontSize: 11, fill: '#333', top: 8, left: 8, width: 144 });
        const grp = new fabric.Group([bg, txt], { left: p.x, top: p.y, subTargetCheck: true });
        fc.add(grp);
        setTool('select');
        // Track as comment
        App.addComment({ page: currentPageNum, text: 'Sticky note', x: p.x, y: p.y });
    }

    // ── Annotations (highlight/underline/strikethrough) ──
    function setupAnnotationDraw(fc, type) {
        let start = null;
        fc.on('mouse:down', opt => { start = fc.getPointer(opt.e); });
        fc.on('mouse:up', opt => {
            if (!start) return;
            const end = fc.getPointer(opt.e);
            const x = Math.min(start.x, end.x);
            const y = Math.min(start.y, end.y);
            const w = Math.abs(end.x - start.x) || 100;
            const h = Math.abs(end.y - start.y) || 14;
            let obj;
            if (type === 'highlight') {
                obj = new fabric.Rect({ left: x, top: y, width: w, height: h || 14, fill: '#ffff00', opacity: 0.4, selectable: true });
            } else if (type === 'underline') {
                obj = new fabric.Line([x, y+h, x+w, y+h], { stroke: '#0000ff', strokeWidth: 2 });
            } else {
                const midY = y + h/2;
                obj = new fabric.Line([x, midY, x+w, midY], { stroke: '#ff0000', strokeWidth: 2 });
            }
            fc.add(obj);
            start = null;
        });
    }

    // ── Rectangle ──
    function setupRectDraw(fc, opts = {}) {
        let start = null, rect = null;
        fc.on('mouse:down', opt => {
            start = fc.getPointer(opt.e);
            rect = new fabric.Rect({
                left: start.x, top: start.y, width: 0, height: 0,
                fill: opts.fill !== undefined ? opts.fill : 'transparent',
                stroke: opts.stroke || strokeColor,
                strokeWidth: opts.stroke === null ? 0 : strokeWidth,
                opacity: opts.opacity !== undefined ? opts.opacity : 1,
                selectable: false,
                data: { tag: opts.tag }
            });
            fc.add(rect);
        });
        fc.on('mouse:move', opt => {
            if (!start || !rect) return;
            const p = fc.getPointer(opt.e);
            rect.set({ width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y), left: Math.min(p.x, start.x), top: Math.min(p.y, start.y) });
            fc.renderAll();
        });
        fc.on('mouse:up', () => {
            if (rect) { rect.selectable = true; fc.setActiveObject(rect); }
            start = null; rect = null;
        });
    }

    // ── Circle ──
    function setupCircleDraw(fc) {
        let start = null, circ = null;
        fc.on('mouse:down', opt => {
            start = fc.getPointer(opt.e);
            circ = new fabric.Ellipse({ left: start.x, top: start.y, rx: 0, ry: 0, fill: 'transparent', stroke: strokeColor, strokeWidth, selectable: false });
            fc.add(circ);
        });
        fc.on('mouse:move', opt => {
            if (!start || !circ) return;
            const p = fc.getPointer(opt.e);
            circ.set({ rx: Math.abs(p.x - start.x)/2, ry: Math.abs(p.y - start.y)/2, left: Math.min(p.x, start.x), top: Math.min(p.y, start.y) });
            fc.renderAll();
        });
        fc.on('mouse:up', () => { if (circ) { circ.selectable = true; fc.setActiveObject(circ); } start=null; circ=null; });
    }

    // ── Line / Arrow ──
    function setupLineDraw(fc, isArrow) {
        let start = null, lineObj = null;
        fc.on('mouse:down', opt => {
            start = fc.getPointer(opt.e);
            lineObj = new fabric.Line([start.x, start.y, start.x, start.y], { stroke: strokeColor, strokeWidth, selectable: false });
            fc.add(lineObj);
        });
        fc.on('mouse:move', opt => {
            if (!start || !lineObj) return;
            const p = fc.getPointer(opt.e);
            lineObj.set({ x2: p.x, y2: p.y });
            fc.renderAll();
        });
        fc.on('mouse:up', opt => {
            if (!lineObj) return;
            lineObj.selectable = true;
            if (isArrow) addArrowHead(fc, lineObj);
            start = null; lineObj = null;
        });
    }

    function addArrowHead(fc, line) {
        const angle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1) * 180 / Math.PI;
        const head = new fabric.Triangle({
            left: line.x2, top: line.y2,
            width: 14, height: 14,
            fill: strokeColor,
            angle: angle + 90,
            originX: 'center', originY: 'center',
            selectable: false
        });
        const grp = new fabric.Group([line, head]);
        fc.remove(line);
        fc.add(grp);
    }

    // ── Form Fields ──
    function setupFormField(fc, type) {
        let start = null, rect = null;
        fc.on('mouse:down', opt => {
            start = fc.getPointer(opt.e);
            rect = new fabric.Rect({ left: start.x, top: start.y, width: 0, height: 0, fill: 'rgba(173,216,230,0.3)', stroke: '#0078d4', strokeWidth: 1, strokeDashArray: [4,3], selectable: false });
            fc.add(rect);
        });
        fc.on('mouse:move', opt => {
            if (!start || !rect) return;
            const p = fc.getPointer(opt.e);
            rect.set({ width: Math.abs(p.x-start.x), height: Math.abs(p.y-start.y), left: Math.min(p.x,start.x), top: Math.min(p.y,start.y) });
            fc.renderAll();
        });
        fc.on('mouse:up', opt => {
            if (!rect) return;
            const w = rect.width || 120, h = rect.height || 24;
            fc.remove(rect);
            const t = new fabric.IText('', {
                left: rect.left, top: rect.top, width: w,
                fontSize: 12, fill: '#000', fontFamily: 'Arial',
                backgroundColor: 'rgba(173,216,230,0.2)',
                padding: 4, editable: true
            });
            const border = new fabric.Rect({ left: rect.left, top: rect.top, width: w, height: h, fill: 'transparent', stroke: '#0078d4', strokeWidth: 1, selectable: false });
            fc.add(border); fc.add(t);
            fc.setActiveObject(t);
            start = null; rect = null;
            setTool('select');
        });
    }

    function addCheckbox(fc, opt) {
        const p = fc.getPointer(opt.e);
        const box = new fabric.Rect({ left: p.x, top: p.y, width: 16, height: 16, fill: 'white', stroke: '#000', strokeWidth: 1.5 });
        fc.add(box);
        setTool('select');
    }

    function addRadio(fc, opt) {
        const p = fc.getPointer(opt.e);
        const circ = new fabric.Circle({ left: p.x, top: p.y, radius: 8, fill: 'white', stroke: '#000', strokeWidth: 1.5 });
        fc.add(circ);
        setTool('select');
    }

    function addStamp(fc, opt, label) {
        const p = fc.getPointer(opt.e);
        const stamps = { APPROVED: '#0ea5e9', REJECTED: '#ef4444', DRAFT: '#f59e0b', CONFIDENTIAL: '#7c3aed' };
        const color = stamps[label] || '#0ea5e9';
        const rect = new fabric.Rect({ width: 120, height: 38, fill: 'transparent', stroke: color, strokeWidth: 3, rx: 4, ry: 4 });
        const txt = new fabric.Text(label, { fontSize: 18, fill: color, fontWeight: 'bold', top: 8, left: 8, fontFamily: 'Arial' });
        const grp = new fabric.Group([rect, txt], { left: p.x, top: p.y });
        fc.add(grp);
        setTool('select');
    }

    // ── Properties updates from right panel ──
    function onSelection(pageNum, e) {
        currentPageNum = pageNum;
        const obj = canvases[pageNum]?.getActiveObject();
        if (!obj) return clearSelection();
        document.getElementById('obj-props').style.display = 'block';
        document.getElementById('px').value = Math.round(obj.left);
        document.getElementById('py').value = Math.round(obj.top);
        document.getElementById('pw').value = Math.round(obj.getScaledWidth());
        document.getElementById('ph').value = Math.round(obj.getScaledHeight());
        document.getElementById('pr').value = Math.round(obj.angle || 0);
        document.getElementById('po').value = Math.round((obj.opacity || 1) * 100);
        if (onSelectionCb) onSelectionCb(obj);
    }

    function clearSelection() {
        document.getElementById('obj-props').style.display = 'none';
    }

    function setProp(key, val) {
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (!obj) return;
        obj.set(key, val);
        if (key === 'width' || key === 'height') obj.setCoords();
        fc.renderAll();
    }

    function setSelectedOpacity(val) {
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) { obj.set('opacity', val); fc.renderAll(); }
    }

    // ── Style setters ──
    function setFillColor(c) {
        fillColor = c;
        document.getElementById('fill-swatch').style.background = c;
        if (activeTool === 'pencil') {
            Object.values(canvases).forEach(fc => { if (fc.freeDrawingBrush) fc.freeDrawingBrush.color = c; });
        }
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) { obj.set('fill', c); fc.renderAll(); }
    }

    function setStrokeColor(c) {
        strokeColor = c;
        document.getElementById('stroke-swatch').style.borderColor = c;
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) { obj.set('stroke', c); fc.renderAll(); }
    }

    function setFontSize(s) {
        fontSize = s;
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj && (obj.type === 'i-text' || obj.type === 'text')) { obj.set('fontSize', s); fc.renderAll(); }
    }

    function setStrokeWidth(w) {
        strokeWidth = w;
        Object.values(canvases).forEach(fc => { if (fc.freeDrawingBrush) fc.freeDrawingBrush.width = w; });
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) { obj.set('strokeWidth', w); fc.renderAll(); }
    }

    function setOpacity(v) {
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) { obj.set('opacity', v); fc.renderAll(); }
    }

    // ── Edit / Delete / Copy ──
    function deleteSelected() {
        const fc = canvases[currentPageNum];
        if (!fc) return;
        const obj = fc.getActiveObject();
        if (!obj) return;
        if (obj.type === 'activeSelection') {
            obj.getObjects().forEach(o => fc.remove(o));
        } else {
            fc.remove(obj);
        }
        fc.discardActiveObject();
        fc.renderAll();
    }

    function copySelected() {
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) obj.clone(c => { clipboard = c; });
    }

    function duplicateSelected() {
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (!obj) return;
        obj.clone(c => {
            c.set({ left: c.left + 20, top: c.top + 20 });
            fc.add(c);
            fc.setActiveObject(c);
        });
    }

    function bringForward() {
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) { fc.bringForward(obj); fc.renderAll(); }
    }

    function sendBackward() {
        const fc = canvases[currentPageNum];
        const obj = fc?.getActiveObject();
        if (obj) { fc.sendBackwards(obj); fc.renderAll(); }
    }

    // ── Undo / Redo ──
    function pushHistory(pageNum) {
        const fc = canvases[pageNum];
        if (!fc) return;
        const h = history[pageNum];
        // Drop redo branch
        h.stack = h.stack.slice(0, h.pos + 1);
        h.stack.push(fc.toJSON(['data']));
        h.pos = h.stack.length - 1;
        // Cap at 30 states
        if (h.stack.length > 30) { h.stack.shift(); h.pos--; }
    }

    function undo() {
        const fc = canvases[currentPageNum];
        if (!fc) return;
        const h = history[currentPageNum];
        if (h.pos <= 0) { App.toast('Nothing to undo', 'info'); return; }
        h.pos--;
        fc.loadFromJSON(h.stack[h.pos], () => fc.renderAll());
    }

    function redo() {
        const fc = canvases[currentPageNum];
        if (!fc) return;
        const h = history[currentPageNum];
        if (h.pos >= h.stack.length - 1) { App.toast('Nothing to redo', 'info'); return; }
        h.pos++;
        fc.loadFromJSON(h.stack[h.pos], () => fc.renderAll());
    }

    // ── Export ──
    async function exportPageImage(pageNum, pdfPageCanvas) {
        const fc = canvases[pageNum];
        if (!pdfPageCanvas) return null;

        // Merge PDF canvas + Fabric overlay
        const merged = document.createElement('canvas');
        merged.width = pdfPageCanvas.width;
        merged.height = pdfPageCanvas.height;
        const ctx = merged.getContext('2d');

        // Draw PDF
        ctx.drawImage(pdfPageCanvas, 0, 0);

        if (fc) {
            // Draw Fabric overlay scaled to match full resolution
            const scaleX = pdfPageCanvas.width / fc.getWidth();
            const scaleY = pdfPageCanvas.height / fc.getHeight();
            const overlayURL = fc.toDataURL({ format: 'png', multiplier: 1 });
            await new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    ctx.drawImage(img, 0, 0, merged.width, merged.height);
                    resolve();
                };
                img.src = overlayURL;
            });
        }
        return merged;
    }

    function getCanvas(pageNum) { return canvases[pageNum]; }
    function setCurrentPage(n) { currentPageNum = n; }
    function getCurrentPage() { return currentPageNum; }
    function getActiveTool() { return activeTool; }
    function onSelectionChange(cb) { onSelectionCb = cb; }

    // Expose addTextObject for AI/OCR use
    function addOCRText(pageNum, x, y, text, opts) {
        const fc = canvases[pageNum];
        if (!fc) return null;
        // White background rect to cover original text
        const bg = new fabric.Rect({
            left: x, top: y,
            width: opts.width || 100, height: opts.height || 16,
            fill: 'white', selectable: false, evented: false
        });
        fc.add(bg);
        const t = new fabric.IText(text, {
            left: x, top: y,
            fontSize: opts.fontSize || 12,
            fill: '#000000',
            fontFamily: 'Arial',
            editable: true,
            data: { ocr: true }
        });
        fc.add(t);
        return t;
    }

    // Apple Preview-style: invisible overlays that become editable on click
    function addPageTextOverlay(pageNum, items) {
        const fc = canvases[pageNum];
        if (!fc || !items || !items.length) return 0;

        // Suspend history for bulk add
        const origAdd = fc.__eventListeners?.['object:added'];
        fc.off('object:added');

        let count = 0;
        items.forEach(item => {
            if (!item.str || !item.str.trim()) return;
            const w = Math.max(item.width || 20, 10);
            const h = Math.max(item.height || 12, 8);
            const fs = Math.max(item.fontSize || h * 0.85, 6);

            // Background rect — transparent until editing starts
            const bg = new fabric.Rect({
                left: item.x, top: item.y,
                width: w + 2, height: h + 2,
                fill: 'transparent',
                stroke: 'transparent',
                strokeWidth: 0,
                selectable: false, evented: false,
                data: { editBg: true }
            });
            fc.add(bg);

            const t = new fabric.IText(item.str, {
                left: item.x, top: item.y,
                fontSize: fs,
                fill: 'transparent',   // invisible — PDF text shows underneath
                fontFamily: 'Arial',
                editable: true,
                lockScalingX: false, lockScalingY: false,
                borderColor: '#3b82f6',
                cornerColor: '#3b82f6',
                cornerSize: 6,
                transparentCorners: false,
                data: { pdfText: true, bgRef: bg }
            });

            // On click to edit: white bg covers original, text turns black
            t.on('editing:entered', () => {
                bg.set({ fill: 'white', stroke: '#3b82f6', strokeWidth: 1 });
                t.set({ fill: '#111111' });
                fc.renderAll();
            });
            // Keep visible after editing so changes persist
            t.on('editing:exited', () => {
                if (t.text.trim()) {
                    bg.set({ fill: 'white', stroke: 'transparent', strokeWidth: 0 });
                    t.set({ fill: '#111111' });
                } else {
                    bg.set({ fill: 'transparent' });
                    t.set({ fill: 'transparent' });
                }
                fc.renderAll();
            });

            fc.add(t);
            count++;
        });

        // Restore history listener
        if (origAdd && origAdd.length) origAdd.forEach(fn => fc.on('object:added', fn));

        fc.renderAll();
        return count;
    }

    function addWatermark(pageNum, text, color, opacity, fontSize) {
        const fc = canvases[pageNum];
        if (!fc) return;
        const wm = new fabric.Text(text, {
            left: fc.getWidth() / 2,
            top: fc.getHeight() / 2,
            fontSize,
            fill: color,
            opacity: opacity / 100,
            angle: -45,
            originX: 'center', originY: 'center',
            fontWeight: 'bold',
            selectable: true
        });
        fc.add(wm);
    }

    function addImageFromDataURL(pageNum, dataURL, x, y) {
        const fc = canvases[pageNum];
        if (!fc) return;
        fabric.Image.fromURL(dataURL, img => {
            const maxW = fc.getWidth() * 0.5;
            if (img.width > maxW) img.scaleToWidth(maxW);
            img.set({ left: x || 50, top: y || 50 });
            fc.add(img);
            fc.setActiveObject(img);
        });
    }

    return {
        initPage, setTool, getActiveTool, getCanvas,
        setFillColor, setStrokeColor, setFontSize, setStrokeWidth, setOpacity,
        deleteSelected, copySelected, duplicateSelected,
        bringForward, sendBackward,
        setProp, setSelectedOpacity,
        undo, redo,
        exportPageImage,
        addOCRText, addPageTextOverlay, addWatermark, addImageFromDataURL,
        setCurrentPage, getCurrentPage, onSelectionChange
    };
})();
