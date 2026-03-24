/**
 * ✦ KitsunePreset — менеджер пресетов для SillyTavern
 * by Sora · v2.3 (fix: реальное применение, дефолт пресет, MutationObserver retry)
 */

const MODULE_NAME = 'kitsune-preset';

const defaultSettings = {
    enabled: true,
    autoSwitch: true,
    showIndicator: true,
    indicatorPosition: { x: null, y: null, corner: 'top-right' },
    presetBindings: {},
    bindingMeta: {},
    showNotifications: true,
    animateIndicator: true,
    defaultPreset: '',   // глобальный пресет для чатов без привязки
};

let settings        = {};
let availablePresets = [];
let charBrowserOpen  = false;
let _pendingPreset   = null;   // имя пресета ожидающего подтверждения
let _applyLock       = false;  // защита от рекурсии в observer
let _presetObserver  = null;

function log(...a) { console.log('[✦KitsunePreset]', ...a); }
function getSave()  { return window.saveSettingsDebounced || (() => {}); }
function getExt()   { return window.extension_settings || {}; }
function getES()    { return window.eventSource; }
function getET()    { return window.event_types || {}; }

// ── SillyTavern Context ───────────────────────────────────────────────────────
function getSTContext() {
    try { const c = window.SillyTavern?.getContext?.(); if (c) return c; } catch(e) {}
    try { if (typeof window.getContext === 'function') return window.getContext(); } catch(e) {}
    return null;
}

// ── Текущий персонаж ──────────────────────────────────────────────────────────
function getCurrentChar() {
    try {
        const ctx   = getSTContext();
        const chars = (ctx && ctx.characters) || window.characters || [];
        const chid  = parseInt((ctx && (ctx.characterId ?? ctx.characterID)) ?? window.this_chid);
        if (!isNaN(chid) && chid >= 0 && chars[chid]) return buildCharInfo(chars[chid], chid);
        if (ctx && ctx.name2 && ctx.name2 !== 'You') {
            const f = chars.find(c => c && c.name === ctx.name2);
            if (f) return buildCharInfo(f, chars.indexOf(f));
            return { name: ctx.name2, avatar: null, chid: null };
        }
    } catch(e) {}
    try {
        const chid  = parseInt(window.this_chid);
        const chars = window.characters || [];
        if (!isNaN(chid) && chid >= 0 && chars[chid]) return buildCharInfo(chars[chid], chid);
    } catch(e) {}
    try {
        const name =
            $('#chat_name_if_not_group_mode .ch_name').text().trim() ||
            $('#char-name').text().trim() ||
            $('.ch_name').first().text().trim();
        if (name) {
            const chars = window.characters || [];
            const f = chars.find(c => c && c.name === name);
            if (f) return buildCharInfo(f, chars.indexOf(f));
            return { name, avatar: null, chid: null };
        }
    } catch(e) {}
    return null;
}

function buildCharInfo(c, chid) {
    const id = parseInt(chid);
    const avatar = (c.avatar && c.avatar !== 'none') ? '/characters/' + c.avatar : null;
    return { name: c.name || `Персонаж #${id}`, avatar, chid: isNaN(id) ? null : id };
}

function getCurrentChatId() {
    try {
        const ctx = getSTContext();
        if (ctx && ctx.chatId)  return String(ctx.chatId);
        if (ctx && ctx.chat_id) return String(ctx.chat_id);
    } catch(e) {}
    try { if (window.chat_metadata?.chat_id) return String(window.chat_metadata.chat_id); } catch(e) {}
    try {
        const n = $('#select_chat_btn .ch_name').text().trim() ||
                  $('#chat_name_if_not_group_mode .ch_name').text().trim();
        if (n) return n;
    } catch(e) {}
    return null;
}

