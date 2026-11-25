// Workspace 3: crop, rotate, straighten, adjust, and annotate with text, arrows, boxes and
// highlights.
//
// Everything is non-destructive until export. Geometry is a pipeline applied to the original
// pixels: flip → rotate by 90° steps → straighten (with an automatic inner crop so no empty
// corners appear) → crop. The crop rectangle and all annotations live in "T-space", the
// straightened image's coordinate system in source pixels, so they stay attached to the content
// when the rotation changes. Export renders the same pipeline at full resolution.

import {
    FORMATS, baseName, downloadBlob, createCanvas, releaseCanvas, decodeImage,
    releaseSource, drawScaled, encodeCanvas, supportsWebpEncoding, wireDropzone,
} from './image-io.js';
import { makeLandscapeSample } from './samples.js';

const PREVIEW_MAX = 2400; // longest side of the cached preview bitmap
const MAX_OUTPUT_PIXELS = 100e6;
const HANDLE = 9; // screen px
const FONT = '600 {px}px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const LINE_HEIGHT = 1.25;

// ---------- 2D affine helpers: [a, b, c, d, e, f] as in canvas setTransform ----------

const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const inv = (m) => {
    const det = m[0] * m[3] - m[1] * m[2];
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scaleM = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
const rotateM = (rad) => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// ---------- Adjustments (identical maths for preview and export) ----------

export const DEFAULT_ADJUST = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, filter: 'none' };

export function hasAdjustments(adj) {
    return !!(adj.brightness || adj.contrast || adj.saturation || adj.warmth || (adj.filter && adj.filter !== 'none'));
}

const FILTERS = {
    bw: (r, g, b) => { const y = 0.299 * r + 0.587 * g + 0.114 * b; return [y, y, y]; },
    noir: (r, g, b) => { const y = (0.299 * r + 0.587 * g + 0.114 * b - 128) * 1.35 + 128; return [y, y, y]; },
    sepia: (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b],
    vintage: (r, g, b) => {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
        return [(r * 0.4 + sr * 0.6) * 0.88 + 22, (g * 0.4 + sg * 0.6) * 0.88 + 16, (b * 0.4 + sb * 0.6) * 0.84 + 18];
    },
    fade: (r, g, b) => {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        return [(y + (r - y) * 0.8) * 0.82 + 34, (y + (g - y) * 0.8) * 0.82 + 34, (y + (b - y) * 0.8) * 0.82 + 38];
    },
    vivid: (r, g, b) => {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        return [((y + (r - y) * 1.4) - 128) * 1.08 + 128, ((y + (g - y) * 1.4) - 128) * 1.08 + 128, ((y + (b - y) * 1.4) - 128) * 1.08 + 128];
    },
    warm: (r, g, b) => [r * 1.06 + 10, g * 1.01 + 3, b * 0.88],
    cool: (r, g, b) => [r * 0.9, g * 1.0 + 2, b * 1.06 + 12],
    invert: (r, g, b) => [255 - r, 255 - g, 255 - b],
};

function adjustPixels(imageData, adj) {
    if (!hasAdjustments(adj)) return;
    const { brightness = 0, contrast = 0, saturation = 0, warmth = 0, filter = 'none' } = adj;
    const C = contrast * 2.55;
    const f = (259 * (C + 255)) / (255 * (259 - C));
    const off = brightness * 1.28;
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = (i - 128) * f + 128 + off;
    const sf = 1 + saturation / 100;
    const wr = warmth * 0.3, wb = -warmth * 0.3;
    const fx = FILTERS[filter] || null;
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
        let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
        if (sf !== 1) {
            const y = 0.299 * r + 0.587 * g + 0.114 * b;
            r = y + (r - y) * sf;
            g = y + (g - y) * sf;
            b = y + (b - y) * sf;
        }
        if (warmth) {
            r += wr;
            b += wb;
        }
        if (fx) [r, g, b] = fx(r, g, b);
        d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray clamps and rounds
    }
}

// ---------- Annotation drawing (T-space units) ----------

const measureCtx = document.createElement('canvas').getContext('2d');

function textLines(a) {
    return (a.text || '').split('\n');
}

function textBox(a) {
    measureCtx.font = FONT.replace('{px}', String(a.size));
    const lines = textLines(a);
    const w = Math.max(a.size * 0.5, ...lines.map((l) => measureCtx.measureText(l).width));
    const h = lines.length * a.size * LINE_HEIGHT;
    const pad = a.bg ? a.size * 0.25 : 0;
    return { x: a.x - pad, y: a.y - pad, w: w + 2 * pad, h: h + 2 * pad };
}

function arrowGeometry(a) {
    const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
    const len = Math.hypot(dx, dy) || 1;
    const head = Math.min(len * 0.6, a.size * 4 + 6);
    const ux = dx / len, uy = dy / len;
    const bx = a.x2 - ux * head, by = a.y2 - uy * head;
    const hw = head * 0.55;
    return { bx, by, p1: { x: bx - uy * hw, y: by + ux * hw }, p2: { x: bx + uy * hw, y: by - ux * hw } };
}

function drawAnnotation(c, a) {
    c.save();
    if (a.type === 'rect') {
        const r = normRect(a);
        if (a.fill) {
            c.fillStyle = a.color;
            c.fillRect(r.x, r.y, r.w, r.h);
        } else {
            c.strokeStyle = a.color;
            c.lineWidth = a.size;
            c.lineJoin = 'round';
            c.strokeRect(r.x, r.y, r.w, r.h);
        }
    } else if (a.type === 'highlight') {
        const r = normRect(a);
        c.globalAlpha = 0.4;
        c.fillStyle = a.color;
        c.fillRect(r.x, r.y, r.w, r.h);
    } else if (a.type === 'arrow') {
        const g = arrowGeometry(a);
        c.strokeStyle = a.color;
        c.fillStyle = a.color;
        c.lineWidth = a.size;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(a.x1, a.y1);
        c.lineTo(g.bx, g.by);
        c.stroke();
        c.beginPath();
        c.moveTo(a.x2, a.y2);
        c.lineTo(g.p1.x, g.p1.y);
        c.lineTo(g.p2.x, g.p2.y);
        c.closePath();
        c.fill();
    } else if (a.type === 'text') {
        if (a.bg) {
            const b = textBox(a);
            c.fillStyle = isLight(a.color) ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.88)';
            roundRect(c, b.x, b.y, b.w, b.h, a.size * 0.2);
            c.fill();
        }
        c.font = FONT.replace('{px}', String(a.size));
        c.fillStyle = a.color;
        c.textBaseline = 'top';
        textLines(a).forEach((line, i) => c.fillText(line, a.x, a.y + i * a.size * LINE_HEIGHT + a.size * 0.1));
    }
    c.restore();
}

/**
 * Pixelate or blur the area under a "blur" annotation, reading the pixels already on `c`.
 * `M` maps T-space to c's pixels and must be a plain scale + translate (it always is here).
 */
function applyRegionEffect(c, M, a, clip) {
    const r = normRect(a);
    let x1 = M[0] * r.x + M[4], y1 = M[3] * r.y + M[5];
    let x2 = M[0] * (r.x + r.w) + M[4], y2 = M[3] * (r.y + r.h) + M[5];
    if (clip) {
        x1 = Math.max(x1, clip.x1); y1 = Math.max(y1, clip.y1);
        x2 = Math.min(x2, clip.x2); y2 = Math.min(y2, clip.y2);
    }
    x1 = Math.max(0, Math.floor(x1)); y1 = Math.max(0, Math.floor(y1));
    x2 = Math.min(c.canvas.width, Math.ceil(x2)); y2 = Math.min(c.canvas.height, Math.ceil(y2));
    const w = x2 - x1, h = y2 - y1;
    if (w < 1 || h < 1) return;
    const block = Math.max(2, a.size * Math.abs(M[0]));
    const sw = Math.max(1, Math.round(w / block)), sh = Math.max(1, Math.round(h / block));
    const small = document.createElement('canvas');
    small.width = sw;
    small.height = sh;
    const sc = small.getContext('2d');
    sc.imageSmoothingEnabled = true;
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(c.canvas, x1, y1, w, h, 0, 0, sw, sh);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    c.rect(x1, y1, w, h);
    c.clip();
    if (a.soft) {
        // Two up-sampling passes through a mid-size canvas give a smooth, even blur.
        const mid = document.createElement('canvas');
        mid.width = Math.max(1, sw * 4);
        mid.height = Math.max(1, sh * 4);
        const mc = mid.getContext('2d');
        mc.imageSmoothingEnabled = true;
        mc.drawImage(small, 0, 0, mid.width, mid.height);
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(mid, x1, y1, w, h);
        mid.width = 0;
    } else {
        c.imageSmoothingEnabled = false;
        c.drawImage(small, x1, y1, w, h);
    }
    c.restore();
    small.width = 0;
}

