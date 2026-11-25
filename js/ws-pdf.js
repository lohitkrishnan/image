// Workspace 4: images to PDF. Uses jsPDF (MIT), loaded only when a PDF is first made.

import { formatBytes, downloadBlob, createCanvas, releaseCanvas, decodeImage, releaseSource, drawScaled, encodeCanvas, wireDropzone, baseName } from './image-io.js';
import { createImageList } from './image-list.js';
import { makeSampleSet } from './samples.js';
import { createZip } from './zip.js';

const PAGES = {
    a4: [210, 297],
    letter: [215.9, 279.4],
    legal: [215.9, 355.6],
    a5: [148, 210],
};
const QUALITY = {
    high: { dpi: 300, q: 0.92 },
    medium: { dpi: 200, q: 0.85 },
    small: { dpi: 120, q: 0.72 },
};
const GAP_MM = 5;

let jspdfPromise = null;
function loadJsPdf() {
    if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!jspdfPromise) {
        jspdfPromise = new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = './vendor/jspdf.umd.min.js';
            el.onload = () => resolve(window.jspdf.jsPDF);
            el.onerror = () => {
                jspdfPromise = null;
                reject(new Error('Could not load the PDF library. Check your connection and try again.'));
            };
            document.head.appendChild(el);
        });
    }
    return jspdfPromise;
}

function gridFor(n, landscape) {
    switch (n) {
        case 2: return landscape ? [2, 1] : [1, 2];
        case 4: return [2, 2];
        case 6: return landscape ? [3, 2] : [2, 3];
        case 9: return [3, 3];
        default: return [1, 1];
    }
}

/**
 * Plan every page: size in mm and where each image goes.
 * Returns [{ w, h, slots: [{ item, x, y, w, h, crop: {sx, sy, sw, sh} }] }].
 */
export function planPages(items, opts) {
    const pages = [];
    const m = opts.margin;
    if (opts.page === 'fit') {
        for (const it of items) {
            const long = 297 - 2 * m;
            const k = long / Math.max(it.width, it.height);
            const iw = it.width * k, ih = it.height * k;
            pages.push({ w: iw + 2 * m, h: ih + 2 * m, slots: [{ item: it, x: m, y: m, w: iw, h: ih, crop: null }] });
        }
        return pages;
    }
    const [pw, ph] = PAGES[opts.page] || PAGES.a4;
    const per = opts.per;
    for (let i = 0; i < items.length; i += per) {
        const group = items.slice(i, i + per);
        let landscape = opts.orient === 'landscape';
        if (opts.orient === 'auto') landscape = per === 1 ? group[0].width > group[0].height : false;
        const W = landscape ? ph : pw, H = landscape ? pw : ph;
        const [cols, rows] = gridFor(per, landscape);
        const gap = per > 1 ? GAP_MM : 0;
        const cw = (W - 2 * m - (cols - 1) * gap) / cols;
        const chh = (H - 2 * m - (rows - 1) * gap) / rows;
        const slots = group.map((it, j) => {
            const cx = m + (j % cols) * (cw + gap), cy = m + Math.floor(j / cols) * (chh + gap);
            if (opts.fit === 'cover') {
                const k = Math.max(cw / it.width, chh / it.height);
                const sw = cw / k, sh = chh / k;
                return { item: it, x: cx, y: cy, w: cw, h: chh, crop: { sx: (it.width - sw) / 2, sy: (it.height - sh) / 2, sw, sh } };
            }
            const k = Math.min(cw / it.width, chh / it.height);
            const w = it.width * k, h = it.height * k;
            return { item: it, x: cx + (cw - w) / 2, y: cy + (chh - h) / 2, w, h, crop: null };
        });
        pages.push({ w: W, h: H, slots });
    }
    return pages;
}