function avatarHtml(info, size) {
    const sz = size || 30;
    const letter = info ? (info.name || '?').charAt(0).toUpperCase() : '?';
    if (info && info.avatar) {
        return `<img class="kp-ava" src="${info.avatar}" width="${sz}" height="${sz}"
                     title="${escHtml(info.name || '')}"
                     onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                <div class="kp-ava kp-ava-fb" style="width:${sz}px;height:${sz}px;display:none">${letter}</div>`;
    }
    return `<div class="kp-ava kp-ava-fb" style="width:${sz}px;height:${sz}px">${letter}</div>`;
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Пресет-селект ST ──────────────────────────────────────────────────────────
const KNOWN_PRESET_SELS = [
    '#settings_preset_openai',
    '#settings_preset_openai_compat',
    '#settings_preset',
    '#api_preset_kobold',
    '#settings_preset_novel',
    '#settings_preset_textgenerationwebui',
];

function findActivePresetSelect() {
    for (const s of KNOWN_PRESET_SELS) {
        const el = $(s);
        if (el.length && el.find('option').length > 1) return el;
    }
    let found = null;
    $('select[id*="preset"], select[id*="Preset"]').each(function() {
        if ($(this).find('option').length > 1) { found = $(this); return false; }
    });
    return found;
}

function loadPresetsFromUI() {
    const el = findActivePresetSelect();
    if (!el) { log('Пресеты не найдены'); return []; }
    const list = [];
    el.find('option').each(function() {
        const text = $(this).text().trim();
        if (text) list.push({ value: $(this).val(), label: text });
    });
    log('Пресеты из', el.attr('id'), ':', list.length);
    return list;
}

function getCurrentSTPreset() {
    const el = findActivePresetSelect();
    return el ? (el.find('option:selected').text().trim() || null) : null;
}

// ── Ключи привязок ────────────────────────────────────────────────────────────
function chatKey() {
    const cid = getCurrentChatId();
    return cid ? `chat_${cid}` : null;
}

function charKey() {
    const info = getCurrentChar();
    if (info && info.chid !== null && info.chid !== undefined) return `char_${info.chid}`;
    const chid = parseInt(window.this_chid);
    if (!isNaN(chid) && chid >= 0) return `char_${chid}`;
    return null;
}

function saveBindingMeta(key) {
    if (!settings.bindingMeta) settings.bindingMeta = {};
    const info   = getCurrentChar();
    const chatId = getCurrentChatId();
    if (key.startsWith('char_')) {
        settings.bindingMeta[key] = { name: info?.name || key, avatar: info?.avatar || null };
    } else {
        settings.bindingMeta[key] = {
            name:     chatId ? chatId.substring(0, 30) : key,
            charName: info?.name || '?',
            avatar:   info?.avatar || null,
        };
    }
}

// Какой пресет нужен сейчас: привязка к чату > привязка к персу > дефолт
function resolvePreset() {
    const ck  = chatKey(), chk = charKey();
    return (ck  && settings.presetBindings[ck])  ||
           (chk && settings.presetBindings[chk]) ||
           settings.defaultPreset ||
           null;
}

// ── Применение пресета ────────────────────────────────────────────────────────
function applySelectValue(el, val) {
    if (!el || !el.length) return false;
    const native = el[0];
    // Нативный setter (обходит framework-обёртки)
    try {
        const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(native, val);
        else native.value = val;
    } catch(e) { native.value = val; }
    // jQuery события (ST слушает через jQuery)
    el.trigger('focus').trigger('input').trigger('change');
    // Нативные DOM-события (резерв)
    try { native.dispatchEvent(new Event('input',  { bubbles: true })); } catch(e) {}
    try { native.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
    return true;
}

function switchInST(name) {
    if (!name) return false;

    function findOpt(el) {
        return el.find('option').filter(function() {
            return $(this).text().trim() === name || $(this).val() === name;
        });
    }

    // 1. Известные ID
    for (const s of KNOWN_PRESET_SELS) {
        const el = $(s);
        if (!el.length) continue;
        const opt = findOpt(el);
        if (opt.length) { applySelectValue(el, opt.first().val()); log('✓ via', s, name); return true; }
    }
    // 2. Любой preset-select
    let ok = false;
    $('select').each(function() {
        if (ok) return false;
        if (!($(this).attr('id') || '').toLowerCase().includes('preset')) return;
        const opt = findOpt($(this));
        if (opt.length) { applySelectValue($(this), opt.first().val()); log('✓ via fallback', $(this).attr('id'), name); ok = true; }
    });
    if (ok) return true;
    // 3. window.*
    for (const fn of ['applyPreset','applyOpenAIPreset','loadPreset','selectPreset']) {
        if (typeof window[fn] === 'function') {
            try { window[fn](name); log('✓ via window.' + fn); return true; } catch(e) {}
        }
    }
    // 4. context API
    try {
        const ctx = getSTContext();
        if (ctx) {
            for (const m of ['setPreset','applyPreset']) {
                if (typeof ctx[m] === 'function') { ctx[m](name); log('✓ via ctx.' + m); return true; }
            }
        }
    } catch(e) {}

    log('⚠ Пресет не найден:', name, '| Доступные:', availablePresets.map(p => p.label).join(', '));
    notify('Пресет не найден: ' + name + ' — нажмите "Обновить"');
    return false;
}

/**
 * Применяет пресет + retry через 600мс и 1400мс.
 * Нужно потому что ST после загрузки чата сам перезаписывает настройки.
 */
function switchWithRetry(name) {
    if (!name) return;
    _pendingPreset = name;
    switchInST(name);

    setTimeout(() => {
        if (_pendingPreset !== name) return;
        if (getCurrentSTPreset() !== name) { log('retry #1'); switchInST(name); }
        setTimeout(() => {
            if (_pendingPreset !== name) return;
            if (getCurrentSTPreset() !== name) { log('retry #2'); switchInST(name); }
            _pendingPreset = null;
        }, 800);
    }, 600);
}

// ── MutationObserver: следим чтобы ST не сбросил наш пресет ──────────────────
function startPresetObserver() {
    stopPresetObserver();
    const el = findActivePresetSelect();
    if (!el || !el.length) return;

    _presetObserver = new MutationObserver(() => {
        if (_applyLock) return;
        const needed = resolvePreset();
        if (!needed) return;
        const actual = getCurrentSTPreset();
        if (actual && actual !== needed) {
            log('[Observer] ST сбросил к', actual, '→ исправляем на', needed);
            _applyLock = true;
            switchInST(needed);
            setTimeout(() => { _applyLock = false; }, 400);
        }
    });

    _presetObserver.observe(el[0], { attributes: true, childList: false });
    if (el[0].parentElement) {
        _presetObserver.observe(el[0].parentElement, { childList: true });
    }
    log('[Observer] запущен на', el.attr('id'));
}

function stopPresetObserver() {
    if (_presetObserver) { _presetObserver.disconnect(); _presetObserver = null; }
}

// ── Инициализация ─────────────────────────────────────────────────────────────
async function init() {
    log('Инициализация...');
    const ext = getExt();
    if (!ext[MODULE_NAME]) ext[MODULE_NAME] = { ...defaultSettings };
    settings = ext[MODULE_NAME];
    if (!settings.presetBindings)           settings.presetBindings  = {};
    if (!settings.bindingMeta)              settings.bindingMeta     = {};
    if (settings.defaultPreset === undefined) settings.defaultPreset = '';
    if (typeof settings.indicatorPosition !== 'object' || !settings.indicatorPosition)
        settings.indicatorPosition = { x: null, y: null, corner: 'top-right' };

    await new Promise(r => setTimeout(r, 1200));
    availablePresets = loadPresetsFromUI();
    createIndicator();
    createPanel();
    registerEvents();
    startPresetObserver();
    log('Готово. Пресетов:', availablePresets.length);
    refreshAll();

    // Применяем при старте
    const needed = resolvePreset();
    if (needed && settings.enabled && settings.autoSwitch) {
        await new Promise(r => setTimeout(r, 400));
        switchWithRetry(needed);
    }
}

// ── Индикатор ─────────────────────────────────────────────────────────────────
function indicatorCSS() {
    const p = settings.indicatorPosition;
    if (p.x !== null && p.y !== null) return `left:${p.x}px;top:${p.y}px`;
    const m = {
        'top-left':     'top:66px;left:12px',
        'top-right':    'top:66px;right:12px',
        'bottom-left':  'bottom:76px;left:12px',
        'bottom-right': 'bottom:76px;right:12px',
    };
    return m[p.corner] || 'top:66px;right:12px';
}

function createIndicator() {
    $('#kp-indicator').remove();
    if (!settings.showIndicator) return;
    $('body').append(`
        <div id="kp-indicator" style="position:fixed;${indicatorCSS()};z-index:99999;display:none;cursor:grab">
            <div id="kp-ind-inner">
                <span class="kp-star">✦</span>
                <div id="kp-ind-ava"></div>
                <span id="kp-ind-text">—</span>
            </div>
        </div>`);
    makeDraggable(document.getElementById('kp-indicator'));
    $('#kp-indicator').on('click', function() {
        if (!$(this).data('dragged')) showQuickMenu();
    });
}

function makeDraggable(el) {
    let sx, sy, sl, st, moved = false;
    $(el).on('mousedown', function(e) {
        if (e.button !== 0) return;
        moved = false;
        const r = el.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        $(el).css({ left: sl, top: st, right: 'auto', bottom: 'auto' }).data('dragged', false);
        function mv(ev) {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                moved = true; $(el).css('cursor','grabbing').data('dragged', true);
            }
            if (!moved) return;
            $(el).css({
                left: Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  sl + dx)),
                top:  Math.max(0, Math.min(window.innerHeight - el.offsetHeight, st + dy)),
            });
        }
        function up() {
            $(document).off('mousemove.kpdrag mouseup.kpdrag');
            $(el).css('cursor','grab');
            if (moved) {
                const r2 = el.getBoundingClientRect();
                settings.indicatorPosition = { x: Math.round(r2.left), y: Math.round(r2.top), corner: null };
                save();
            }
        }
        $(document).on('mousemove.kpdrag', mv).on('mouseup.kpdrag', up);
        e.preventDefault();
    });
}

