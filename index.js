/**
 * ✦ KitsunePreset v3.2
 * ST extension: floating preset manager with chat/char bindings
 */

// NOTE: Do NOT redefine $ — ST provides jQuery globally
const KP_MODULE = 'kitsune-preset';

const KP_DEFAULTS = {
    enabled:        true,
    autoSwitch:     true,
    notify:         false,
    defaultPreset:  '',
    presetBindings: {},
    bindingMeta:    {},
    pillPos:        { corner: 'top-right', x: null, y: null },
    panelPos:       { x: null, y: null },
    docked:         false,
    useThemeColor:  false,
    pillMini:       false,
};

let KPS           = {};    // live settings reference
let kpPresets     = [];    // [{label, value}]
let kpObs         = null;  // MutationObserver
let kpLock        = false;
let kpLastApply   = 0;
let kpOptsOpen    = false;
let kpPanelOpen   = false;
let kpNotifyLast  = '';
let kpNotifyTimer = null;

// ── Logging ───────────────────────────────────────────────────────────────────
function kpLog(...a) { console.log('[✦KP]', ...a); }

// ── Save / Load ───────────────────────────────────────────────────────────────
function kpSave() {
    try { localStorage.setItem('kp_' + KP_MODULE, JSON.stringify(KPS)); } catch(e) {}
    if (!window.extension_settings) return;
    window.extension_settings[KP_MODULE] = KPS;
    if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
}

// ── Theme ─────────────────────────────────────────────────────────────────────
// CSS берёт все цвета напрямую из ST-переменных (--SmartThemeBlurTintColor и др.)
// JS только хранит флаг useThemeColor для обратной совместимости настроек
function kpApplyAccent() {
    // Ничего не делаем — CSS сам адаптируется к теме через var(--SmartTheme...)
}

// ── ST Context helpers ────────────────────────────────────────────────────────
function kpCtx() {
    try { const c = window.SillyTavern?.getContext?.(); if (c) return c; } catch(e) {}
    try { if (typeof window.getContext === 'function') return window.getContext(); } catch(e) {}
    return null;
}

function kpGetChar() {
    try {
        const c     = kpCtx();
        const chars = c?.characters || window.characters || [];
        const chid  = parseInt(c?.characterId ?? c?.characterID ?? window.this_chid);
        if (!isNaN(chid) && chid >= 0 && chars[chid]) return kpMkChar(chars[chid], chid);
        if (c?.name2 && c.name2 !== 'You') {
            const f = chars.find(x => x?.name === c.name2);
            if (f) return kpMkChar(f, chars.indexOf(f));
        }
    } catch(e) {}
    try {
        const chid  = parseInt(window.this_chid);
        const chars = window.characters || [];
        if (!isNaN(chid) && chid >= 0 && chars[chid]) return kpMkChar(chars[chid], chid);
    } catch(e) {}
    try {
        const n = jQuery('#chat_name_if_not_group_mode .ch_name').text().trim()
               || jQuery('.ch_name').first().text().trim();
        if (n) {
            const chars = window.characters || [];
            const f = chars.find(x => x?.name === n);
            if (f) return kpMkChar(f, chars.indexOf(f));
            return { name: n, avatar: null, chid: null };
        }
    } catch(e) {}
    return null;
}

function kpMkChar(c, chid) {
    const id = parseInt(chid);
    return {
        name:   c.name || `#${id}`,
        avatar: (c.avatar && c.avatar !== 'none') ? '/characters/' + c.avatar : null,
        chid:   isNaN(id) ? null : id,
    };
}

function kpGetChatId() {
    try {
        const c = kpCtx();
        if (c?.chatId)  return String(c.chatId);
        if (c?.chat_id) return String(c.chat_id);
    } catch(e) {}
    try { if (window.chat_metadata?.chat_id) return String(window.chat_metadata.chat_id); } catch(e) {}
    return null;
}

// ── Preset select ─────────────────────────────────────────────────────────────
const KP_SEL_IDS = [
    '#settings_preset_openai', '#settings_preset_openai_compat',
    '#settings_preset', '#api_preset_kobold',
    '#settings_preset_novel', '#settings_preset_textgenerationwebui',
];

function kpFindSel() {
    for (const s of KP_SEL_IDS) {
        const el = jQuery(s);
        if (el.length && el.find('option').length > 1) return el;
    }
    let found = null;
    jQuery('select').each(function() {
        const id = (jQuery(this).attr('id') || '').toLowerCase();
        if (id.includes('preset') && jQuery(this).find('option').length > 1) {
            found = jQuery(this); return false;
        }
    });
    return found;
}

function kpLoadPresets() {
    const el = kpFindSel();
    if (!el) return [];
    const out = [];
    el.find('option').each(function() {
        const t = jQuery(this).text().trim();
        if (t) out.push({ value: jQuery(this).val(), label: t });
    });
    return out;
}

function kpGetActive() {
    const el = kpFindSel();
    return el ? (el.find('option:selected').text().trim() || null) : null;
}

