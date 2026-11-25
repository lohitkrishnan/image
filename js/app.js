import { initResizeWorkspace } from './ws-resize.js';
import { initPhotoWorkspace } from './ws-photo.js';
import { initEditWorkspace } from './ws-edit.js';
import { initPdfWorkspace } from './ws-pdf.js';
import { initMergeWorkspace } from './ws-merge.js';
import { initGifWorkspace } from './ws-gif.js';
import { initMobileCta, wireCameraButtons } from './mobile.js';
import { imageNotices, IS_IOS } from './image-io.js';

const THEME_KEY = 'lk_image_theme';

function readPref(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function initTheme() {
    const toggleBtn = document.getElementById('theme-toggle');
    const saved = readPref(THEME_KEY);
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    let current = saved || (systemDark ? 'dark' : 'light');

    const apply = (theme) => {
        current = theme;
        document.documentElement.setAttribute('data-theme', theme);
        toggleBtn.textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
        toggleBtn.setAttribute('aria-pressed', String(theme === 'dark'));
    };
    apply(current);

    toggleBtn.addEventListener('click', () => {
        const next = current === 'dark' ? 'light' : 'dark';
        writePref(THEME_KEY, next);
        apply(next);
    });
}

function createToaster() {
    const container = document.getElementById('toast-container');
    return function toast(message, level = 'info') {
        const el = document.createElement('div');
        el.className = `toast toast-${level}`;
        el.setAttribute('role', level === 'error' ? 'alert' : 'status');
        el.textContent = message;
        container.appendChild(el);
        // Keep at most three on screen.
        while (container.children.length > 3) container.firstElementChild.remove();
        setTimeout(() => {
            el.classList.add('is-leaving');
            setTimeout(() => el.remove(), 220);
        }, level === 'error' ? 6500 : 4200);
    };
}

function initApp() {
    initTheme();
    const toast = createToaster();

    const navBtns = Array.from(document.querySelectorAll('.js-nav-tab'));
    const panels = {
        resize: document.getElementById('ws-resize'),
        photo: document.getElementById('ws-photo'),
        edit: document.getElementById('ws-edit'),
        pdf: document.getElementById('ws-pdf'),
        merge: document.getElementById('ws-merge'),
        gif: document.getElementById('ws-gif'),
    };
    let activeTab = 'resize';
    let editWs = null;
    const workspaces = {};

    function switchToTab(tab) {
        activeTab = tab;
        navBtns.forEach((b) => {
            const on = b.dataset.tab === tab;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-selected', String(on));
            b.tabIndex = on ? 0 : -1;
            if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
        for (const [key, el] of Object.entries(panels)) el.hidden = key !== tab;
        for (const [key, ws] of Object.entries(workspaces)) {
            if (key === tab) ws.onShow?.();
            else ws.onHide?.();
        }
        if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
    }

    const sendToEditor = async (file) => {
        switchToTab('edit');
        await editWs.loadFile(file);
    };

    workspaces.resize = initResizeWorkspace({ root: panels.resize, toast, sendToEditor });
    workspaces.photo = initPhotoWorkspace({ root: panels.photo, toast });
    workspaces.edit = editWs = initEditWorkspace({ root: panels.edit, toast });
    workspaces.pdf = initPdfWorkspace({ root: panels.pdf, toast });
    workspaces.merge = initMergeWorkspace({ root: panels.merge, toast });
    workspaces.gif = initGifWorkspace({ root: panels.gif, toast, sendToEditor });

    navBtns.forEach((btn, i) => {
        btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
        btn.addEventListener('keydown', (e) => {
            let next = null;
            if (e.key === 'ArrowRight') next = navBtns[(i + 1) % navBtns.length];
            else if (e.key === 'ArrowLeft') next = navBtns[(i - 1 + navBtns.length) % navBtns.length];
            else if (e.key === 'Home') next = navBtns[0];
            else if (e.key === 'End') next = navBtns[navBtns.length - 1];
            if (!next) return;
            e.preventDefault();
            switchToTab(next.dataset.tab);
            next.focus();
        });
    });

    document.addEventListener('paste', (e) => {
        const target = e.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        const files = Array.from(e.clipboardData?.files || []).filter((f) => /^image\//.test(f.type));
        if (files.length === 0) return;
        e.preventDefault();
        workspaces[activeTab]?.handleFiles(files);
    });

    // Stop the browser from opening a file dropped outside a drop zone (and losing the user's work).
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Links and the back button can change the #tab without reloading the page.
    window.addEventListener('hashchange', () => {
        const t = location.hash.slice(1);
        if (panels[t] && t !== activeTab) switchToTab(t);
    });

    const initial = location.hash.slice(1);
    switchToTab(panels[initial] ? initial : 'resize');
    initOffline(toast);
    wireCameraButtons();
    const reducedSeen = new Set();
    imageNotices.addEventListener('reduced', (e) => {
        const { name, from, to } = e.detail;
        if (reducedSeen.has(name)) return;
        reducedSeen.add(name);
        const mp = Math.round((from[0] * from[1]) / 1e6);
        toast(`${name} is ${mp} MP, more than this ${IS_IOS ? 'iPhone or iPad' : 'browser'} can edit, so it was reduced to ${to[0]} × ${to[1]} px.`, 'warn');
    });
    initMobileCta();
}

// Offline support: cache the app so it opens without a connection after one visit. When a
// new version has downloaded, offer a reload instead of swapping files under the user's work.
function initOffline(toast) {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    const showUpdate = (worker) => {
        if (document.getElementById('update-banner')) return;
        const bar = document.createElement('div');
        bar.id = 'update-banner';
        bar.className = 'update-banner';
        bar.setAttribute('role', 'status');
        bar.innerHTML = '<span>A new version of Image Studio is ready.</span>';
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'btn btn-primary btn-sm';
        reload.textContent = 'Reload';
        reload.addEventListener('click', () => {
            reload.disabled = true;
            navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
            worker.postMessage('skipWaiting');
        });
        const later = document.createElement('button');
        later.type = 'button';
        later.className = 'btn btn-ghost btn-sm';
        later.textContent = 'Later';
        later.addEventListener('click', () => bar.remove());
        bar.append(reload, later);
        document.body.appendChild(bar);
    };
    window.addEventListener('load', async () => {
        try {
            const firstInstall = !navigator.serviceWorker.controller;
            const reg = await navigator.serviceWorker.register('./sw.js');
            if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
            reg.addEventListener('updatefound', () => {
                const nw = reg.installing;
                nw?.addEventListener('statechange', () => {
                    if (nw.state !== 'installed') return;
                    if (navigator.serviceWorker.controller) showUpdate(nw);
                    else if (firstInstall) toast('Image Studio is now saved for offline use on this device.', 'ok');
                });
            });
            // Look for a new version when the user comes back to a long-open tab.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') reg.update().catch(() => {});
            });
        } catch {
            // Offline support is a bonus; the app works without it.
        }
    });
}

document.addEventListener('DOMContentLoaded', initApp);