function refreshAll() { refreshIndicator(); syncPanel(); }

function refreshIndicator() {
    if (!settings.showIndicator) { $('#kp-indicator').hide(); return; }
    if (!$('#kp-indicator').length) createIndicator();

    const ck  = chatKey(), chk = charKey();
    const isChat = !!(ck  && settings.presetBindings[ck]);
    const isChar = !!(chk && settings.presetBindings[chk]);
    const isDef  = !isChat && !isChar && !!settings.defaultPreset;
    const name   = resolvePreset() || getCurrentSTPreset();
    const info   = getCurrentChar();

    if (!name) { $('#kp-indicator').hide(); return; }

    if (info && info.avatar) {
        $('#kp-ind-ava').html(`<img src="${info.avatar}" width="16" height="16" class="kp-ind-ava-img" onerror="this.style.display='none'">`);
    } else {
        $('#kp-ind-ava').empty();
    }

    const prefix = isDef ? '⚙' : '✦';
    $('#kp-ind-text').text(`${prefix} ${name}`);
    $('#kp-ind-inner')
        .toggleClass('kp-ind-custom',  !!(isChat || isChar))
        .toggleClass('kp-ind-default', isDef);
    $('#kp-indicator').show();

    if (settings.animateIndicator) {
        $('#kp-indicator').addClass('kp-pulse');
        setTimeout(() => $('#kp-indicator').removeClass('kp-pulse'), 700);
    }
}