// ── Binding keys ──────────────────────────────────────────────────────────────
// Chat key is per-session: chat_2026-03-24@21h08m41s3
// Char key is per-character: char_5
// They are FULLY INDEPENDENT — switching chat clears chat key
function kpChatKey() { const id = kpGetChatId(); return id ? `chat_${id}` : null; }
function kpCharKey() {
    const info = kpGetChar();
    if (info?.chid != null) return `char_${info.chid}`;
    const id = parseInt(window.this_chid);
    return (!isNaN(id) && id >= 0) ? `char_${id}` : null;
}

function kpSaveMeta(key) {
    const info = kpGetChar(), chatId = kpGetChatId();
    if (!KPS.bindingMeta) KPS.bindingMeta = {};
    KPS.bindingMeta[key] = key.startsWith('char_')
        ? { name: info?.name || key, avatar: info?.avatar || null }
        : { name: chatId ? chatId.substring(0, 32) : key, charName: info?.name || '?', avatar: info?.avatar || null };
}

// Priority: chat binding > char binding > default preset
function kpResolve() {
    const ck = kpChatKey(), chk = kpCharKey();
    return (ck  && KPS.presetBindings[ck])
        || (chk && KPS.presetBindings[chk])
        || KPS.defaultPreset || null;
}

function kpBindingType() {
    const ck = kpChatKey(), chk = kpCharKey();
    if (ck  && KPS.presetBindings[ck])  return 'chat';
    if (chk && KPS.presetBindings[chk]) return 'char';
    return null;
}