export function initPdfWorkspace({ root, toast }) {
    const $ = (id) => root.querySelector(`#${id}`);
    let orient = 'auto';
    let fit = 'contain';
    let busy = false;

    const list = createImageList({ container: $('pdf-list'), toast, onChange: update });

    function opts() {
        return {
            page: $('pdf-page').value,
            orient,
            per: Number($('pdf-per').value),
            margin: Number($('pdf-margin').value),
            fit,
            quality: QUALITY[$('pdf-quality').value] || QUALITY.medium,
            separate: $('pdf-separate').checked,
        };
    }

    function segWire(attr, set) {
        const btns = Array.from(root.querySelectorAll(`[data-${attr}]`));
        btns.forEach((b) => b.addEventListener('click', () => {
            btns.forEach((x) => {
                const on = x === b;
                x.classList.toggle('is-active', on);
                x.setAttribute('aria-pressed', String(on));
            });
            set(b.dataset[attr]);
            update();
        }));
    }
    segWire('orient', (v) => { orient = v; });
    segWire('pdffit', (v) => { fit = v; });
    for (const id of ['pdf-page', 'pdf-per', 'pdf-margin', 'pdf-quality', 'pdf-separate']) $(id).addEventListener('change', update);

    function update() {
        const o = opts();
        const items = list.items;
        const isFit = o.page === 'fit';
        $('pdf-orient-group').hidden = isFit;
        $('pdf-per-group').hidden = isFit || o.separate;
        $('pdf-fit-group').hidden = isFit;
        $('pdf-run-btn').disabled = busy || !items.length || list.busy;
        $('pdf-run-btn').textContent = o.separate && items.length > 1 ? `Create ${items.length} PDFs` : 'Create PDF';
        $('pdf-clear-btn').disabled = busy || !items.length;
        $('pdf-sort-btn').disabled = busy || items.length < 2;
        if (!items.length) {
            $('pdf-summary').textContent = '';
            $('pdf-preview-wrap').hidden = true;
            return;
        }
        const pages = planPages(items, o.separate ? { ...o, per: 1 } : o);
        $('pdf-summary').textContent = o.separate
            ? `${items.length} image${items.length === 1 ? '' : 's'} → ${items.length} PDF${items.length === 1 ? '' : 's'}, one page each.`
            : `${items.length} image${items.length === 1 ? '' : 's'} → ${pages.length} page${pages.length === 1 ? '' : 's'}.`;
        renderPreview(pages);
    }

    function renderPreview(pages) {
        const wrap = $('pdf-preview');
        wrap.innerHTML = '';
        $('pdf-preview-wrap').hidden = false;
        const shown = pages.slice(0, 12);
        shown.forEach((pg, i) => {
            const k = 150 / Math.max(pg.w, pg.h);
            const c = createCanvas(pg.w * k * 2, pg.h * k * 2);
            c.style.width = `${pg.w * k}px`;
            c.style.height = `${pg.h * k}px`;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, c.width, c.height);
            ctx.imageSmoothingQuality = 'high';
            const s = (k * 2);
            for (const sl of pg.slots) {
                const p = sl.item.preview;
                const pk = p.width / sl.item.width;
                if (sl.crop) ctx.drawImage(p, sl.crop.sx * pk, sl.crop.sy * pk, sl.crop.sw * pk, sl.crop.sh * pk, sl.x * s, sl.y * s, sl.w * s, sl.h * s);
                else ctx.drawImage(p, sl.x * s, sl.y * s, sl.w * s, sl.h * s);
            }
            const fig = document.createElement('figure');
            fig.className = 'pdf-page';
            fig.appendChild(c);
            const cap = document.createElement('figcaption');
            cap.textContent = `Page ${i + 1}`;
            fig.appendChild(cap);
            wrap.appendChild(fig);
        });
        if (pages.length > shown.length) {
            const more = document.createElement('p');
            more.className = 'field-note';
            more.textContent = `…and ${pages.length - shown.length} more page${pages.length - shown.length === 1 ? '' : 's'}.`;
            wrap.appendChild(more);
        }
    }

    async function renderSlotJpeg(sl, quality) {
        const dec = await decodeImage(sl.item.file);
        try {
            const crop = sl.crop || { sx: 0, sy: 0, sw: dec.width, sh: dec.height };
            // Pixels needed for the printed size at the chosen DPI, never more than the photo has.
            const wantW = (sl.w / 25.4) * quality.dpi, wantH = (sl.h / 25.4) * quality.dpi;
            const k = Math.min(1, wantW / crop.sw, wantH / crop.sh);
            const canvas = drawScaled(dec.source, crop.sw * k, crop.sh * k, { ...crop, background: '#ffffff' });
            const bytes = await encodeCanvas(canvas, { format: 'jpg', quality: quality.q });
            const dims = { w: canvas.width, h: canvas.height };
            releaseCanvas(canvas);
            return { bytes, ...dims };
        } finally {
            releaseSource(dec.source);
        }
    }

    async function buildPdf(JsPDF, pages, o, onSlot) {
        let doc = null;
        for (const pg of pages) {
            const orientation = pg.w > pg.h ? 'landscape' : 'portrait';
            if (!doc) doc = new JsPDF({ unit: 'mm', format: [pg.w, pg.h], orientation, compress: true });
            else doc.addPage([pg.w, pg.h], orientation);
            for (const sl of pg.slots) {
                const img = await renderSlotJpeg(sl, o.quality);
                doc.addImage(img.bytes, 'JPEG', sl.x, sl.y, sl.w, sl.h, undefined, 'NONE');
                onSlot();
                await new Promise((r) => setTimeout(r, 0));
            }
        }
        doc.setProperties({ title: $('pdf-name').value || 'images', creator: 'Image Studio (lohitkrishnan.com/image)' });
        return new Uint8Array(doc.output('arraybuffer'));
    }

    async function run() {
        const items = list.items;
        if (!items.length || busy) return;
        busy = true;
        update();
        const btn = $('pdf-run-btn');
        const result = $('pdf-result');
        try {
            const JsPDF = await loadJsPdf();
            const o = opts();
            const name = ($('pdf-name').value || 'images').replace(/[\\/:*?"<>|]/g, '').replace(/\.pdf$/i, '') || 'images';
            let done = 0;
            const label = () => { btn.textContent = `Adding image ${Math.min(done + 1, items.length)} of ${items.length}…`; };
            const tick = () => { done++; label(); };
            label();
            if (o.separate) {
                const files = [];
                for (const it of items) {
                    const pages = planPages([it], { ...o, per: 1 });
                    files.push({ name: `${baseName(it.name)}.pdf`, data: await buildPdf(JsPDF, pages, o, tick) });
                }
                if (files.length === 1) {
                    downloadBlob(files[0].data, files[0].name, 'application/pdf');
                    result.textContent = `Saved ${files[0].name} (${formatBytes(files[0].data.length)}).`;
                } else {
                    const zip = createZip(files);
                    downloadBlob(zip, `${name}.zip`, 'application/zip');
                    result.textContent = `Saved ${files.length} PDFs in ${name}.zip (${formatBytes(zip.length)}).`;
                }
            } else {
                const pages = planPages(items, o);
                const bytes = await buildPdf(JsPDF, pages, o, tick);
                downloadBlob(bytes, `${name}.pdf`, 'application/pdf');
                result.textContent = `Saved ${name}.pdf: ${pages.length} page${pages.length === 1 ? '' : 's'}, ${formatBytes(bytes.length)}.`;
            }
            toast('PDF ready.', 'ok');
        } catch (err) {
            toast(err.message || String(err), 'error');
        } finally {
            busy = false;
            update();
        }
    }

    $('pdf-run-btn').addEventListener('click', run);
    $('pdf-sample-btn').addEventListener('click', async () => {
        const btn = $('pdf-sample-btn');
        btn.disabled = true;
        try {
            await list.add(await makeSampleSet());
        } finally {
            btn.disabled = false;
        }
    });
    $('pdf-clear-btn').addEventListener('click', () => { list.clear(); $('pdf-result').textContent = ''; });
    $('pdf-sort-btn').addEventListener('click', () => list.sortByName());
    wireDropzone($('pdf-dropzone'), $('pdf-file-input'), (files) => list.add(files));
    update();

    return { handleFiles: (files) => list.add(files) };
}