// ── Панель ────────────────────────────────────────────────────────────────────
function presetOpts(sel, emptyLabel) {
    const lbl = emptyLabel || 'По умолчанию';
    let h = `<option value="">— ${lbl} —</option>`;
    availablePresets.forEach(p => {
        h += `<option value="${escHtml(p.label)}" ${sel === p.label ? 'selected' : ''}>${escHtml(p.label)}</option>`;
    });
    return h;
}

function cornerVal() {
    const p = settings.indicatorPosition;
    return p.x !== null ? 'custom' : (p.corner || 'top-right');
}

function createPanel() {
    $('#kp-settings').remove();
    const s         = settings;
    const ck        = chatKey(), chk = charKey();
    const chatBound = (ck  && s.presetBindings[ck])  || '';
    const charBound = (chk && s.presetBindings[chk]) || '';
    const curSel    = chatBound || charBound || '';
    const info      = getCurrentChar();
    const chatId    = getCurrentChatId();

    $('#extensions_settings2').append(`
    <div id="kp-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><span class="kp-star-title">✦</span> KitsunePreset</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content kp-panel">

          <!-- Текущий контекст -->
          <div class="kp-context">
            <div class="kp-ctx-ava" id="kp-ctx-ava">${avatarHtml(info, 36)}</div>
            <div class="kp-ctx-info">
              <div class="kp-ctx-name" id="kp-ctx-name">${escHtml(info ? info.name : 'Персонаж не выбран')}</div>
              <div class="kp-ctx-chat" id="kp-ctx-chat">${escHtml(chatId ? chatId.substring(0,26) : 'Нет чата')}</div>
            </div>
            <div class="kp-ctx-tags" id="kp-ctx-tags">
              ${chatBound ? `<span class="kp-tag kp-tag-chat" title="${escHtml(chatBound)}">чат</span>` : ''}
              ${charBound ? `<span class="kp-tag kp-tag-char" title="${escHtml(charBound)}">перс</span>` : ''}
            </div>
          </div>

          <!-- Опции -->
          <div class="kp-row">
            <label class="checkbox_label"><input type="checkbox" id="kp-enabled"    ${s.enabled          ?'checked':''}><span>Включён</span></label>
            <label class="checkbox_label"><input type="checkbox" id="kp-autoswitch" ${s.autoSwitch       ?'checked':''} title="Авто-применять при смене чата"><span>Авто-смена</span></label>
            <label class="checkbox_label"><input type="checkbox" id="kp-show-ind"   ${s.showIndicator    ?'checked':''}><span>Индикатор</span></label>
            <label class="checkbox_label"><input type="checkbox" id="kp-notify"     ${s.showNotifications?'checked':''}><span>Уведомления</span></label>
          </div>

          <!-- Позиция + Обновить -->
          <div class="kp-row-inline">
            <div class="kp-field">
              <label>Позиция индикатора</label>
              <select id="kp-indpos" class="text_pole kp-sel">
                <option value="top-left"     ${cornerVal()==='top-left'    ?'selected':''}>Верх-лево</option>
                <option value="top-right"    ${cornerVal()==='top-right'   ?'selected':''}>Верх-право</option>
                <option value="bottom-left"  ${cornerVal()==='bottom-left' ?'selected':''}>Низ-лево</option>
                <option value="bottom-right" ${cornerVal()==='bottom-right'?'selected':''}>Низ-право</option>
                <option value="custom"       ${cornerVal()==='custom'      ?'selected':''}>Своя (перетащи)</option>
              </select>
            </div>
            <div class="kp-field kp-field-btn">
              <label>Пресеты</label>
              <button id="kp-refresh" class="menu_button kp-btn-sm">Обновить</button>
            </div>
          </div>

          <!-- ═══ ДЕФОЛТ ПРЕСЕТ ═══ -->
          <div class="kp-block kp-block-default">
            <div class="kp-block-label">
              <span class="kp-def-icon">⚙</span>
              Пресет по умолчанию
              <span class="kp-def-hint" title="Применяется когда нет привязки к чату/персонажу">(для остальных чатов)</span>
            </div>
            <div class="kp-default-row">
              <select id="kp-default-sel" class="text_pole kp-preset-sel">${presetOpts(s.defaultPreset, 'Не задан')}</select>
              <button id="kp-default-apply" class="menu_button kp-act-btn kp-act-apply" title="Применить сейчас">▶</button>
            </div>
            <div class="kp-def-status" id="kp-def-status">
              ${s.defaultPreset
                ? `<span class="kp-stag kp-stag-def">⚙ ${escHtml(s.defaultPreset)}</span>`
                : '<span class="kp-stag-none">Не задан — пресет не меняется при отсутствии привязки</span>'}
            </div>
          </div>

          <!-- Привязка для текущего чата/персонажа -->
          <div class="kp-block">
            <div class="kp-block-label">Привязать пресет:</div>
            <select id="kp-preset-sel" class="text_pole kp-preset-sel">${presetOpts(curSel)}</select>
            <div class="kp-actions">
              <button id="kp-bind-chat" class="menu_button kp-act-btn ${chatBound?'kp-act-active':''}">К чату</button>
              <button id="kp-bind-char" class="menu_button kp-act-btn ${charBound?'kp-act-active':''}">К персонажу</button>
              <button id="kp-unbind"    class="menu_button kp-act-btn kp-act-rm">Снять</button>
              <button id="kp-apply"     class="menu_button kp-act-btn kp-act-apply">Применить</button>
            </div>
            <div class="kp-status" id="kp-status">
              ${chatBound ? `<span class="kp-stag kp-stag-chat">Чат → ${escHtml(chatBound)}</span>` : ''}
              ${charBound ? `<span class="kp-stag kp-stag-char">Перс → ${escHtml(charBound)}</span>` : ''}
              ${!chatBound && !charBound ? '<span class="kp-stag-none">Нет привязок для текущего чата/персонажа</span>' : ''}
            </div>
          </div>

          <!-- Браузер всех персонажей -->
          <div class="kp-block">
            <div class="kp-block-label kp-list-hdr">
              <span>Массовое назначение</span>
              <button id="kp-browse-chars" class="menu_button kp-btn-sm">Все персонажи ▾</button>
            </div>
            <div id="kp-char-browser" class="kp-char-browser" style="display:none"></div>
          </div>

          <!-- Список привязок -->
          <div class="kp-block kp-block-list">
            <div class="kp-block-label kp-list-hdr">
              <span id="kp-bind-cnt">Привязки (${Object.keys(s.presetBindings).length})</span>
              <button id="kp-clear-all" class="menu_button kp-btn-rm-all">Очистить всё</button>
            </div>
            <div id="kp-bindings" class="kp-bindings"></div>
          </div>

        </div>
      </div>
    </div>`);

    renderList();
    attachListeners();
}