// ── Apply preset ──────────────────────────────────────────────────────────────
function kpSetSel(el, val) {
    if (!el?.length) return false;
    const n = el[0];
    try {
        const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        if (d?.set) d.set.call(n, val); else n.value = val;
    } catch(e) { n.value = val; }
    el.trigger('focus').trigger('input').trigger('change');
    try { n.dispatchEvent(new Event('input',  { bubbles: true })); } catch(e) {}
    try { n.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
    return true;
}

function kpApply(name, silent) {
    if (!name) return false;
    const findOpt = el => el.find('option').filter(function() {
        return jQuery(this).text().trim() === name || jQuery(this).val() === name;
    });

    let ok = false;
    for (const s of KP_SEL_IDS) {
        const el = jQuery(s);
        if (!el.length) continue;
        const opt = findOpt(el);
        if (opt.length) { kpSetSel(el, opt.first().val()); ok = true; kpLog('✓', s, name); break; }
    }
    if (!ok) {
        jQuery('select').each(function() {
            if (ok) return false;
            if (!(jQuery(this).attr('id') || '').toLowerCase().includes('preset')) return;
            const opt = findOpt(jQuery(this));
            if (opt.length) { kpSetSel(jQuery(this), opt.first().val()); ok = true; }
        });
    }
    if (!ok) {
        for (const fn of ['applyPreset','applyOpenAIPreset','loadPreset','selectPreset']) {
            if (typeof window[fn] === 'function') {
                try { window[fn](name); ok = true; break; } catch(e) {}
            }
        }
    }

    if (ok) {
        kpLastApply = Date.now();
        kpLockSet(true);
        setTimeout(() => kpLockSet(false), 2200);
        if (!silent) kpNotify(name);
        kpRefreshPill();
        kpUpdatePanel();
    }
    return ok;
}

// Retry: ST sometimes resets select after CHAT_CHANGED
function kpApplyRetry(name) {
    if (!name) return;
    kpApply(name, true);
    setTimeout(() => { if (kpGetActive() !== name) { kpApply(name, true); kpLog('retry#1'); } }, 600);
    setTimeout(() => { if (kpGetActive() !== name) { kpApply(name, true); kpLog('retry#2'); } }, 1400);
}

function kpLockSet(v) { kpLock = v; }

// ── MutationObserver ──────────────────────────────────────────────────────────
function kpStartObs() {
    if (kpObs) { kpObs.disconnect(); kpObs = null; }
    const el = kpFindSel();
    if (!el?.length) return;
    kpObs = new MutationObserver(() => {
        if (kpLock) return;
        const need = kpResolve();
        if (!need) return;
        const have = kpGetActive();
        if (have && have !== need) {
            kpLog('[Obs] ST reset', have, '→', need);
            kpLockSet(true);
            kpApply(need, true);
            setTimeout(() => kpLockSet(false), 700);
        }
    });
    kpObs.observe(el[0], { attributes: true });
    if (el[0].parentElement) kpObs.observe(el[0].parentElement, { childList: true });
}

// ── Notify (single fire, debounced) ──────────────────────────────────────────
function kpNotify(msg) {
    if (!KPS.notify) return;
    if (kpNotifyLast === msg) return;
    clearTimeout(kpNotifyTimer);
    kpNotifyTimer = setTimeout(() => {
        kpNotifyLast = msg;
        if (typeof toastr !== 'undefined') toastr.info(msg, '✦ KitsunePreset', { timeOut: 2000 });
        setTimeout(() => { kpNotifyLast = ''; }, 4000);
    }, 350);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function kpInit() {
    if (window._kpInitDone) { kpLog('already initialized, skip'); return; }
    kpLog('init...');

    try {
        // Poll up to 5s for extension_settings
        for (let i = 0; i < 50; i++) {
            if (window.extension_settings) break;
            await new Promise(r => setTimeout(r, 100));
        }
        kpLog('ext_settings present:', !!window.extension_settings);

        if (!window.extension_settings) {
            kpLog('\u26a0 falling back to local storage');
            window.extension_settings = {};
        }

        const ext = window.extension_settings;
        if (!ext[KP_MODULE] || typeof ext[KP_MODULE] !== 'object') {
            let saved = null;
            try { saved = localStorage.getItem('kp_' + KP_MODULE); } catch(e) {}
            ext[KP_MODULE] = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(KP_DEFAULTS));
        }
        KPS = ext[KP_MODULE];

        for (const [k, v] of Object.entries(KP_DEFAULTS)) {
            if (KPS[k] === undefined)
                KPS[k] = (v !== null && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
        }
        if (!KPS.presetBindings) KPS.presetBindings = {};
        if (!KPS.bindingMeta)    KPS.bindingMeta    = {};

        kpLog('settings OK');

        await new Promise(r => setTimeout(r, 1200));
        kpPresets = kpLoadPresets();
        kpLog('presets loaded:', kpPresets.length);

        kpLog('creating pill...');   kpCreatePill();
        kpLog('creating panel...');  kpCreatePanel();
        kpLog('creating sidebar...'); kpCreateSidebar();
        kpLog('registering events...'); kpRegisterEvents();
        kpStartObs();

        if (KPS.docked) {
            await new Promise(r => setTimeout(r, 500));
            kpDock();
        }

        const need = kpResolve();
        if (need && KPS.enabled && KPS.autoSwitch) {
            await new Promise(r => setTimeout(r, 500));
            kpApplyRetry(need);
        }

        window._kpInitDone = true;
        kpLog('ready \u2713');

    } catch(err) {
        kpLog('\u274c init error:', err && err.message, err && err.stack);
    }
}

// ── Pill ──────────────────────────────────────────────────────────────────────
function kpPillStyle() {
    const p = KPS.pillPos;
    if (p.x !== null && p.y !== null) return `left:${p.x}px;top:${p.y}px`;
    const map = {
        'top-left':     'top:66px;left:12px',
        'top-right':    'top:66px;right:12px',
        'bottom-left':  'bottom:80px;left:12px',
        'bottom-right': 'bottom:80px;right:12px',
    };
    return map[p.corner] || 'top:66px;right:12px';
}

function kpCreatePill() {
    jQuery('#kp-pill').remove();
    if (KPS.docked) return;

    jQuery('body').append(`
        <div id="kp-pill" style="position:fixed;z-index:99998;${kpPillStyle()}">
            <div id="kp-pill-in">
                <div id="kp-pill-ava"></div>
                <span id="kp-pill-ico">✦</span>
                <span id="kp-pill-txt">—</span>
                <button id="kp-pill-min" title="Свернуть / развернуть">◀</button>
            </div>
        </div>`);

    kpDraggable(jQuery('#kp-pill')[0], null, pos => {
        KPS.pillPos = { x: Math.round(pos.x), y: Math.round(pos.y), corner: null };
        kpSave();
    });

    jQuery('#kp-pill-min').on('click', function(e) {
        e.stopPropagation();
        const mini = jQuery('#kp-pill').toggleClass('kp-mini').hasClass('kp-mini');
        jQuery(this).text(mini ? '▶' : '◀');
        KPS.pillMini = mini;
        kpSave();
    });
    // Restore mini state
    if (KPS.pillMini) {
        jQuery('#kp-pill').addClass('kp-mini');
        jQuery('#kp-pill-min').text('▶');
    }

    jQuery('#kp-pill').on('click', function() {
        if (!jQuery(this).data('kpdrag')) kpTogglePanel();
    });

    kpRefreshPill();
}

function kpRefreshPill() {
    if (KPS.docked) { jQuery('#kp-pill').hide(); return; }
    const name = kpResolve() || kpGetActive();
    if (!name) { jQuery('#kp-pill').hide(); return; }

    const info  = kpGetChar();
    const isDef = !kpBindingType();

    kpApplyAccent();

    // Avatar
    const avaEl = jQuery('#kp-pill-ava');
    if (info?.avatar) {
        avaEl.html(`<img src="${info.avatar}" alt=""
            onerror="this.parentElement.innerHTML='<div class=kp-pill-fb>${kpEsc((info?.name||'?').charAt(0).toUpperCase())}</div>'">`);
    } else {
        avaEl.html(`<div class="kp-pill-fb">${(info?.name||'?').charAt(0).toUpperCase()}</div>`);
    }

    jQuery('#kp-pill-ico').text(isDef ? '⚙' : '✦');
    jQuery('#kp-pill-txt').text(name);
    jQuery('#kp-pill').show();
}

// ── Panel ─────────────────────────────────────────────────────────────────────
function kpCreatePanel() {
    jQuery('#kp-float').remove();
    const p = KPS.panelPos;
    const style = (p.x !== null && p.y !== null) ? `left:${p.x}px;top:${p.y}px` : 'top:100px;right:12px';
    jQuery('body').append(`<div id="kp-float" style="position:fixed;z-index:99999;${style}"></div>`);
    kpRenderPanel();
}

function kpOpts(sel, emptyLabel) {
    let h = `<option value="">${kpEsc(emptyLabel || '— Не выбран —')}</option>`;
    kpPresets.forEach(p => {
        h += `<option value="${kpEsc(p.label)}"${sel === p.label ? ' selected' : ''}>${kpEsc(p.label)}</option>`;
    });
    return h;
}

function kpRenderPanel() {
    const info     = kpGetChar();
    const chatId   = kpGetChatId();
    const ck       = kpChatKey(), chk = kpCharKey();
    const chatBound = (ck  && KPS.presetBindings[ck])  || '';
    const charBound = (chk && KPS.presetBindings[chk]) || '';
    const cur      = kpResolve() || kpGetActive() || '';

    // Avatar
    let avaHTML = info?.avatar
        ? `<img class="kp-fp-ava" src="${info.avatar}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
           <div class="kp-fp-ava-fb" style="display:none">${info.name.charAt(0).toUpperCase()}</div>`
        : `<div class="kp-fp-ava-fb">${info ? info.name.charAt(0).toUpperCase() : '?'}</div>`;

    // Bindings — split into chats and chars tabs
    const allB    = Object.entries(KPS.presetBindings);
    const chatBs  = allB.filter(([k]) => k.startsWith('chat_'));
    const charBs  = allB.filter(([k]) => k.startsWith('char_'));

    function biRows(pairs, isChat) {
        if (!pairs.length) return '<div class="kp-bi-empty">Нет привязок</div>';
        return pairs.map(([key, preset]) => {
            const meta  = KPS.bindingMeta?.[key];
            const label = isChat
                ? (meta?.charName || key.replace('chat_','').substring(0,22))
                : (meta?.name     || key.replace('char_','#'));
            return `<div class="kp-bi-row">
                <span class="kp-bi-ic">${isChat ? '💬' : '👤'}</span>
                <span class="kp-bi-name" title="${kpEsc(key)}">${kpEsc(label)}</span>
                <span class="kp-bi-arr">›</span>
                <span class="kp-bi-preset" title="${kpEsc(preset)}">${kpEsc(preset)}</span>
            </div>`;
        }).join('');
    }

    const biChatHTML = biRows(chatBs, true);
    const biCharHTML = biRows(charBs, false);

    jQuery('#kp-float').html(`
        <div class="kp-hdr" id="kp-hdr">
            <div class="kp-hdr-bg"${info?.avatar ? ` style="background-image:url('${info.avatar}')"` : ''}></div>
            <div class="kp-hdr-ov"></div>
            <div class="kp-hdr-row">
                ${avaHTML}
                <div class="kp-hdr-info">
                    <div class="kp-hdr-name">${kpEsc(info?.name || 'Персонаж не выбран')}</div>
                    <div class="kp-hdr-chat">${kpEsc(chatId ? chatId.substring(0,30) : 'Нет чата')}</div>
                </div>
                <button class="kp-x" id="kp-x">✕</button>
            </div>
        </div>

        <div class="kp-body">
            <div class="kp-sec">
                <div class="kp-sec-lbl">✦ Пресет</div>
                <select class="kp-sel" id="kp-psel">${kpOpts(cur)}</select>
            </div>
            <div class="kp-sec">
                <div class="kp-sec-lbl">Привязать</div>
                <div class="kp-bind-row">
                    <button class="kp-bb${chatBound?' kp-bb-on':''}" id="kp-bchat"
                        title="${chatBound ? 'Привязан к чату: '+chatBound+'. Нажать → снять' : 'Привязать выбранный пресет к этому чату'}">
                        💬 ${chatBound ? kpEsc(chatBound.substring(0,13)) : 'К чату'}
                    </button>
                    <button class="kp-bb${charBound?' kp-bb-on':''}" id="kp-bchar"
                        title="${charBound ? 'Привязан к персонажу: '+charBound+'. Нажать → снять' : 'Привязать выбранный пресет к персонажу'}">
                        👤 ${charBound ? kpEsc(charBound.substring(0,13)) : 'К персонажу'}
                    </button>
                </div>
            </div>
            <div class="kp-sec">
                <div class="kp-sec-lbl">Все привязки</div>
                <div class="kp-bi-tabs">
                    <button class="kp-bi-tab kp-bi-tab-on" data-pane="kp-bi-chats">
                        💬 Чаты<span class="kp-bi-badge">${chatBs.length}</span>
                    </button>
                    <button class="kp-bi-tab" data-pane="kp-bi-chars">
                        👤 Персонажи<span class="kp-bi-badge">${charBs.length}</span>
                    </button>
                </div>
                <div class="kp-bi-pane kp-bi-pane-on" id="kp-bi-chats">
                    <div class="kp-bi-list">${biChatHTML}</div>
                </div>
                <div class="kp-bi-pane" id="kp-bi-chars">
                    <div class="kp-bi-list">${biCharHTML}</div>
                </div>
            </div>
            <div class="kp-sec">
                <div class="kp-sec-lbl">⚙ По умолчанию (для чатов без привязки)</div>
                <select class="kp-sel kp-sel-def" id="kp-dsel">${kpOpts(KPS.defaultPreset, '— Не задан —')}</select>
            </div>
        </div>

        <div class="kp-foot">
            <button class="kp-foot-btn${KPS.docked?' kp-foot-on':''}" id="kp-dock">
                📌 ${KPS.docked ? 'Открепить' : 'К чату'}
            </button>
            <button class="kp-foot-gear${kpOptsOpen?' kp-foot-gear-on':''}" id="kp-gear" title="Настройки">⚙</button>
        </div>

        <div class="kp-opts${kpOptsOpen?' kp-opts-on':''}" id="kp-opts">
            <label class="kp-opt"><input type="checkbox" id="kp-chk-auto"  ${KPS.autoSwitch?'checked':''}>    Авто-смена при переходе</label>
            <label class="kp-opt"><input type="checkbox" id="kp-chk-ntf"   ${KPS.notify?'checked':''}>        Уведомления</label>
            <label class="kp-opt"><input type="checkbox" id="kp-chk-theme" ${KPS.useThemeColor?'checked':''}> Цвет темы ST</label>
            <label class="kp-opt"><input type="checkbox" id="kp-chk-ena"   ${KPS.enabled?'checked':''}>       Включено</label>
            <button class="kp-ref-btn" id="kp-ref">⟳ Обновить пресеты</button>
        </div>
    `);

    // Header is drag handle for whole panel
    kpDraggable(jQuery('#kp-hdr')[0], jQuery('#kp-float')[0], pos => {
        if (!KPS.docked) { KPS.panelPos = { x: Math.round(pos.x), y: Math.round(pos.y) }; kpSave(); }
    });

    kpBindPanel();
    kpApplyAccent();
}

function kpUpdatePanel() {
    // Lightweight: only update preset select + bind buttons (no full re-render)
    if (!jQuery('#kp-float:visible').length && !KPS.docked) return;
    const ck = kpChatKey(), chk = kpCharKey();
    const chatBound = (ck  && KPS.presetBindings[ck])  || '';
    const charBound = (chk && KPS.presetBindings[chk]) || '';
    const cur = kpResolve() || kpGetActive() || '';

    jQuery('#kp-psel').val(cur);
    jQuery('#kp-bchat')
        .toggleClass('kp-bb-on', !!chatBound)
        .text(chatBound ? '💬 ' + chatBound.substring(0,13) : '💬 К чату');
    jQuery('#kp-bchar')
        .toggleClass('kp-bb-on', !!charBound)
        .text(charBound ? '👤 ' + charBound.substring(0,13) : '👤 К персонажу');

    // Update header avatar/name
    const info   = kpGetChar();
    const chatId = kpGetChatId();
    jQuery('.kp-hdr-name').text(info?.name || 'Персонаж не выбран');
    jQuery('.kp-hdr-chat').text(chatId ? chatId.substring(0,30) : 'Нет чата');
    if (info?.avatar) {
        jQuery('.kp-hdr-bg').css('background-image', `url('${info.avatar}')`);
        jQuery('.kp-fp-ava').attr('src', info.avatar).show();
        jQuery('.kp-fp-ava-fb').hide();
    }
}

function kpBindPanel() {
    jQuery('#kp-x').on('click', kpClosePanel);

    // Preset select → apply + auto-bind to current chat/char so it survives reload
    jQuery('#kp-psel').on('change', function() {
        const v = jQuery(this).val();
        if (!v) return;
        // Lock observer for 2s so it doesn't fight the manual selection
        kpLockSet(true);
        setTimeout(() => kpLockSet(false), 2000);
        // Auto-save as chat binding (or char binding as fallback) — silently
        const ck  = kpChatKey();
        const chk = kpCharKey();
        if (ck) {
            KPS.presetBindings[ck] = v;
            kpSaveMeta(ck);
        } else if (chk) {
            KPS.presetBindings[chk] = v;
            kpSaveMeta(chk);
        }
        kpSave();
        kpApply(v);
        kpRenderPanel(); kpRefreshPill();
    });

    // Bind to chat (toggle)
    jQuery('#kp-bchat').on('click', function() {
        const ck = kpChatKey();
        if (!ck) { kpToast('Сначала откройте чат'); return; }
        const preset = jQuery('#kp-psel').val() || kpGetActive();
        if (!preset) { kpToast('Выберите пресет'); return; }
        if (KPS.presetBindings[ck] === preset) {
            delete KPS.presetBindings[ck];
            delete KPS.bindingMeta[ck];
            kpSave(); kpRenderPanel(); kpRefreshPill();
            kpToast('Привязка к чату снята');
        } else {
            KPS.presetBindings[ck] = preset;
            kpSaveMeta(ck);
            kpSave(); kpRenderPanel(); kpRefreshPill();
            kpApply(preset);
            kpToast('💬 Чат → ' + preset);
        }
    });

    // Bind to char (toggle)
    jQuery('#kp-bchar').on('click', function() {
        const chk = kpCharKey();
        if (!chk) { kpToast('Персонаж не определён'); return; }
        const preset = jQuery('#kp-psel').val() || kpGetActive();
        if (!preset) { kpToast('Выберите пресет'); return; }
        if (KPS.presetBindings[chk] === preset) {
            delete KPS.presetBindings[chk];
            delete KPS.bindingMeta[chk];
            kpSave(); kpRenderPanel(); kpRefreshPill();
            kpToast('Привязка к персонажу снята');
        } else {
            KPS.presetBindings[chk] = preset;
            kpSaveMeta(chk);
            kpSave(); kpRenderPanel(); kpRefreshPill();
            kpApply(preset);
            kpToast('👤 Персонаж → ' + preset);
        }
    });

    // Tab switch in bindings
    jQuery(document).off('click.kpbitab').on('click.kpbitab', '.kp-bi-tab', function() {
        const pane = jQuery(this).data('pane');
        jQuery('.kp-bi-tab').removeClass('kp-bi-tab-on');
        jQuery(this).addClass('kp-bi-tab-on');
        jQuery('.kp-bi-pane').removeClass('kp-bi-pane-on');
        jQuery('#' + pane).addClass('kp-bi-pane-on');
    });

    // Default preset
    jQuery('#kp-dsel').on('change', function() {
        KPS.defaultPreset = jQuery(this).val();
        kpSave(); kpRefreshPill();
        if (KPS.defaultPreset && !kpBindingType()) kpApply(KPS.defaultPreset);
        kpToast(KPS.defaultPreset ? '⚙ Дефолт: ' + KPS.defaultPreset : 'Дефолт сброшен');
    });

    // Dock toggle
    jQuery('#kp-dock').on('click', function() {
        KPS.docked = !KPS.docked;
        kpSave();
        KPS.docked ? kpDock() : kpUndock();
    });

    // Gear
    jQuery('#kp-gear').on('click', function() {
        kpOptsOpen = !kpOptsOpen;
        jQuery('#kp-opts').toggleClass('kp-opts-on', kpOptsOpen);
        jQuery(this).toggleClass('kp-foot-gear-on', kpOptsOpen);
    });

    // Options
    jQuery('#kp-chk-auto').on('change',  function() { KPS.autoSwitch    = this.checked; kpSave(); });
    jQuery('#kp-chk-ntf').on('change',   function() { KPS.notify        = this.checked; kpSave(); });
    jQuery('#kp-chk-theme').on('change', function() {
        KPS.useThemeColor = this.checked;
        kpSave();
        kpApplyAccent(); // immediate color update
    });
    jQuery('#kp-chk-ena').on('change',   function() { KPS.enabled       = this.checked; kpSave(); });
    jQuery('#kp-ref').on('click', function() {
        kpPresets = kpLoadPresets();
        kpRenderPanel();
        kpStartObs();
        kpToast('⟳ ' + kpPresets.length + ' пресетов');
    });
}

function kpTogglePanel() {
    kpPanelOpen ? kpClosePanel() : kpOpenPanel();
}

function kpOpenPanel() {
    if (KPS.docked) return;
    kpRenderPanel();

    // Position near pill if no saved pos
    if (KPS.panelPos.x === null) {
        const pill = document.getElementById('kp-pill');
        if (pill) {
            const r = pill.getBoundingClientRect();
            jQuery('#kp-float').css({
                left:   Math.min(r.left, window.innerWidth - 295),
                top:    r.bottom + 6,
                right:  'auto',
                bottom: 'auto',
            });
        }
    }
    jQuery('#kp-float').addClass('kp-open');
    kpPanelOpen = true;

    setTimeout(() => {
        jQuery(document).one('mousedown.kpout touchstart.kpout', e => {
            if (!jQuery(e.target).closest('#kp-float,#kp-pill').length) kpClosePanel();
        });
    }, 50);
}

function kpClosePanel() {
    if (KPS.docked) return;
    jQuery('#kp-float').removeClass('kp-open');
    jQuery(document).off('mousedown.kpout touchstart.kpout');
    kpPanelOpen = false;
}

// ── Dock ──────────────────────────────────────────────────────────────────────
function kpDock() {
    KPS.docked = true;
    const panel = document.getElementById('kp-float');
    if (!panel) return;

    const chat = document.getElementById('chat');
    if (chat) {
        const last = chat.querySelector('.mes:last-child');
        if (last) chat.insertBefore(panel, last.nextSibling);
        else chat.appendChild(panel);
    } else {
        document.body.appendChild(panel);
    }

    jQuery('#kp-float')
        .removeClass('kp-open')
        .addClass('kp-docked')
        .show();
    jQuery('#kp-pill').hide();
    kpRenderPanel();
}

function kpUndock() {
    KPS.docked = false;
    const panel = document.getElementById('kp-float');
    if (!panel) return;
    document.body.appendChild(panel);

    jQuery('#kp-float').removeClass('kp-docked kp-open');
    if (KPS.panelPos.x !== null) {
        jQuery('#kp-float').css({ left: KPS.panelPos.x, top: KPS.panelPos.y, right: 'auto', bottom: 'auto' });
    } else {
        jQuery('#kp-float').css({ top: '100px', right: '12px', left: 'auto' });
    }

    kpCreatePill();
    kpRenderPanel();
}

function kpMoveDockToEnd() {
    if (!KPS.docked) return;
    const panel = document.getElementById('kp-float');
    const chat  = document.getElementById('chat');
    if (!panel || !chat) return;
    const last = chat.querySelector('.mes:last-child');
    if (last && last.nextSibling !== panel) {
        chat.insertBefore(panel, last.nextSibling);
    }
}

// ── Sidebar (mass assignment) ─────────────────────────────────────────────────
function kpCreateSidebar() {
    jQuery('#kp-settings').remove();
    jQuery('#extensions_settings2').append(`
    <div id="kp-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>✦ KitsunePreset</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <!-- Hint: main controls are in the floating pill -->
          <p style="font-size:11px;opacity:.4;text-align:center;font-style:italic;margin:4px 0 8px">
            Управление — в плавающей плашке
          </p>

          <!-- Restore / Debug buttons -->
          <div style="display:flex;gap:5px;margin-bottom:10px">
            <button id="kp-sb-restore"
              style="flex:1;background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.22);border-radius:6px;
                     color:rgba(196,181,253,.8);font-size:11px;padding:5px 4px;cursor:pointer;line-height:1.3">
              🪟 Восстановить окно
            </button>
            <button id="kp-sb-reload"
              style="flex:1;background:rgba(167,139,250,.05);border:1px solid rgba(167,139,250,.15);border-radius:6px;
                     color:rgba(196,181,253,.6);font-size:11px;padding:5px 4px;cursor:pointer;line-height:1.3">
              ⟳ Перезапустить
            </button>
          </div>

          <!-- Guide memo -->
          <div style="
              background:rgba(167,139,250,.05);
              border:1px solid rgba(167,139,250,.15);
              border-radius:8px;
              padding:10px 11px;
              margin-bottom:10px;
              font-size:11px;
              line-height:1.65;
              color:rgba(196,181,253,.7)
          ">
              <div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
                          color:rgba(167,139,250,.6);margin-bottom:7px">
                  📖 Быстрый старт
              </div>
              <div style="margin-bottom:6px">
                  <span style="color:rgba(196,181,253,.9);font-weight:600">① Открыть плашку</span><br>
                  Нажми на плавающую иконку в углу экрана (перетаскивается).
              </div>
              <div style="margin-bottom:6px">
                  <span style="color:rgba(196,181,253,.9);font-weight:600">② Выбрать пресет</span><br>
                  Дропдаун <b style="color:#a78bfa">✦ Пресет</b> — выбор активного пресета вручную.
              </div>
              <div style="margin-bottom:6px">
                  <span style="color:rgba(196,181,253,.9);font-weight:600">③ Привязать к персонажу</span><br>
                  Открой чат → выбери пресет → нажми <b style="color:#a78bfa">👤 К персонажу</b>.
                  При следующем входе пресет применится сам.
              </div>
              <div style="margin-bottom:6px">
                  <span style="color:rgba(196,181,253,.9);font-weight:600">④ Привязать к чату</span><br>
                  <b style="color:#a78bfa">💬 К чату</b> — привязка к конкретному чату
                  (приоритет выше, чем у персонажа).
              </div>
              <div style="margin-bottom:8px">
                  <span style="color:rgba(196,181,253,.9);font-weight:600">⑤ Авто-смена</span><br>
                  В ⚙ включи <b>Авто-смена при переходе</b> — пресет будет меняться сам.
              </div>
              <div style="border-top:1px solid rgba(167,139,250,.12);padding-top:7px;
                          font-size:10px;color:rgba(196,181,253,.45)">
                  <b style="color:rgba(196,181,253,.6)">🔧 Отладка</b><br>
                  Плашка пропала → <b>Восстановить окно</b> выше.<br>
                  Пресет не применяется → проверь <b>Авто-смена</b> и <b>Включено</b> в ⚙.<br>
                  Что-то сломалось → нажми <b>⟳ Перезапустить</b>.<br>
                  Консоль браузера: фильтр <code style="color:#a78bfa">[✦KP]</code> для логов.
              </div>
          </div>

          <!-- Danger zone -->
          <button id="kp-sb-clr"
            style="margin-top:8px;width:100%;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.2);
                   border-radius:6px;color:rgba(252,165,165,.7);font-size:11px;padding:5px;cursor:pointer">
            🗑 Удалить все привязки
          </button>

        </div>
      </div>
    </div>`);

    jQuery('#kp-sb-clr').on('click', function() {
        if (!confirm('Удалить все привязки?')) return;
        KPS.presetBindings = {}; KPS.bindingMeta = {};
        kpSave(); kpRenderPanel(); kpRefreshPill();
    });

    // Restore floating window to default position
    jQuery('#kp-sb-restore').on('click', function() {
        KPS.docked    = false;
        KPS.panelPos  = { x: null, y: null };
        KPS.pillPos   = { corner: 'top-right', x: null, y: null };
        kpSave();
        // Re-attach panel to body and reset position
        const panel = document.getElementById('kp-float');
        if (panel) {
            document.body.appendChild(panel);
            jQuery('#kp-float')
                .removeClass('kp-docked kp-open')
                .css({ top: '80px', right: '12px', left: 'auto', bottom: 'auto' });
        }
        kpCreatePill();
        kpRenderPanel();
        kpRefreshPill();
        kpToast('Окно восстановлено');
    });

    // Soft reload: destroy & re-init everything
    jQuery('#kp-sb-reload').on('click', function() {
        jQuery('#kp-pill, #kp-float').remove();
        kpObs?.disconnect(); kpObs = null;
        kpInit();
        kpToast('KitsunePreset перезапущен');
    });
}


// ── Draggable ─────────────────────────────────────────────────────────────────
function kpDraggable(handle, moveEl, onEnd) {
    const target = moveEl || handle;
    let ox, oy, ex, ey, moved = false;

    function startDrag(clientX, clientY) {
        moved = false;
        const r = target.getBoundingClientRect();
        ox = clientX; oy = clientY; ex = r.left; ey = r.top;
    }
    function moveDrag(clientX, clientY) {
        const dx = clientX - ox, dy = clientY - oy;
        if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) moved = true;
        if (!moved) return;
        jQuery(target).css({
            left:   Math.max(0, Math.min(window.innerWidth  - target.offsetWidth,  ex + dx)),
            top:    Math.max(0, Math.min(window.innerHeight - target.offsetHeight, ey + dy)),
            right: 'auto', bottom: 'auto',
        });
    }
    function endDrag() {
        if (moved && onEnd) { const r2 = target.getBoundingClientRect(); onEnd({ x: r2.left, y: r2.top }); }
        jQuery(handle).data('kpdrag', moved);
        moved = false;
    }

    // Mouse
    jQuery(handle).css('cursor', 'grab').on('mousedown', function(e) {
        if (e.button !== 0) return;
        startDrag(e.clientX, e.clientY);
        jQuery(document)
            .on('mousemove.kpd', ev => { moveDrag(ev.clientX, ev.clientY); jQuery(handle).css('cursor', moved ? 'grabbing' : 'grab'); })
            .on('mouseup.kpd',   ()  => { jQuery(document).off('mousemove.kpd mouseup.kpd'); jQuery(handle).css('cursor','grab'); endDrag(); });
        e.preventDefault();
    });

    // Touch
    handle.addEventListener('touchstart', function(e) {
        const t = e.touches[0];
        startDrag(t.clientX, t.clientY);
    }, { passive: true });
    handle.addEventListener('touchmove', function(e) {
        const t = e.touches[0];
        moveDrag(t.clientX, t.clientY);
        if (moved) e.preventDefault(); // block scroll only when actually dragging
    }, { passive: false });
    handle.addEventListener('touchend', function() {
        endDrag();
    }, { passive: true });
}

// ── Events ────────────────────────────────────────────────────────────────────
function kpRegisterEvents() {
    const es = window.eventSource;
    if (!es) { kpLog('⚠ no eventSource'); return; }
    const et = window.event_types || {};

    let _debTimer = null;
    const onChatChange = () => {
        clearTimeout(_debTimer);
        _debTimer = setTimeout(async () => {
            // Skip if WE just applied (ST fires events in reaction)
            if (Date.now() - kpLastApply < 2000) {
                kpRefreshPill(); kpUpdatePanel(); kpMoveDockToEnd();
                return;
            }
            await new Promise(r => setTimeout(r, 700));
            if (!kpGetChar()) await new Promise(r => setTimeout(r, 500));

            kpRefreshPill(); kpUpdatePanel();
            if (KPS.docked) { await new Promise(r => setTimeout(r, 200)); kpMoveDockToEnd(); }

            if (!KPS.enabled || !KPS.autoSwitch) return;
            const need = kpResolve();
            if (!need) { kpLog('no preset for this chat/char'); return; }

            await new Promise(r => setTimeout(r, 400));
            const src = kpBindingType() || 'default';
            kpApplyRetry(need);
            kpNotify({ chat:'💬', char:'👤', default:'⚙' }[src] + ' ' + need);
        }, 350); // debounce: merge CHAT_CHANGED + CHARACTER_SELECTED into one call
    };

    // Subscribe to primary events only (no duplicates)
    [et.CHAT_CHANGED || 'chatChanged', et.CHARACTER_SELECTED || 'characterSelected']
        .forEach(ev => { try { es.on(ev, onChatChange); } catch(e) {} });

    // Message received → move dock to end
    let _msgTimer = null;
    try {
        es.on(et.MESSAGE_RECEIVED || 'messageReceived', () => {
            clearTimeout(_msgTimer);
            _msgTimer = setTimeout(() => kpMoveDockToEnd(), 200);
        });
    } catch(e) {}

    kpLog('events registered');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function kpEsc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function kpToast(msg) {
    if (typeof toastr !== 'undefined') toastr.info(msg, '✦ KP', { timeOut: 2000 });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// ── Boot ─────────────────────────────────────────────────────────────────────
// Legacy boot (non-module ST): jQuery ready fires after script execution
jQuery(async () => { await kpInit(); });

// ES Module export (ST >= 1.11 calling init() explicitly)
export async function init() { await kpInit(); }
export async function onEnable() { await kpInit(); }
export async function onDisable() {
    jQuery('#kp-pill, #kp-float, #kp-settings').remove();
    if (kpObs) { kpObs.disconnect(); kpObs = null; }
    window._kpInitDone = false;
}