/** Paint all annotations in order, clipped to the visible region. */
function paintAnnotations(c, M, region, annots, skipId = null) {
    const tl = apply(M, region.x, region.y), br = apply(M, region.x + region.w, region.y + region.h);
    const clip = { x1: tl.x, y1: tl.y, x2: br.x, y2: br.y };
    for (const a of annots) {
        if (a.id === skipId) continue;
        if (a.type === 'blur') {
            applyRegionEffect(c, M, a, clip);
            continue;
        }
        c.save();
        c.setTransform(...M);
        c.beginPath();
        c.rect(region.x, region.y, region.w, region.h);
        c.clip();
        drawAnnotation(c, a);
        c.restore();
    }
}

function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

function normRect(a) {
    return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- Workspace ----------

export function initEditWorkspace({ root, toast }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const stage = $('ed-stage');
    const canvas = $('ed-canvas');
    const ctx = canvas.getContext('2d');
    const inlineText = $('ed-inline-text');
    const input = $('ed-file-input');
    const toolBtns = Array.from(root.querySelectorAll('[data-tool]'));
    const fmtBtns = Array.from(root.querySelectorAll('[data-edformat]'));
    const sliders = { brightness: $('ed-brightness'), contrast: $('ed-contrast'), saturation: $('ed-saturation'), warmth: $('ed-warmth') };
    const filterChips = Array.from(root.querySelectorAll('[data-filter]'));
    const canvasButtons = ['ed-cut-btn', 'ed-border-btn', 'ed-square-btn'].map((id) => $(id));
    const straighten = $('ed-straighten');
    const geomButtons = ['ed-rot-left', 'ed-rot-right', 'ed-flip-h', 'ed-flip-v'].map((id) => $(id));

    const webpOk = supportsWebpEncoding();
    if (!webpOk) {
        const b = fmtBtns.find((x) => x.dataset.edformat === 'webp');
        b.disabled = true;
        b.title = 'This browser cannot save WebP images.';
    }

    let img = null; // { name, type } of the opened file
    // Pixel sources. [0] is the opened photo; cutting a strip or adding a border bakes the
    // current geometry into a new source, and undo just points back at an earlier one.
    let sources = []; // { source, width, height, preview, previewScale }
    const src = () => sources[state.src];
    let cutMode = false;
    let cutBand = null; // { axis: 'h' | 'v', a, b } in T-space
    let state = null; // { tf: { rot, flipH, flipV, straighten }, crop, adjust, annots }
    let tool = 'select';
    let selectedId = null;
    let cropMode = false;
    let cropDraft = null;
    let editingId = null;
    let outFormat = 'jpg';
    let annId = 0;
    let undoStack = [];
    let redoStack = [];
    let pending = null; // snapshot taken at the start of an in-progress change
    let geomBase = null; // { tfM, crop, cropDraft, annots } at the start of a geometry change
    let view = { scale: 1, ox: 0, oy: 0, cssW: 0, cssH: 0, dpr: 1, region: null };
    let photoLayer = null;
    let photoDirty = true;
    let drag = null;
    const lastStyle = {
        text: { color: '#e11d48', v: 24, bg: false },
        arrow: { color: '#e11d48', v: 20 },
        rect: { color: '#e11d48', v: 20, fill: false },
        highlight: { color: '#facc15' },
        blur: { color: '#111111', v: 30, soft: false },
    };

    // ---------- Geometry ----------

    function tfInfo(tf) {
        const { width: W, height: H } = src();
        const odd = tf.rot % 180 !== 0;
        const Rw = odd ? H : W, Rh = odd ? W : H;
        const a = Math.abs(tf.straighten * Math.PI / 180);
        const k = a ? Math.min(Rw / (Rw * Math.cos(a) + Rh * Math.sin(a)), Rh / (Rw * Math.sin(a) + Rh * Math.cos(a))) : 1;
        const Tw = Rw * k, Th = Rh * k;
        const theta = (tf.rot + tf.straighten) * Math.PI / 180;
        // T = translate(Tw/2, Th/2) · rotate(θ) · flip · translate(−W/2, −H/2) · source
        let M = translate(-W / 2, -H / 2);
        M = mul(scaleM(tf.flipH ? -1 : 1, tf.flipV ? -1 : 1), M);
        M = mul(rotateM(theta), M);
        M = mul(translate(Tw / 2, Th / 2), M);
        return { M, Tw, Th };
    }

    function tSize() {
        const { Tw, Th } = tfInfo(state.tf);
        return { Tw, Th };
    }

    function cropRect() {
        const { Tw, Th } = tSize();
        return state.crop || { x: 0, y: 0, w: Tw, h: Th };
    }

    function clampRect(r, Tw, Th) {
        const x = clamp(r.x, 0, Tw), y = clamp(r.y, 0, Th);
        const x2 = clamp(r.x + r.w, 0, Tw), y2 = clamp(r.y + r.h, 0, Th);
        if (x2 - x < 2 || y2 - y < 2) return null;
        return { x, y, w: x2 - x, h: y2 - y };
    }

    function isFull(r, Tw, Th) {
        return !r || (r.x < 0.5 && r.y < 0.5 && Math.abs(r.w - Tw) < 1 && Math.abs(r.h - Th) < 1);
    }

    /** Change the geometric transform, carrying crop and annotations along with the content. */
    function setTransform(nextTf) {
        if (!geomBase) {
            geomBase = { M: tfInfo(state.tf).M, crop: clone(state.crop), cropDraft: clone(cropDraft), annots: clone(state.annots) };
        }
        state.tf = nextTf;
        const { M, Tw, Th } = tfInfo(nextTf);
        const m = mul(M, inv(geomBase.M));
        // The change is a rotation (plus translation). Rectangles keep their size and follow
        // their centre, swapping width and height for quarter turns, so they don't grow.
        const quarter = Math.round(Math.atan2(m[1], m[0]) / (Math.PI / 2));
        const swap = Math.abs(quarter) % 2 === 1;
        const moveRect = (r) => {
            const c = apply(m, r.x + r.w / 2, r.y + r.h / 2);
            const w = swap ? r.h : r.w, h = swap ? r.w : r.h;
            return { x: c.x - w / 2, y: c.y - h / 2, w, h };
        };
        const remapCrop = (r) => {
            if (!r) return null;
            let { x, y, w, h } = moveRect(r);
            const k = Math.min(1, Tw / w, Th / h); // shrink, keeping the shape, if it no longer fits
            const cx = x + w / 2, cy = y + h / 2;
            w *= k; h *= k;
            const c = { x: clamp(cx - w / 2, 0, Tw - w), y: clamp(cy - h / 2, 0, Th - h), w, h };
            return isFull(c, Tw, Th) ? null : c;
        };
        state.crop = remapCrop(geomBase.crop);
        if (cropMode) cropDraft = remapCrop(geomBase.cropDraft) || { x: 0, y: 0, w: Tw, h: Th };
        state.annots = geomBase.annots.map((a0) => {
            const a = clone(a0);
            if (a.type === 'text') {
                const b = textBox(a0);
                const n = moveRect({ x: b.x, y: b.y, w: b.w, h: b.h });
                // Text stays upright; keep its box inside the image when it fits.
                const nx = b.w <= Tw ? clamp(n.x + (n.w - b.w) / 2, 0, Tw - b.w) : n.x + (n.w - b.w) / 2;
                const ny = b.h <= Th ? clamp(n.y + (n.h - b.h) / 2, 0, Th - b.h) : n.y + (n.h - b.h) / 2;
                a.x = a0.x + (nx - b.x);
                a.y = a0.y + (ny - b.y);
            } else if (a.type === 'arrow') {
                const p = apply(m, a0.x1, a0.y1), q = apply(m, a0.x2, a0.y2);
                Object.assign(a, { x1: p.x, y1: p.y, x2: q.x, y2: q.y });
            } else {
                const r = moveRect(normRect(a0));
                Object.assign(a, { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h });
            }
            return a;
        });
        photoDirty = true;
        fitView();
        draw();
        updateOutDesc();
    }

    // ---------- Undo ----------

    function snapshot() {
        return clone(state);
    }

    function beginChange() {
        if (!pending) pending = snapshot();
    }

    function commitChange() {
        geomBase = null;
        if (!pending) return;
        if (JSON.stringify(pending) !== JSON.stringify(state)) {
            undoStack.push(pending);
            if (undoStack.length > 100) undoStack.shift();
            redoStack = [];
        }
        pending = null;
        updateHistoryButtons();
    }

    function discardChange() {
        pending = null;
        geomBase = null;
    }

    function restore(s) {
        state = clone(s);
        if (selectedId && !state.annots.some((a) => a.id === selectedId)) selectedId = null;
        syncControls();
        photoDirty = true;
        fitView();
        draw();
        renderProps();
        updateOutDesc();
        updateHistoryButtons();
    }

    function undo() {
        finishInlineEdit();
        if (!undoStack.length) return;
        redoStack.push(snapshot());
        restore(undoStack.pop());
    }

    function redo() {
        finishInlineEdit();
        if (!redoStack.length) return;
        undoStack.push(snapshot());
        restore(redoStack.pop());
    }

    function updateHistoryButtons() {
        $('ed-undo').disabled = !undoStack.length;
        $('ed-redo').disabled = !redoStack.length;
    }

    // ---------- View ----------

    function fitView() {
        if (!img) return false;
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const dpr = window.devicePixelRatio || 1;
        const cssW = rect.width, cssH = rect.height;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
            canvas.style.width = `${cssW}px`;
            canvas.style.height = `${cssH}px`;
        }
        const { Tw, Th } = tSize();
        const region = cropMode ? { x: 0, y: 0, w: Tw, h: Th } : cropRect();
        const pad = cropMode ? 28 : 16;
        const scale = Math.min((cssW - 2 * pad) / region.w, (cssH - 2 * pad) / region.h);
        view = {
            scale, dpr, cssW, cssH, region,
            ox: (cssW - region.w * scale) / 2 - region.x * scale,
            oy: (cssH - region.h * scale) / 2 - region.y * scale,
        };
        photoDirty = true;
        return true;
    }

    const toScreen = (x, y) => ({ x: view.ox + x * view.scale, y: view.oy + y * view.scale });
    function toT(clientX, clientY) {
        const r = canvas.getBoundingClientRect();
        return { x: (clientX - r.left - view.ox) / view.scale, y: (clientY - r.top - view.oy) / view.scale };
    }

    /** Matrix from T-space to device pixels on the stage canvas. */
    function viewMatrix() {
        return mul(scaleM(view.dpr), [view.scale, 0, 0, view.scale, view.ox, view.oy]);
    }

    function renderPhotoLayer() {
        if (!photoLayer || photoLayer.width !== canvas.width || photoLayer.height !== canvas.height) {
            releaseCanvas(photoLayer);
            photoLayer = createCanvas(canvas.width, canvas.height);
        }
        const c = photoLayer.getContext('2d');
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, photoLayer.width, photoLayer.height);
        const { M } = tfInfo(state.tf);
        const V = viewMatrix();
        const r = view.region;
        // Clip to the visible region (the crop, or the whole straightened image while cropping).
        const tl = apply(V, r.x, r.y), br = apply(V, r.x + r.w, r.y + r.h);
        c.save();
        c.beginPath();
        c.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        c.clip();
        if (/png|webp|gif/.test(img.type)) {
            drawChecker(c, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        }
        const m = mul(V, mul(M, scaleM(1 / src().previewScale)));
        c.setTransform(...m);
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(src().preview, 0, 0);
        c.restore();
        const adj = state.adjust;
        if (hasAdjustments(adj)) {
            const x = Math.max(0, Math.floor(tl.x)), y = Math.max(0, Math.floor(tl.y));
            const w = Math.min(photoLayer.width, Math.ceil(br.x)) - x, h = Math.min(photoLayer.height, Math.ceil(br.y)) - y;
            if (w > 0 && h > 0) {
                const id = c.getImageData(x, y, w, h);
                adjustPixels(id, adj);
                c.putImageData(id, x, y);
            }
        }
        photoDirty = false;
    }

    function drawChecker(c, x, y, w, h) {
        const s = 10 * view.dpr;
        c.fillStyle = '#ffffff';
        c.fillRect(x, y, w, h);
        c.fillStyle = '#e4e1da';
        for (let yy = 0; yy < h; yy += s) {
            for (let xx = ((yy / s) % 2) * s; xx < w; xx += 2 * s) c.fillRect(x + xx, y + yy, s, s);
        }
    }

    function draw() {
        if (!img || !view.cssW) return;
        if (photoDirty) renderPhotoLayer();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        ctx.fillStyle = dark ? '#1d1c1a' : '#ebe8e1';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(photoLayer, 0, 0);

        paintAnnotations(ctx, viewMatrix(), view.region, state.annots, editingId);

        if (cropMode) drawCropOverlay();
        else if (cutMode) drawCutOverlay();
        else drawSelection();
    }

    function drawSelection() {
        const a = state.annots.find((x) => x.id === selectedId);
        if (!a || a.id === editingId) return;
        ctx.save();
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        const b = annotBounds(a);
        const p = toScreen(b.x, b.y);
        ctx.strokeRect(p.x - 4, p.y - 4, b.w * view.scale + 8, b.h * view.scale + 8);
        ctx.setLineDash([]);
        for (const h of handlesFor(a)) drawHandle(h.x, h.y);
        ctx.restore();
    }

    function drawHandle(sx, sy) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.fillRect(sx - HANDLE / 2, sy - HANDLE / 2, HANDLE, HANDLE);
        ctx.strokeRect(sx - HANDLE / 2, sy - HANDLE / 2, HANDLE, HANDLE);
    }

    function drawCropOverlay() {
        const d = cropDraft;
        ctx.save();
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        const tl = toScreen(d.x, d.y);
        const w = d.w * view.scale, h = d.h * view.scale;
        ctx.beginPath();
        ctx.rect(0, 0, view.cssW, view.cssH);
        ctx.rect(tl.x, tl.y, w, h);
        ctx.fillStyle = 'rgba(20, 18, 16, 0.6)';
        ctx.fill('evenodd');
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(tl.x, tl.y, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(tl.x + (w * i) / 3, tl.y);
            ctx.lineTo(tl.x + (w * i) / 3, tl.y + h);
            ctx.moveTo(tl.x, tl.y + (h * i) / 3);
            ctx.lineTo(tl.x + w, tl.y + (h * i) / 3);
            ctx.stroke();
        }
        for (const hd of cropHandles()) drawHandle(hd.x, hd.y);
        ctx.restore();
        $('ed-crop-size').textContent = `${Math.round(d.w)} × ${Math.round(d.h)} px`;
    }

    // ---------- Hit testing ----------

    function annotBounds(a) {
        if (a.type === 'text') return textBox(a);
        if (a.type === 'arrow') {
            const pad = a.size * 2;
            return { x: Math.min(a.x1, a.x2) - pad, y: Math.min(a.y1, a.y2) - pad, w: Math.abs(a.x2 - a.x1) + 2 * pad, h: Math.abs(a.y2 - a.y1) + 2 * pad };
        }
        return normRect(a);
    }

    function handlesFor(a) {
        if (a.type === 'arrow') {
            return [{ key: 'p1', ...toScreen(a.x1, a.y1) }, { key: 'p2', ...toScreen(a.x2, a.y2) }];
        }
        if (a.type === 'rect' || a.type === 'highlight' || a.type === 'blur') {
            const r = normRect(a);
            return [
                { key: 'nw', ...toScreen(r.x, r.y) }, { key: 'ne', ...toScreen(r.x + r.w, r.y) },
                { key: 'sw', ...toScreen(r.x, r.y + r.h) }, { key: 'se', ...toScreen(r.x + r.w, r.y + r.h) },
            ];
        }
        return [];
    }

    function cropHandles() {
        const d = cropDraft;
        const pts = {
            nw: [d.x, d.y], n: [d.x + d.w / 2, d.y], ne: [d.x + d.w, d.y],
            e: [d.x + d.w, d.y + d.h / 2], se: [d.x + d.w, d.y + d.h], s: [d.x + d.w / 2, d.y + d.h],
            sw: [d.x, d.y + d.h], w: [d.x, d.y + d.h / 2],
        };
        return Object.entries(pts).map(([key, [x, y]]) => ({ key, ...toScreen(x, y) }));
    }

    function hitHandle(list, sx, sy) {
        return list.find((h) => Math.abs(h.x - sx) <= HANDLE && Math.abs(h.y - sy) <= HANDLE) || null;
    }

    function hitAnnotation(p) {
        const tol = 6 / view.scale;
        for (let i = state.annots.length - 1; i >= 0; i--) {
            const a = state.annots[i];
            if (a.type === 'arrow') {
                if (distToSegment(p.x, p.y, a.x1, a.y1, a.x2, a.y2) <= tol + a.size) return a;
            } else {
                const b = annotBounds(a);
                if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return a;
            }
        }
        return null;
    }

    // ---------- Tools ----------

    function setTool(t) {
        if (!img && t !== 'select') return;
        finishInlineEdit();
        if (cutMode && t !== 'select') exitCut();
        if (t === 'crop') {
            enterCrop();
        } else if (cropMode) {
            exitCrop(false);
        }
        tool = t;
        toolBtns.forEach((b) => {
            const on = b.dataset.tool === t;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        stage.dataset.tool = t;
        draw();
    }

    function enterCrop() {
        if (cropMode) return;
        cropMode = true;
        selectedId = null;
        renderProps();
        cropDraft = clone(cropRect());
        $('ed-crop-bar').hidden = false;
        $('ed-crop-aspect').value = 'free';
        fitView();
        draw();
    }

    function exitCrop(applyIt) {
        if (!cropMode) return;
        if (applyIt) {
            beginChange();
            const { Tw, Th } = tSize();
            const r = { x: Math.round(cropDraft.x), y: Math.round(cropDraft.y), w: Math.round(cropDraft.w), h: Math.round(cropDraft.h) };
            const c = clampRect(r, Tw, Th);
            state.crop = c && !isFull(c, Tw, Th) ? c : null;
            commitChange();
        }
        cropMode = false;
        cropDraft = null;
        $('ed-crop-bar').hidden = true;
        fitView();
        draw();
        updateOutDesc();
    }

    function cropAspect() {
        const v = $('ed-crop-aspect').value;
        if (v === 'free') return null;
        if (v === 'orig') {
            const { Tw, Th } = tSize();
            return Tw / Th;
        }
        return parseFloat(v);
    }

    function applyAspectToDraft() {
        const ar = cropAspect();
        if (!ar) return;
        const { Tw, Th } = tSize();
        const d = cropDraft;
        const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
        let w = d.w, h = w / ar;
        if (h > d.h) { h = d.h; w = h * ar; }
        // Keep it inside the image.
        w = Math.min(w, Tw); h = w / ar;
        if (h > Th) { h = Th; w = h * ar; }
        cropDraft = { x: clamp(cx - w / 2, 0, Tw - w), y: clamp(cy - h / 2, 0, Th - h), w, h };
        draw();
    }

    function newAnnotation(type, p) {
        const { Tw, Th } = tSize();
        const m = Math.min(Tw, Th);
        const st = lastStyle[type];
        const a = { id: ++annId, type, color: st.color };
        if (type === 'text') Object.assign(a, { x: p.x, y: p.y, text: '', size: Math.max(8, Math.round((st.v / 100) * m / 4)), bg: st.bg });
        else if (type === 'arrow') Object.assign(a, { x1: p.x, y1: p.y, x2: p.x, y2: p.y, size: Math.max(1, (st.v / 100) * m / 25) });
        else if (type === 'rect') Object.assign(a, { x1: p.x, y1: p.y, x2: p.x, y2: p.y, size: Math.max(1, (st.v / 100) * m / 25), fill: st.fill });
        else if (type === 'blur') Object.assign(a, { x1: p.x, y1: p.y, x2: p.x, y2: p.y, size: Math.max(2, (st.v / 100) * m / 12), soft: st.soft });
        else Object.assign(a, { x1: p.x, y1: p.y, x2: p.x, y2: p.y, size: 0 });
        return a;
    }

    // ---------- Inline text editing ----------

    function startInlineEdit(a) {
        editingId = a.id;
        const p = toScreen(a.x, a.y);
        const fontPx = a.size * view.scale;
        Object.assign(inlineText.style, {
            left: `${p.x}px`,
            top: `${p.y}px`,
            fontSize: `${fontPx}px`,
            lineHeight: String(LINE_HEIGHT),
            color: a.color,
            minWidth: `${Math.max(60, fontPx * 4)}px`,
        });
        inlineText.value = a.text;
        inlineText.hidden = false;
        autosizeInline();
        draw();
        setTimeout(() => inlineText.focus(), 0);
    }

    function autosizeInline() {
        inlineText.style.height = 'auto';
        inlineText.style.width = 'auto';
        inlineText.style.height = `${inlineText.scrollHeight}px`;
        inlineText.style.width = `${Math.min(view.cssW, inlineText.scrollWidth + 12)}px`;
    }

    function finishInlineEdit() {
        if (editingId == null) return;
        const id = editingId;
        editingId = null;
        inlineText.hidden = true;
        const a = state.annots.find((x) => x.id === id);
        if (a) {
            a.text = inlineText.value.replace(/\s+$/, '');
            if (!a.text) {
                state.annots = state.annots.filter((x) => x.id !== id);
                if (selectedId === id) selectedId = null;
            }
        }
        commitChange();
        renderProps();
        draw();
    }

    inlineText.addEventListener('input', () => {
        const a = state?.annots.find((x) => x.id === editingId);
        if (a) a.text = inlineText.value;
        autosizeInline();
        if (selectedId === editingId) $('ed-prop-text').value = inlineText.value;
    });
    inlineText.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
            e.preventDefault();
            finishInlineEdit();
            stage.focus({ preventScroll: true });
        }
    });
    inlineText.addEventListener('blur', () => finishInlineEdit());

    // ---------- Pointer handling ----------

    canvas.addEventListener('pointerdown', (e) => {
        if (!img || e.button > 0) return;
        if (editingId != null) {
            finishInlineEdit();
            return;
        }
        const r = canvas.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        const p = toT(e.clientX, e.clientY);
        canvas.setPointerCapture(e.pointerId);
        stage.focus({ preventScroll: true });

        if (cutMode) {
            drag = { kind: 'cut', p0: p };
            return;
        }

        if (cropMode) {
            const h = hitHandle(cropHandles(), sx, sy);
            const d = cropDraft;
            if (h) drag = { kind: 'crop-handle', key: h.key, start: clone(d) };
            else if (p.x >= d.x && p.x <= d.x + d.w && p.y >= d.y && p.y <= d.y + d.h) drag = { kind: 'crop-move', p0: p, start: clone(d) };
            else drag = { kind: 'crop-new', p0: p };
            return;
        }

        if (tool === 'select') {
            const sel = state.annots.find((a) => a.id === selectedId);
            const h = sel ? hitHandle(handlesFor(sel), sx, sy) : null;
            if (h) {
                beginChange();
                drag = { kind: 'handle', key: h.key, id: sel.id };
                return;
            }
            const hit = hitAnnotation(p);
            selectedId = hit ? hit.id : null;
            renderProps();
            if (hit) {
                beginChange();
                drag = { kind: 'move', id: hit.id, p0: p, start: clone(hit) };
            }
            draw();
            return;
        }

        if (tool === 'text') {
            const hit = hitAnnotation(p);
            if (hit && hit.type === 'text') {
                selectedId = hit.id;
                beginChange();
                renderProps();
                startInlineEdit(hit);
                return;
            }
            beginChange();
            const a = newAnnotation('text', p);
            state.annots.push(a);
            selectedId = a.id;
            renderProps();
            startInlineEdit(a);
            return;
        }

        // arrow, rect, highlight: drag out a new shape
        beginChange();
        const a = newAnnotation(tool, p);
        state.annots.push(a);
        drag = { kind: 'create', id: a.id, s0: { x: sx, y: sy } };
        draw();
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!img) return;
        const r = canvas.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        const p = toT(e.clientX, e.clientY);
        if (!drag) {
            updateCursor(sx, sy, p);
            return;
        }
        const { Tw, Th } = tSize();
        if (drag.kind === 'move') {
            const a = state.annots.find((x) => x.id === drag.id);
            const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
            if (a.type === 'text') { a.x = drag.start.x + dx; a.y = drag.start.y + dy; }
            else { a.x1 = drag.start.x1 + dx; a.y1 = drag.start.y1 + dy; a.x2 = drag.start.x2 + dx; a.y2 = drag.start.y2 + dy; }
        } else if (drag.kind === 'handle' || drag.kind === 'create') {
            const a = state.annots.find((x) => x.id === drag.id);
            const key = drag.kind === 'create' ? 'p2' : drag.key;
            if (a.type === 'arrow') {
                if (key === 'p1') { a.x1 = p.x; a.y1 = p.y; } else { a.x2 = p.x; a.y2 = p.y; }
            } else if (drag.kind === 'create') {
                a.x2 = p.x; a.y2 = p.y;
            } else {
                const rr = normRect(a);
                let x1 = rr.x, y1 = rr.y, x2 = rr.x + rr.w, y2 = rr.y + rr.h;
                if (key.includes('n')) y1 = p.y;
                if (key.includes('s')) y2 = p.y;
                if (key.includes('w')) x1 = p.x;
                if (key.includes('e')) x2 = p.x;
                Object.assign(a, { x1, y1, x2, y2 });
            }
        } else if (drag.kind === 'crop-move') {
            const d = drag.start;
            cropDraft = { ...d, x: clamp(d.x + p.x - drag.p0.x, 0, Tw - d.w), y: clamp(d.y + p.y - drag.p0.y, 0, Th - d.h) };
        } else if (drag.kind === 'crop-handle') {
            cropDraft = resizeCrop(drag.start, drag.key, clamp(p.x, 0, Tw), clamp(p.y, 0, Th));
        } else if (drag.kind === 'cut') {
            const r = view.region;
            const horiz = cutAxis === 'h';
            const lo = horiz ? r.y : r.x, hi = horiz ? r.y + r.h : r.x + r.w;
            cutBand = {
                axis: cutAxis,
                a: clamp(horiz ? drag.p0.y : drag.p0.x, lo, hi),
                b: clamp(horiz ? p.y : p.x, lo, hi),
            };
            updateCutBar();
        } else if (drag.kind === 'crop-new') {
            const ar = cropAspect();
            let x1 = clamp(drag.p0.x, 0, Tw), y1 = clamp(drag.p0.y, 0, Th);
            let x2 = clamp(p.x, 0, Tw), y2 = clamp(p.y, 0, Th);
            if (ar) {
                const w = Math.abs(x2 - x1);
                const h = w / ar;
                y2 = y1 + Math.sign(y2 - y1 || 1) * h;
                y2 = clamp(y2, 0, Th);
            }
            if (Math.abs(x2 - x1) > 4 && Math.abs(y2 - y1) > 4) {
                cropDraft = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
                if (ar) cropDraft.w = cropDraft.h * ar;
            }
        }
        draw();
    });

    function resizeCrop(d, key, px, py) {
        const ar = cropAspect();
        const { Tw, Th } = tSize();
        const min = 8;
        let x1 = d.x, y1 = d.y, x2 = d.x + d.w, y2 = d.y + d.h;
        if (key.includes('w')) x1 = Math.min(px, x2 - min);
        if (key.includes('e')) x2 = Math.max(px, x1 + min);
        if (key.includes('n')) y1 = Math.min(py, y2 - min);
        if (key.includes('s')) y2 = Math.max(py, y1 + min);
        if (ar) {
            let w = x2 - x1, h = y2 - y1;
            if (key === 'n' || key === 's') w = h * ar;
            else if (key === 'e' || key === 'w') h = w / ar;
            else if (w / h > ar) h = w / ar; else w = h * ar;
            // Anchor the edge or corner opposite the dragged handle.
            if (key.includes('w')) x1 = x2 - w; else if (key.includes('e')) x2 = x1 + w; else { const cx = (x1 + x2) / 2; x1 = cx - w / 2; x2 = cx + w / 2; }
            if (key.includes('n')) y1 = y2 - h; else if (key.includes('s')) y2 = y1 + h; else { const cy = (y1 + y2) / 2; y1 = cy - h / 2; y2 = cy + h / 2; }
            if (x1 < 0 || y1 < 0 || x2 > Tw || y2 > Th) return d; // would leave the image
        }
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    const endDrag = () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (d.kind === 'create') {
            const a = state.annots.find((x) => x.id === d.id);
            const tiny = a && Math.hypot((a.x2 - a.x1) * view.scale, (a.y2 - a.y1) * view.scale) < 6;
            if (tiny) {
                state.annots = state.annots.filter((x) => x.id !== d.id);
                discardChange();
            } else {
                if (a.type !== 'arrow') {
                    const r = normRect(a);
                    Object.assign(a, { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h });
                }
                selectedId = a.id;
                commitChange();
                renderProps();
            }
        } else if (d.kind === 'move' || d.kind === 'handle') {
            commitChange();
        }
        draw();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('dblclick', (e) => {
        if (!img || cropMode) return;
        const hit = hitAnnotation(toT(e.clientX, e.clientY));
        if (hit && hit.type === 'text') {
            selectedId = hit.id;
            beginChange();
            renderProps();
            startInlineEdit(hit);
        }
    });

    function updateCursor(sx, sy, p) {
        let cur = 'default';
        if (cutMode) {
            cur = cutAxis === 'h' ? 'row-resize' : 'col-resize';
        } else if (cropMode) {
            const h = hitHandle(cropHandles(), sx, sy);
            const d = cropDraft;
            if (h) cur = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }[h.key];
            else if (p.x >= d.x && p.x <= d.x + d.w && p.y >= d.y && p.y <= d.y + d.h) cur = 'move';
            else cur = 'crosshair';
        } else if (tool === 'select') {
            const sel = state.annots.find((a) => a.id === selectedId);
            if (sel && hitHandle(handlesFor(sel), sx, sy)) cur = 'pointer';
            else if (hitAnnotation(p)) cur = 'move';
        } else if (tool === 'text') {
            cur = 'text';
        } else {
            cur = 'crosshair';
        }
        canvas.style.cursor = cur;
    }

    // ---------- Keyboard ----------

    root.addEventListener('keydown', (e) => {
        if (!img || root.hidden) return;
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === 'z' || e.key === 'Z')) {
            if (typing) return;
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
            return;
        }
        if (mod && (e.key === 'y' || e.key === 'Y')) {
            if (typing) return;
            e.preventDefault();
            redo();
            return;
        }
        if (typing || mod || e.altKey) return;
        if (e.key === 'Escape') {
            if (cutMode) exitCut();
            else if (cropMode) setTool('select');
            else { selectedId = null; renderProps(); draw(); }
            return;
        }
        if (e.key === 'Enter' && cropMode) {
            e.preventDefault();
            exitCrop(true);
            setTool('select');
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId != null) {
            e.preventDefault();
            deleteSelected();
            return;
        }
        if (selectedId != null && e.key.startsWith('Arrow')) {
            e.preventDefault();
            const a = state.annots.find((x) => x.id === selectedId);
            const step = (e.shiftKey ? 10 : 1) / view.scale;
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            beginChange();
            if (a.type === 'text') { a.x += dx; a.y += dy; } else { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; }
            commitChange();
            draw();
            return;
        }
        const map = { v: 'select', c: 'crop', t: 'text', a: 'arrow', b: 'rect', h: 'highlight', r: 'blur' };
        const k = map[e.key.toLowerCase()];
        if (k) {
            e.preventDefault();
            setTool(k);
        }
    });

    function deleteSelected() {
        if (selectedId == null) return;
        beginChange();
        state.annots = state.annots.filter((a) => a.id !== selectedId);
        selectedId = null;
        commitChange();
        renderProps();
        draw();
    }

    // ---------- Properties panel ----------

    const TYPE_LABEL = { text: 'Text', arrow: 'Arrow', rect: 'Box', highlight: 'Highlight', blur: 'Blur' };
    const SIZE_DIV = { text: 4, arrow: 25, rect: 25, blur: 12 };

    function sizeToSlider(a) {
        const { Tw, Th } = tSize();
        const m = Math.min(Tw, Th);
        return Math.round(a.size / (m / SIZE_DIV[a.type]) * 100);
    }

    function renderProps() {
        const a = state?.annots.find((x) => x.id === selectedId);
        const panel = $('ed-props');
        panel.hidden = !a;
        if (!a) return;
        $('ed-props-title').textContent = `Selected: ${TYPE_LABEL[a.type]}`;
        const isText = a.type === 'text';
        $('ed-prop-text').hidden = !isText;
        $('ed-prop-text-label').hidden = !isText;
        if (isText && document.activeElement !== $('ed-prop-text')) $('ed-prop-text').value = a.text;
        $('ed-prop-size-row').hidden = a.type === 'highlight';
        $('ed-prop-size-label').textContent = isText ? 'Text size' : a.type === 'blur' ? 'Strength' : 'Line width';
        $('ed-prop-size').value = String(clamp(sizeToSlider(a), 1, 100));
        $('ed-prop-size-val').textContent = `${Math.round(a.size)} px`;
        $('ed-prop-fill-row').hidden = a.type !== 'rect';
        $('ed-prop-fill').checked = !!a.fill;
        $('ed-prop-bg-row').hidden = !isText;
        $('ed-prop-soft-row').hidden = a.type !== 'blur';
        $('ed-prop-soft').checked = !!a.soft;
        $('ed-prop-blur-note').hidden = a.type !== 'blur';
        root.querySelector('.swatches').hidden = a.type === 'blur';
        $('ed-prop-color-label').hidden = a.type === 'blur';
        $('ed-prop-bg').checked = !!a.bg;
        root.querySelectorAll('.swatch').forEach((s) => {
            const on = s.dataset.color.toLowerCase() === a.color.toLowerCase();
            s.classList.toggle('is-active', on);
            s.setAttribute('aria-pressed', String(on));
        });
    }

    function selected() {
        return state?.annots.find((x) => x.id === selectedId);
    }

    root.querySelectorAll('.swatch').forEach((s) => {
        s.addEventListener('click', () => {
            const a = selected();
            if (!a) return;
            beginChange();
            a.color = s.dataset.color;
            lastStyle[a.type].color = a.color;
            commitChange();
            renderProps();
            draw();
        });
    });
    $('ed-prop-size').addEventListener('input', () => {
        const a = selected();
        if (!a) return;
        beginChange();
        const v = Number($('ed-prop-size').value);
        const { Tw, Th } = tSize();
        const m = Math.min(Tw, Th);
        const sz = (v / 100) * m / SIZE_DIV[a.type];
        a.size = a.type === 'text' ? Math.max(6, Math.round(sz)) : Math.max(a.type === 'blur' ? 2 : 1, sz);
        lastStyle[a.type].v = v;
        $('ed-prop-size-val').textContent = `${Math.round(a.size)} px`;
        draw();
    });
    $('ed-prop-size').addEventListener('change', commitChange);
    $('ed-prop-text').addEventListener('input', () => {
        const a = selected();
        if (!a || a.type !== 'text') return;
        beginChange();
        a.text = $('ed-prop-text').value;
        draw();
    });
    $('ed-prop-text').addEventListener('change', () => {
        const a = selected();
        if (a && a.type === 'text' && !a.text.trim()) deleteSelected();
        else commitChange();
    });
    $('ed-prop-fill').addEventListener('change', () => {
        const a = selected();
        if (!a) return;
        beginChange();
        a.fill = $('ed-prop-fill').checked;
        lastStyle.rect.fill = a.fill;
        if (a.fill && a.color === '#e11d48') a.color = '#111111';
        commitChange();
        renderProps();
        draw();
    });
    $('ed-prop-bg').addEventListener('change', () => {
        const a = selected();
        if (!a) return;
        beginChange();
        a.bg = $('ed-prop-bg').checked;
        lastStyle.text.bg = a.bg;
        commitChange();
        draw();
    });
    $('ed-prop-soft').addEventListener('change', () => {
        const a = selected();
        if (!a) return;
        beginChange();
        a.soft = $('ed-prop-soft').checked;
        lastStyle.blur.soft = a.soft;
        commitChange();
        draw();
    });
    $('ed-prop-delete').addEventListener('click', deleteSelected);

    // ---------- Side controls ----------

    function syncControls() {
        for (const [k, el] of Object.entries(sliders)) {
            el.value = String(state.adjust[k]);
            $(`ed-${k}-val`).textContent = String(state.adjust[k]);
        }
        straighten.value = String(Math.round(state.tf.straighten * 10));
        $('ed-straighten-val').textContent = `${state.tf.straighten.toFixed(1)}°`;
        const f = state.adjust.filter || 'none';
        filterChips.forEach((c) => {
            const on = c.dataset.filter === f;
            c.classList.toggle('is-active', on);
            c.setAttribute('aria-pressed', String(on));
        });
    }

    filterChips.forEach((chip) => chip.addEventListener('click', () => {
        if (!img) return;
        beginChange();
        state.adjust.filter = chip.dataset.filter;
        commitChange();
        syncControls();
        photoDirty = true;
        draw();
    }));

    // ---------- Baked canvas operations: cut out a strip, add a border ----------

    /**
     * Render the current geometry (rotation, flip, straighten, crop) at full resolution, let
     * `op` build a new image from it, and make that the new source. Adjustments and
     * annotations stay live; annotations are moved with `op`'s coordinate map.
     */
    function bake(op) {
        const r = cropRect();
        const { M } = tfInfo(state.tf);
        const w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
        if (w * h > MAX_OUTPUT_PIXELS) throw new Error('This image is too large for that operation.');
        const base = createCanvas(w, h);
        const bc = base.getContext('2d');
        bc.setTransform(...mul(translate(-r.x, -r.y), M));
        bc.imageSmoothingEnabled = true;
        bc.imageSmoothingQuality = 'high';
        bc.drawImage(src().source, 0, 0);
        // Bake the current colour adjustments too, so new borders keep exactly the chosen colour.
        const bakedAdjust = hasAdjustments(state.adjust);
        if (bakedAdjust) {
            bc.setTransform(1, 0, 0, 1, 0, 0);
            const id = bc.getImageData(0, 0, w, h);
            adjustPixels(id, state.adjust);
            bc.putImageData(id, 0, 0);
        }
        const res = op(base);
        if (res.canvas !== base) releaseCanvas(base);
        const map = (x, y) => res.map(x - r.x, y - r.y);
        beginChange();
        sources.push(makeSource(res.canvas, res.canvas.width, res.canvas.height));
        state.src = sources.length - 1;
        state.tf = { rot: 0, flipH: false, flipV: false, straighten: 0 };
        state.crop = null;
        if (bakedAdjust) state.adjust = { ...DEFAULT_ADJUST };
        state.annots = state.annots.map((a0) => {
            const a = clone(a0);
            if (a.type === 'text') {
                const q = map(a0.x, a0.y);
                a.x = q.x; a.y = q.y;
            } else {
                const p1 = map(a0.x1, a0.y1), p2 = map(a0.x2, a0.y2);
                Object.assign(a, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
            }
            return a;
        });
        commitChange();
        syncControls();
        photoDirty = true;
        fitView();
        draw();
        updateOutDesc();
    }

    function addBorder(top, right, bottom, left, color) {
        bake((base) => {
            const out = createCanvas(base.width + left + right, base.height + top + bottom);
            const c = out.getContext('2d');
            c.fillStyle = color;
            c.fillRect(0, 0, out.width, out.height);
            c.drawImage(base, left, top);
            return { canvas: out, map: (x, y) => ({ x: x + left, y: y + top }) };
        });
    }

    $('ed-border-btn').addEventListener('click', () => {
        if (!img) return;
        const p = Math.max(1, Math.min(2000, parseInt($('ed-border').value, 10) || 0));
        try {
            finishInlineEdit();
            addBorder(p, p, p, p, $('ed-border-color').value);
        } catch (err) {
            toast(err.message || String(err), 'error');
        }
    });
    $('ed-square-btn').addEventListener('click', () => {
        if (!img) return;
        finishInlineEdit();
        const r = cropRect();
        const w = Math.round(r.w), h = Math.round(r.h);
        if (w === h) {
            toast('The image is already square.', 'info');
            return;
        }
        const side = Math.max(w, h);
        const left = Math.floor((side - w) / 2), top = Math.floor((side - h) / 2);
        try {
            addBorder(top, side - w - left, side - h - top, left, $('ed-border-color').value);
        } catch (err) {
            toast(err.message || String(err), 'error');
        }
    });

    const cutAxisBtns = Array.from(root.querySelectorAll('[data-cutaxis]'));
    let cutAxis = 'h';
    cutAxisBtns.forEach((b) => b.addEventListener('click', () => {
        cutAxis = b.dataset.cutaxis;
        cutAxisBtns.forEach((x) => {
            const on = x === b;
            x.classList.toggle('is-active', on);
            x.setAttribute('aria-pressed', String(on));
        });
        cutBand = null;
        updateCutBar();
        draw();
    }));

    function enterCut() {
        if (!img) return;
        setTool('select');
        selectedId = null;
        renderProps();
        cutMode = true;
        cutBand = null;
        $('ed-cut-bar').hidden = false;
        updateCutBar();
        draw();
    }

    function exitCut() {
        cutMode = false;
        cutBand = null;
        $('ed-cut-bar').hidden = true;
        draw();
    }

    function updateCutBar() {
        const ok = cutBand && Math.abs(cutBand.b - cutBand.a) >= 1;
        $('ed-cut-apply').disabled = !ok;
        $('ed-cut-size').textContent = ok ? `${Math.round(Math.abs(cutBand.b - cutBand.a))} px ${cutBand.axis === 'h' ? 'tall' : 'wide'}` : '';
    }

    function applyCut() {
        if (!cutBand) return;
        const r = cropRect();
        const horiz = cutBand.axis === 'h';
        // Band edges relative to the visible (cropped) image.
        const a = Math.round(Math.min(cutBand.a, cutBand.b) - (horiz ? r.y : r.x));
        const b = Math.round(Math.max(cutBand.a, cutBand.b) - (horiz ? r.y : r.x));
        const removed = b - a;
        const full = horiz ? Math.round(r.h) : Math.round(r.w);
        if (removed < 1 || removed >= full) {
            toast('Mark a strip that leaves some of the image.', 'warn');
            return;
        }
        try {
            bake((base) => {
                const W = base.width, H = base.height;
                const out = horiz ? createCanvas(W, H - removed) : createCanvas(W - removed, H);
                const c = out.getContext('2d');
                if (horiz) {
                    if (a > 0) c.drawImage(base, 0, 0, W, a, 0, 0, W, a);
                    if (H - b > 0) c.drawImage(base, 0, b, W, H - b, 0, a, W, H - b);
                } else {
                    if (a > 0) c.drawImage(base, 0, 0, a, H, 0, 0, a, H);
                    if (W - b > 0) c.drawImage(base, b, 0, W - b, H, a, 0, W - b, H);
                }
                const shift = (v) => (v <= a ? v : v >= b ? v - removed : a);
                return { canvas: out, map: (x, y) => (horiz ? { x, y: shift(y) } : { x: shift(x), y }) };
            });
            toast(`Removed a ${removed} px strip.`, 'ok');
        } catch (err) {
            toast(err.message || String(err), 'error');
        }
        exitCut();
    }

    function drawCutOverlay() {
        if (!cutBand) return;
        const r = view.region;
        const horiz = cutBand.axis === 'h';
        const lo = Math.min(cutBand.a, cutBand.b), hi = Math.max(cutBand.a, cutBand.b);
        const p1 = horiz ? toScreen(r.x, lo) : toScreen(lo, r.y);
        const p2 = horiz ? toScreen(r.x + r.w, hi) : toScreen(hi, r.y + r.h);
        ctx.save();
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        ctx.fillStyle = 'rgba(220, 38, 38, 0.35)';
        ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        if (horiz) {
            ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p1.y);
            ctx.moveTo(p1.x, p2.y); ctx.lineTo(p2.x, p2.y);
        } else {
            ctx.moveTo(p1.x, p1.y); ctx.lineTo(p1.x, p2.y);
            ctx.moveTo(p2.x, p1.y); ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.restore();
    }

    $('ed-cut-btn').addEventListener('click', enterCut);
    $('ed-cut-cancel').addEventListener('click', exitCut);
    $('ed-cut-apply').addEventListener('click', applyCut);

    for (const [k, el] of Object.entries(sliders)) {
        el.addEventListener('input', () => {
            if (!img) return;
            beginChange();
            state.adjust[k] = Number(el.value);
            $(`ed-${k}-val`).textContent = el.value;
            photoDirty = true;
            draw();
        });
        el.addEventListener('change', commitChange);
    }
    $('ed-reset-adjust').addEventListener('click', () => {
        beginChange();
        state.adjust = { ...DEFAULT_ADJUST };
        commitChange();
        syncControls();
        photoDirty = true;
        draw();
    });

    straighten.addEventListener('input', () => {
        if (!img) return;
        beginChange();
        const deg = Number(straighten.value) / 10;
        $('ed-straighten-val').textContent = `${deg.toFixed(1)}°`;
        setTransform({ ...state.tf, straighten: deg });
    });
    straighten.addEventListener('change', commitChange);
    straighten.addEventListener('dblclick', () => {
        beginChange();
        setTransform({ ...state.tf, straighten: 0 });
        commitChange();
        syncControls();
    });

    function discreteGeom(fn) {
        if (!img) return;
        finishInlineEdit();
        beginChange();
        const tf = { ...state.tf };
        fn(tf);
        setTransform(tf);
        commitChange();
    }
    $('ed-rot-left').addEventListener('click', () => discreteGeom((tf) => { tf.rot = (tf.rot + 270) % 360; }));
    $('ed-rot-right').addEventListener('click', () => discreteGeom((tf) => { tf.rot = (tf.rot + 90) % 360; }));
    $('ed-flip-h').addEventListener('click', () => discreteGeom((tf) => {
        // Mirror on screen: in source terms that is a horizontal flip when not rotated 90/270.
        if (tf.rot % 180 === 0) tf.flipH = !tf.flipH; else tf.flipV = !tf.flipV;
        tf.straighten = -tf.straighten;
    }));
    $('ed-flip-v').addEventListener('click', () => discreteGeom((tf) => {
        if (tf.rot % 180 === 0) tf.flipV = !tf.flipV; else tf.flipH = !tf.flipH;
        tf.straighten = -tf.straighten;
    }));

    toolBtns.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('ed-undo').addEventListener('click', undo);
    $('ed-redo').addEventListener('click', redo);
    $('ed-crop-apply').addEventListener('click', () => { exitCrop(true); setTool('select'); });
    $('ed-crop-cancel').addEventListener('click', () => setTool('select'));
    $('ed-crop-aspect').addEventListener('change', applyAspectToDraft);

    function setOutFormat(f) {
        outFormat = f;
        fmtBtns.forEach((b) => {
            const on = b.dataset.edformat === f;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        $('ed-quality-row').hidden = f === 'png';
        updateOutDesc();
    }
    fmtBtns.forEach((b) => b.addEventListener('click', () => setOutFormat(b.dataset.edformat)));
    $('ed-quality').addEventListener('input', () => { $('ed-quality-val').textContent = $('ed-quality').value; });
    $('ed-max-side').addEventListener('input', updateOutDesc);

    // ---------- Export ----------

    function outputSize() {
        const r = cropRect();
        let w = Math.round(r.w), h = Math.round(r.h);
        const maxSide = parseInt($('ed-max-side').value, 10);
        let k = 1;
        if (maxSide > 0 && Math.max(w, h) > maxSide) {
            k = maxSide / Math.max(r.w, r.h);
            w = Math.max(1, Math.round(r.w * k));
            h = Math.max(1, Math.round(r.h * k));
        }
        return { w, h, k };
    }

    function updateOutDesc() {
        if (!img) {
            $('ed-out-desc').textContent = '';
            return;
        }
        const { w, h } = outputSize();
        $('ed-out-desc').textContent = `Saves ${w} × ${h} px as ${FORMATS[outFormat].label}.`;
    }

    /** Render the edited image at full resolution. Caller releases the canvas. */
    function renderFinal(forceAlpha = false) {
        const { w, h } = outputSize();
        if (w * h > MAX_OUTPUT_PIXELS) throw new Error(`${w} × ${h} px is too large to export in the browser. Set a smaller longest side.`);
        const r = cropRect();
        const { M } = tfInfo(state.tf);
        const out = createCanvas(w, h);
        const c = out.getContext('2d');
        if (!forceAlpha && !FORMATS[outFormat].alpha) {
            c.fillStyle = '#ffffff';
            c.fillRect(0, 0, w, h);
        }
        const view2out = mul(scaleM(w / r.w, h / r.h), translate(-r.x, -r.y));
        // Downscaling a lot in one draw aliases; pre-shrink the source when the output is much smaller.
        let source = src().source, srcScale = 1, temp = null;
        const k = Math.sqrt((w / r.w) * (h / r.h));
        if (k < 0.5) {
            srcScale = Math.min(1, k * 2);
            temp = drawScaled(src().source, src().width * srcScale, src().height * srcScale);
            source = temp;
        }
        c.save();
        c.setTransform(...mul(view2out, mul(M, scaleM(1 / srcScale))));
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(source, 0, 0);
        c.restore();
        if (temp) releaseCanvas(temp);
        const adj = state.adjust;
        if (hasAdjustments(adj)) {
            const id = c.getImageData(0, 0, w, h);
            adjustPixels(id, adj);
            c.putImageData(id, 0, 0);
        }
        paintAnnotations(c, view2out, r, state.annots);
        return out;
    }

    function settleForExport() {
        finishInlineEdit();
        if (cropMode) {
            exitCrop(true);
            setTool('select');
        }
    }

    async function exportImage() {
        if (!img) return;
        settleForExport();
        const btn = $('ed-download');
        btn.disabled = true;
        try {
            const out = renderFinal();
            const { width: w, height: h } = out;
            const bytes = await encodeCanvas(out, { format: outFormat, quality: Number($('ed-quality').value) / 100 });
            releaseCanvas(out);
            downloadBlob(bytes, `${baseName(img.name)}_edited.${FORMATS[outFormat].ext}`, FORMATS[outFormat].mime);
            toast(`Saved ${w} × ${h} px ${FORMATS[outFormat].label}.`, 'ok');
        } catch (err) {
            toast(err.message || String(err), 'error');
        } finally {
            btn.disabled = !img;
        }
    }

    async function copyImage() {
        if (!img) return;
        settleForExport();
        if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
            toast('This browser can\'t copy images. Use Download instead.', 'warn');
            return;
        }
        try {
            // Clipboards only reliably accept PNG. Pass a promise so Safari keeps the user gesture.
            const blob = new Promise((resolve, reject) => {
                try {
                    const out = renderFinal(true);
                    out.toBlob((b) => {
                        releaseCanvas(out);
                        b ? resolve(b) : reject(new Error('Could not create the image.'));
                    }, 'image/png');
                } catch (err) {
                    reject(err);
                }
            });
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            toast('Copied. Paste it into a chat, email or document.', 'ok');
        } catch (err) {
            toast(err?.message ? `Couldn't copy: ${err.message}` : 'Couldn\'t copy the image.', 'error');
        }
    }
    $('ed-copy').addEventListener('click', copyImage);

    $('ed-reset-all').addEventListener('click', () => {
        if (!img) return;
        finishInlineEdit();
        if (cropMode) exitCrop(false);
        if (cutMode) exitCut();
        beginChange();
        state = { tf: { rot: 0, flipH: false, flipV: false, straighten: 0 }, crop: null, adjust: { ...DEFAULT_ADJUST }, annots: [], src: 0 };
        commitChange();
        restore(state);
        setTool('select');
        toast('All changes reset. Undo brings them back.', 'info');
    });

    $('ed-download').addEventListener('click', exportImage);

    // ---------- Loading ----------

    async function loadFile(file) {
        try {
            const dec = await decodeImage(file);
            finishInlineEdit();
            for (const sItem of sources) {
                if (sItem.preview !== sItem.source) releaseCanvas(sItem.preview);
                releaseSource(sItem.source);
            }
            sources = [makeSource(dec.source, dec.width, dec.height)];
            img = { name: file.name || 'image.png', type: file.type || '' };
            cutMode = false;
            cutBand = null;
            $('ed-cut-bar').hidden = true;
            state = { tf: { rot: 0, flipH: false, flipV: false, straighten: 0 }, crop: null, adjust: { ...DEFAULT_ADJUST }, annots: [], src: 0 };
            undoStack = [];
            redoStack = [];
            pending = null;
            geomBase = null;
            selectedId = null;
            cropMode = false;
            cropDraft = null;
            $('ed-crop-bar').hidden = true;
            $('ed-empty').hidden = true;
            canvas.hidden = false;
            $('ed-file-label').textContent = `${img.name} · ${dec.width} × ${dec.height} px`;
            [...geomButtons, straighten, ...Object.values(sliders), $('ed-reset-adjust'), $('ed-download'), $('ed-copy'), $('ed-reset-all'), ...filterChips, ...canvasButtons].forEach((el) => { el.disabled = false; });
            setOutFormat(file.type === 'image/png' ? 'png' : file.type === 'image/webp' && webpOk ? 'webp' : 'jpg');
            syncControls();
            renderProps();
            updateHistoryButtons();
            setTool('select');
            requestAnimationFrame(() => {
                fitView();
                draw();
            });
            updateOutDesc();
        } catch (err) {
            toast(err.message || String(err), 'error');
        }
    }

    function handleFiles(files) {
        if (files.length) loadFile(files[0]);
    }

    function makeSource(source, width, height) {
        const longest = Math.max(width, height);
        const previewScale = longest > PREVIEW_MAX ? PREVIEW_MAX / longest : 1;
        const preview = previewScale < 1 ? drawScaled(source, width * previewScale, height * previewScale) : source;
        return { source, width, height, preview, previewScale };
    }

    wireDropzone($('ed-empty'), input, handleFiles);
    $('ed-open-btn').addEventListener('click', () => input.click());
    $('ed-sample-btn').addEventListener('click', async () => loadFile(await makeLandscapeSample()));
    stage.addEventListener('dragover', (e) => e.preventDefault());
    stage.addEventListener('drop', (e) => {
        if (!img) return; // the empty-state drop zone handles it
        e.preventDefault();
        const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type) || /\.(heic|heif)$/i.test(x.name));
        if (f) loadFile(f);
    });

    new ResizeObserver(() => {
        if (!root.hidden && img && fitView()) draw();
    }).observe(stage);
    new MutationObserver(() => draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    setOutFormat('jpg');
    $('ed-quality-val').textContent = $('ed-quality').value;

    return {
        handleFiles,
        loadFile,
        onShow() {
            requestAnimationFrame(() => { if (img && fitView()) draw(); });
        },
    };
}