function syncPanel() {
    const info      = getCurrentChar();
    const chatId    = getCurrentChatId();
    const ck  = chatKey(), chk = charKey();
    const chatBound = (ck  && settings.presetBindings[ck])  || '';
    const charBound = (chk && settings.presetBindings[chk]) || '';
    const curSel    = chatBound || charBound || '';
    const dp        = settings.defaultPreset || '';

    $('#kp-ctx-ava').html(avatarHtml(info, 36));
    $('#kp-ctx-name').text(info ? info.name : 'Персонаж не выбран');
    $('#kp-ctx-chat').text(chatId ? chatId.substring(0,26) : 'Нет чата');
    $('#kp-ctx-tags').html(
        (chatBound ? `<span class="kp-tag kp-tag-chat" title="${escHtml(chatBound)}">чат</span>` : '') +
        (charBound ? `<span class="kp-tag kp-tag-char" title="${escHtml(charBound)}">перс</span>` : '')
    );
    $('#kp-preset-sel').html(presetOpts(curSel));
    $('#kp-default-sel').val(dp);
    $('#kp-def-status').html(dp
        ? `<span class="kp-stag kp-stag-def">⚙ ${escHtml(dp)}</span>`
        : '<span class="kp-stag-none">Не задан — пресет не меняется при отсутствии привязки</span>'
    );
    $('#kp-bind-chat').toggleClass('kp-act-active', !!chatBound);
    $('#kp-bind-char').toggleClass('kp-act-active', !!charBound);
    $('#kp-status').html(
        (chatBound ? `<span class="kp-stag kp-stag-chat">Чат → ${escHtml(chatBound)}</span>` : '') +
        (charBound ? `<span class="kp-stag kp-stag-char">Перс → ${escHtml(charBound)}</span>` : '') +
        (!chatBound && !charBound ? '<span class="kp-stag-none">Нет привязок для текущего чата/персонажа</span>' : '')
    );
    $('#kp-bind-cnt').text(`Привязки (${Object.keys(settings.presetBindings).length})`);
}

