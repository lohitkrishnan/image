// A reorderable list of images shared by the Images to PDF, Merge and GIF workspaces.
// Each item keeps a thumbnail (for the list) and a mid-size preview (for live previews);
// full-resolution pixels are decoded again only when the final file is made.

import { formatBytes, escapeHtml, decodeImage, releaseSource, drawScaled, releaseCanvas } from './image-io.js';

const PREVIEW_MAX = 900;
let uid = 0;

export function createImageList({ container, toast, onChange, label = 'image' }) {
    const items = [];
    let dragId = null;
    let busy = 0;

    function emit() {
        render();
        onChange?.(items);
    }

    async function add(files) {
        busy++;
        try {
            for (const file of files) {
                try {
                    const dec = await decodeImage(file);
                    const k = Math.min(1, PREVIEW_MAX / Math.max(dec.width, dec.height));
                    const preview = drawScaled(dec.source, dec.width * k, dec.height * k);
                    const tk = Math.min(1, 200 / Math.max(dec.width, dec.height));
                    const tc = drawScaled(preview, dec.width * tk, dec.height * tk);
                    const thumbBlob = await new Promise((r) => tc.toBlob(r, 'image/jpeg', 0.8));
                    releaseCanvas(tc);
                    releaseSource(dec.source);
                    items.push({
                        id: ++uid, file, name: file.name || 'image.png', size: file.size,
                        width: dec.width, height: dec.height, preview,
                        thumb: thumbBlob ? URL.createObjectURL(thumbBlob) : '',
                    });
                    emit();
                } catch (err) {
                    toast(err.message || String(err), 'error');
                }
            }
        } finally {
            busy--;
            emit();
        }
    }

    function remove(id) {
        const i = items.findIndex((x) => x.id === id);
        if (i < 0) return;
        const [it] = items.splice(i, 1);
        if (it.thumb) URL.revokeObjectURL(it.thumb);
        releaseCanvas(it.preview);
        emit();
    }

    function move(id, delta) {
        const i = items.findIndex((x) => x.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= items.length) return;
        [items[i], items[j]] = [items[j], items[i]];
        emit();
        container.querySelector(`[data-id="${id}"] [data-act="${delta < 0 ? 'left' : 'right'}"]`)?.focus();
    }

    function clear() {
        for (const it of items) {
            if (it.thumb) URL.revokeObjectURL(it.thumb);
            releaseCanvas(it.preview);
        }
        items.length = 0;
        emit();
    }

    function reverse() {
        items.reverse();
        emit();
    }

    function sortByName() {
        items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        emit();
    }

    // ---------- Reordering helpers ----------

    function isBefore(li, clientX) {
        const r = li.getBoundingClientRect();
        return clientX < r.left + r.width / 2;
    }

    function clearMarkers() {
        container.querySelectorAll('.is-drop-before, .is-drop-after').forEach((x) => x.classList.remove('is-drop-before', 'is-drop-after'));
    }

    function markTarget(li, clientX) {
        const before = isBefore(li, clientX);
        if (li.classList.contains(before ? 'is-drop-before' : 'is-drop-after')) return;
        clearMarkers();
        li.classList.add(before ? 'is-drop-before' : 'is-drop-after');
    }

    /** Move item `id` to just before or after item `targetId`. */
    function moveTo(id, targetId, before) {
        if (id === targetId) return;
        const from = items.findIndex((x) => x.id === id);
        if (from < 0) return;
        const [moved] = items.splice(from, 1);
        let to = items.findIndex((x) => x.id === targetId);
        if (to < 0) {
            items.splice(from, 0, moved);
            return;
        }
        if (!before) to += 1;
        items.splice(to, 0, moved);
        emit();
    }

    // Touch screens have no drag and drop: press and hold a thumbnail, then slide it.
    function wireTouchDrag(li, it) {
        let timer = 0, active = false, startX = 0, startY = 0, target = null, before = false, scrollTimer = 0;
        const cancel = () => {
            clearTimeout(timer);
            clearInterval(scrollTimer);
            timer = 0;
            scrollTimer = 0;
            if (active) {
                li.classList.remove('is-dragging');
                clearMarkers();
            }
            active = false;
            target = null;
        };
        li.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || e.target.closest('button')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            timer = setTimeout(() => {
                active = true;
                li.classList.add('is-dragging');
                navigator.vibrate?.(15);
            }, 350);
        }, { passive: true });
        li.addEventListener('touchmove', (e) => {
            const t = e.touches[0];
            if (!active) {
                // Moving before the hold completes means the user is scrolling.
                if (Math.hypot(t.clientX - startX, t.clientY - startY) > 8) cancel();
                return;
            }
            e.preventDefault();
            const el = document.elementFromPoint(t.clientX, t.clientY)?.closest('.il-item');
            if (el && el !== li && container.contains(el)) {
                target = el;
                before = isBefore(el, t.clientX);
                markTarget(el, t.clientX);
            } else {
                target = null;
                clearMarkers();
            }
            // Scroll the page when the finger nears the top or bottom edge.
            clearInterval(scrollTimer);
            const edge = 70;
            const dy = t.clientY < edge ? -12 : t.clientY > window.innerHeight - edge ? 12 : 0;
            if (dy) scrollTimer = setInterval(() => window.scrollBy(0, dy), 16);
        }, { passive: false });
        li.addEventListener('touchend', () => {
            if (active && target) {
                const targetId = Number(target.dataset.id);
                const b = before;
                cancel();
                moveTo(it.id, targetId, b);
                return;
            }
            cancel();
        });
        li.addEventListener('touchcancel', cancel);
        li.addEventListener('contextmenu', (e) => { if (active || timer) e.preventDefault(); });
    }

    function render() {
        container.innerHTML = '';
        container.classList.toggle('is-empty', items.length === 0);
        items.forEach((it, i) => {
            const li = document.createElement('li');
            li.className = 'il-item';
            li.dataset.id = String(it.id);
            li.draggable = true;
            li.innerHTML = `
                <div class="il-thumb-wrap"><img class="il-thumb" src="${it.thumb}" alt="" /><span class="il-num">${i + 1}</span></div>
                <div class="il-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
                <div class="il-meta">${it.width} × ${it.height} · ${formatBytes(it.size)}</div>
                <div class="il-btns">
                    <button type="button" class="btn btn-ghost btn-xs" data-act="left" aria-label="Move ${escapeHtml(it.name)} earlier" ${i === 0 ? 'disabled' : ''}>←</button>
                    <button type="button" class="btn btn-ghost btn-xs" data-act="right" aria-label="Move ${escapeHtml(it.name)} later" ${i === items.length - 1 ? 'disabled' : ''}>→</button>
                    <button type="button" class="btn btn-ghost btn-xs" data-act="rm" aria-label="Remove ${escapeHtml(it.name)}">✕</button>
                </div>`;
            li.querySelector('[data-act="left"]').addEventListener('click', () => move(it.id, -1));
            li.querySelector('[data-act="right"]').addEventListener('click', () => move(it.id, 1));
            li.querySelector('[data-act="rm"]').addEventListener('click', () => remove(it.id));
            li.addEventListener('dragstart', (e) => {
                dragId = it.id;
                li.classList.add('is-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(it.id));
            });
            li.addEventListener('dragend', () => {
                dragId = null;
                li.classList.remove('is-dragging');
                clearMarkers();
            });
            li.addEventListener('dragover', (e) => {
                if (dragId == null) return; // a file being dropped, not a reorder
                e.preventDefault();
                e.stopPropagation();
                markTarget(li, e.clientX);
            });
            li.addEventListener('dragleave', () => li.classList.remove('is-drop-before', 'is-drop-after'));
            li.addEventListener('drop', (e) => {
                if (dragId == null) return;
                e.preventDefault();
                e.stopPropagation();
                const before = isBefore(li, e.clientX);
                clearMarkers();
                moveTo(dragId, it.id, before);
            });
            wireTouchDrag(li, it);
            container.appendChild(li);
        });
    }

    render();

    return {
        add,
        clear,
        reverse,
        sortByName,
        get items() { return items; },
        get busy() { return busy > 0; },
    };
}
