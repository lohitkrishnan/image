import { initResizeWorkspace } from './ws-resize.js';
import { initPhotoWorkspace } from './ws-photo.js';
import { initEditWorkspace } from './ws-edit.js';
import { initPdfWorkspace } from './ws-pdf.js';
import { initMergeWorkspace } from './ws-merge.js';
import { initGifWorkspace } from './ws-gif.js';

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

    const initial = location.hash.slice(1);
    switchToTab(panels[initial] ? initial : 'resize');
}

document.addEventListener('DOMContentLoaded', initApp);