function renderList() {
    const el = $('#kp-bindings').empty();
    const entries = Object.entries(settings.presetBindings);
    $('#kp-bind-cnt').text(`Привязки (${entries.length})`);
    if (!entries.length) { el.html('<div class="kp-empty">Нет привязок</div>'); return; }

    entries.forEach(([key, preset]) => {
        let info = null, tag = '', tagCls = '';
        const meta = settings.bindingMeta?.[key];

        if (key.startsWith('char_')) {
            tag = 'перс'; tagCls = 'kp-tag-char-s';
            if (meta) { info = { name: meta.name, avatar: meta.avatar }; }
            else {
                const id = parseInt(key.replace('char_', ''));
                const c  = (!isNaN(id) && (window.characters || [])[id]) || null;
                info = c ? buildCharInfo(c, id) : { name: `Персонаж #${id}`, avatar: null };
            }
        } else {
            tag = 'чат'; tagCls = 'kp-tag-chat-s';
            info = meta
                ? { name: meta.charName || meta.name, avatar: meta.avatar }
                : { name: key.replace('chat_', '').substring(0, 18), avatar: null };
        }

        el.append(`
            <div class="kp-bitem">
              <div class="kp-bi-ava">${avatarHtml(info, 22)}</div>
              <span class="kp-bi-tag ${tagCls}">${tag}</span>
              <span class="kp-bi-name" title="${escHtml(key)}">${escHtml(info ? info.name : key)}</span>
              <span class="kp-bi-arr">→</span>
              <span class="kp-bi-preset" title="${escHtml(preset)}">${escHtml(preset)}</span>
              <button class="kp-bi-rm menu_button" data-key="${escHtml(key)}">✕</button>
            </div>`);
    });

    el.find('.kp-bi-rm').on('click', function() {
        const k = $(this).data('key');
        delete settings.presetBindings[k];
        if (settings.bindingMeta) delete settings.bindingMeta[k];
        save(); renderList(); syncPanel(); refreshIndicator();
        notify('Привязка удалена');
    });
}

// ── Браузер персонажей ────────────────────────────────────────────────────────
function renderCharBrowser() {
    const container = $('#kp-char-browser');
    const chars = window.characters || [];
    if (!chars.length) { container.html('<div class="kp-empty">Персонажи не найдены</div>'); return; }

    let rows = '';
    chars.forEach((c, i) => {
        if (!c || !c.name) return;
        const info  = buildCharInfo(c, i);
        const key   = `char_${i}`;
        const bound = settings.presetBindings[key] || '';
        rows += `
        <div class="kp-cb-item" data-char-name="${escHtml(c.name.toLowerCase())}">
          <div class="kp-cb-ava">${avatarHtml(info, 26)}</div>
          <span class="kp-cb-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
          <select class="text_pole kp-cb-sel" data-char-idx="${i}">${presetOpts(bound)}</select>
          <button class="menu_button kp-cb-save kp-btn-sm" data-char-idx="${i}">✓</button>
        </div>`;
    });

    container.html(`
        <input type="text" id="kp-cb-search" class="text_pole kp-cb-search" placeholder="🔍 Поиск...">
        <div class="kp-cb-list" id="kp-cb-list">${rows}</div>`);

    $('#kp-cb-search').on('input', function() {
        const q = $(this).val().toLowerCase().trim();
        $('#kp-cb-list .kp-cb-item').each(function() {
            $(this).toggle(!q || ($(this).data('char-name') || '').includes(q));
        });
    });

    container.find('.kp-cb-save').on('click', function() {
        const idx  = parseInt($(this).data('char-idx'));
        const sel  = container.find(`.kp-cb-sel[data-char-idx="${idx}"]`).val();
        const key  = `char_${idx}`;
        const c    = (window.characters || [])[idx];
        const info = c ? buildCharInfo(c, idx) : null;

        if (sel) {
            settings.presetBindings[key] = sel;
            if (!settings.bindingMeta) settings.bindingMeta = {};
            settings.bindingMeta[key] = { name: info?.name || `#${idx}`, avatar: info?.avatar || null };
        } else {
            delete settings.presetBindings[key];
            if (settings.bindingMeta) delete settings.bindingMeta[key];
        }
        save(); renderList(); syncPanel(); refreshIndicator();
        notify(sel ? `${c?.name || '#'+idx} → ${sel}` : 'Привязка снята');
        const btn = $(this);
        btn.addClass('kp-cb-saved');
        setTimeout(() => btn.removeClass('kp-cb-saved'), 1200);
    });
}

// ── Слушатели панели ──────────────────────────────────────────────────────────
function attachListeners() {
    $('#kp-enabled').on('change',    function() { settings.enabled           = this.checked; save(); });
    $('#kp-autoswitch').on('change', function() { settings.autoSwitch        = this.checked; save(); });
    $('#kp-notify').on('change',     function() { settings.showNotifications  = this.checked; save(); });
    $('#kp-show-ind').on('change',   function() {
        settings.showIndicator = this.checked; save();
        settings.showIndicator ? (createIndicator(), refreshIndicator()) : $('#kp-indicator').remove();
    });
    $('#kp-indpos').on('change', function() {
        const v = $(this).val();
        if (v !== 'custom') { settings.indicatorPosition = { x:null, y:null, corner:v }; save(); createIndicator(); refreshIndicator(); }
    });
    $('#kp-refresh').on('click', function() {
        availablePresets = loadPresetsFromUI();
        syncPanel();
        startPresetObserver();
        notify(`Загружено: ${availablePresets.length} пресетов`);
    });

    // Дефолт пресет
    $('#kp-default-sel').on('change', function() {
        settings.defaultPreset = $(this).val();
        save(); syncPanel(); refreshIndicator();
        notify(settings.defaultPreset ? '⚙ Дефолт: ' + settings.defaultPreset : 'Дефолт сброшен');
    });
    $('#kp-default-apply').on('click', function() {
        const v = $('#kp-default-sel').val() || settings.defaultPreset;
        if (v) { switchWithRetry(v); notify('Применён: ' + v); }
        else notify('Дефолт пресет не задан');
    });

    // Привязки
    $('#kp-bind-chat').on('click', function() {
        const v = $('#kp-preset-sel').val(), k = chatKey();
        if (!k) { notify('Сначала откройте чат'); return; }
        if (v) { settings.presetBindings[k] = v; saveBindingMeta(k); }
        else   { delete settings.presetBindings[k]; if (settings.bindingMeta) delete settings.bindingMeta[k]; }
        save(); syncPanel(); renderList(); refreshIndicator();
        notify(v ? 'К чату: ' + v : 'Привязка к чату снята');
    });
    $('#kp-bind-char').on('click', function() {
        const v = $('#kp-preset-sel').val(), k = charKey();
        if (!k) { notify('Персонаж не определён'); return; }
        if (v) { settings.presetBindings[k] = v; saveBindingMeta(k); }
        else   { delete settings.presetBindings[k]; if (settings.bindingMeta) delete settings.bindingMeta[k]; }
        save(); syncPanel(); renderList(); refreshIndicator();
        notify(v ? 'К персонажу: ' + v : 'Привязка снята');
    });
    $('#kp-unbind').on('click', function() {
        [chatKey(), charKey()].filter(Boolean).forEach(k => {
            delete settings.presetBindings[k];
            if (settings.bindingMeta) delete settings.bindingMeta[k];
        });
        save(); syncPanel(); renderList(); refreshIndicator();
        notify('Привязки сняты');
    });
    $('#kp-apply').on('click', function() {
        const v = $('#kp-preset-sel').val();
        if (v) { switchWithRetry(v); notify('Применён: ' + v); }
        else notify('Выберите пресет');
    });
    $('#kp-clear-all').on('click', function() {
        if (!confirm('Удалить все привязки?')) return;
        settings.presetBindings = {}; settings.bindingMeta = {};
        save(); syncPanel(); renderList(); refreshIndicator();
        notify('Все привязки удалены');
    });
    $('#kp-browse-chars').on('click', function() {
        charBrowserOpen = !charBrowserOpen;
        if (charBrowserOpen) { renderCharBrowser(); $('#kp-char-browser').slideDown(200); $(this).text('Все персонажи ▴'); }
        else                 { $('#kp-char-browser').slideUp(200); $(this).text('Все персонажи ▾'); }
    });
}

// ── Быстрое меню ──────────────────────────────────────────────────────────────
function showQuickMenu() {
    $(document).off('click.kpclose');
    $('.kp-quick-menu').remove();
    const cur  = resolvePreset() || '';
    const info = getCurrentChar();

    const items = availablePresets.map(p => {
        const a = cur === p.label;
        return `<div class="kp-qi${a?' kp-qi-on':''}" data-p="${escHtml(p.label)}">
            <span class="kp-qi-n">${escHtml(p.label)}</span>${a?'<span class="kp-qi-chk">✓</span>':''}
        </div>`;
    }).join('');

    $('body').append(`
        <div class="kp-quick-menu">
          <div class="kp-qm-hdr">
            ${info && info.avatar ? `<img class="kp-qm-ava" src="${info.avatar}" onerror="this.style.display='none'">` : ''}
            <span>${escHtml(info ? info.name : 'Выбор пресета')}</span>
            <button class="kp-qm-x">✕</button>
          </div>
          <div class="kp-qm-list">
            <div class="kp-qi${!cur?' kp-qi-on':''}" data-p=""><span class="kp-qi-n">— По умолчанию —</span>${!cur?'<span class="kp-qi-chk">✓</span>':''}</div>
            ${items}
          </div>
          <div class="kp-qm-ftr">
            <button class="kp-qf-chat menu_button">К чату</button>
            <button class="kp-qf-char menu_button">К персонажу</button>
            <button class="kp-qf-apply menu_button kp-qf-blue">Применить</button>
          </div>
        </div>`);

    let sel = cur;
    $('.kp-qi').on('click', function() {
        sel = $(this).data('p');
        $('.kp-qi').removeClass('kp-qi-on').find('.kp-qi-chk').remove();
        $(this).addClass('kp-qi-on').append('<span class="kp-qi-chk">✓</span>');
    });
    $('.kp-qf-chat').on('click',  () => bindAndClose(sel, 'chat'));
    $('.kp-qf-char').on('click',  () => bindAndClose(sel, 'char'));
    $('.kp-qf-apply').on('click', () => {
        if (sel) { switchWithRetry(sel); notify('Применён: ' + sel); }
        $('.kp-quick-menu').remove();
    });
    $('.kp-qm-x').on('click', () => $('.kp-quick-menu').remove());
    setTimeout(() => $(document).one('click.kpclose', e => {
        if (!$(e.target).closest('.kp-quick-menu').length) $('.kp-quick-menu').remove();
    }), 200);
}

function bindAndClose(preset, type) {
    const k = type === 'chat' ? chatKey() : charKey();
    if (!k) { notify(type === 'chat' ? 'Откройте чат' : 'Персонаж не определён'); $('.kp-quick-menu').remove(); return; }
    if (preset) { settings.presetBindings[k] = preset; saveBindingMeta(k); }
    else { delete settings.presetBindings[k]; if (settings.bindingMeta) delete settings.bindingMeta[k]; }
    save(); syncPanel(); renderList(); refreshIndicator();
    notify(preset ? (type === 'chat' ? 'К чату: ' : 'К персонажу: ') + preset : 'Привязка снята');
    $('.kp-quick-menu').remove();
}

// ── События ST ────────────────────────────────────────────────────────────────
function registerEvents() {
    const es = getES();
    if (!es) { log('⚠ eventSource не найден'); return; }
    const et = getET();

    const onChange = async () => {
        // Первая пауза — даём ST начать загрузку
        await new Promise(r => setTimeout(r, 800));

        // Если персонаж ещё не виден — пробуем ещё раз
        if (!getCurrentChar()) await new Promise(r => setTimeout(r, 600));

        refreshAll();

        if (!settings.enabled || !settings.autoSwitch) return;

        const needed = resolvePreset();
        if (!needed) { log('Нет привязки и дефолта — пресет не меняем'); return; }

        // Пауза чтобы ST закончил грузить свои настройки для чата
        await new Promise(r => setTimeout(r, 500));

        // Определяем откуда взялся нужный пресет для уведомления
        const ck  = chatKey(), chk = charKey();
        const src = (ck  && settings.presetBindings[ck])  ? 'чат'  :
                    (chk && settings.presetBindings[chk]) ? 'перс' : 'дефолт';

        switchWithRetry(needed);
        notify(`Авто (${src}): ${needed}`);
    };

    const events = [
        et.CHAT_CHANGED       || 'chatChanged',
        et.CHARACTER_SELECTED || 'characterSelected',
        et.CHAT_LOADED        || 'chatLoaded',
        'chat_changed', 'character_selected', 'chat_loaded',
    ];
    [...new Set(events)].forEach(ev => { try { es.on(ev, onChange); } catch(e) {} });
    log('Слушаем:', [...new Set(events)]);
}

function notify(msg) {
    if (!settings.showNotifications) return;
    if (typeof toastr !== 'undefined') toastr.info(msg, '✦ KitsunePreset');
}

function save() {
    getExt()[MODULE_NAME] = settings;
    getSave()();
}

jQuery(async () => { await init(); });
