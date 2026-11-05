/* ==========================================================================
   無量簿 Immeasurable Ledger
   零依賴、單一檔案邏輯。資料存於 localStorage，可離線使用。
   ========================================================================== */

(function () {
    'use strict';

    /* ----------------------------------------------------------------------
       常數
       ---------------------------------------------------------------------- */

    var STORAGE_KEY = 'wuliangbu.v2';
    var DEFAULT_UNITS = ['金額', '時間', 'HKD', 'JPY', 'USD', 'EUR', 'RMB', 'TWD'];
    var DEFAULT_CATEGORIES = ['生活'];
    var MAX_NAME_LENGTH = 20;
    var CSV_HEADER = ['Number', 'Unit', 'Text', 'Remarks', 'Category', 'Time', 'Location'];
    var CSV_ALIASES = {
        number: ['number', 'amount', 'value', '數字', '金額', '數值'],
        unit: ['unit', '單位'],
        text: ['text', 'title', 'name', '文字', '項目', '描述'],
        remarks: ['remarks', 'remark', 'note', 'notes', '備註'],
        category: ['category', '分類'],
        time: ['time', 'date', 'datetime', '時間', '日期'],
        location: ['location', 'place', '位置', '地點']
    };
    var POSITIONAL_COLUMNS = {
        number: 0, unit: 1, text: 2, remarks: 3, category: 4, time: 5, location: 6
    };

    var numberFormat = new Intl.NumberFormat('zh-Hant', { maximumFractionDigits: 2 });

    /* ----------------------------------------------------------------------
       狀態
       ---------------------------------------------------------------------- */

    var state = null;
    var el = {};
    var storageAvailable = true;

    var formUnit = '';
    var formCategory = '';
    var editUnit = '';
    var editCategory = '';
    var openEntryId = null;
    var searchQuery = '';
    var currentTab = 'input';
    var collapsedCategories = new Set();
    var toastTimer = 0;

    /* ----------------------------------------------------------------------
       小工具
       ---------------------------------------------------------------------- */

    function $(id) {
        return document.getElementById(id);
    }

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function uid() {
        try {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                return window.crypto.randomUUID();
            }
        } catch (err) {
            /* 非安全環境（file://）可能沒有 randomUUID，改用下方方案 */
        }
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function unique(list) {
        var seen = new Set();
        return list.filter(function (item) {
            if (seen.has(item)) return false;
            seen.add(item);
            return true;
        });
    }

    function parseAmount(raw) {
        var cleaned = String(raw == null ? '' : raw).replace(/[,，\s]/g, '');
        if (!cleaned) return NaN;
        var value = Number(cleaned);
        return Number.isFinite(value) ? value : NaN;
    }

    function formatAmount(value) {
        if (!Number.isFinite(value)) return '';
        return numberFormat.format(value);
    }

    function displayNumber(entry) {
        return entry.amountRaw || formatAmount(entry.amount);
    }

    function nowISO() {
        return new Date().toISOString();
    }

    /**
     * 接受 "2026-11-05 10:20:30"、"2026/11/05"、ISO 等格式。
     * 無時區資訊者一律視為本地時間，與舊版行為一致。
     */
    function parseTime(value) {
        var text = String(value == null ? '' : value).trim();
        if (!text) return nowISO();

        var match = text.match(
            /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
        );
        if (match) {
            var local = new Date(
                Number(match[1]),
                Number(match[2]) - 1,
                Number(match[3]),
                Number(match[4] || 0),
                Number(match[5] || 0),
                Number(match[6] || 0)
            );
            if (!isNaN(local.getTime())) return local.toISOString();
        }

        var parsed = new Date(text);
        return isNaN(parsed.getTime()) ? nowISO() : parsed.toISOString();
    }

    function formatFullDate(iso) {
        var date = new Date(iso);
        if (isNaN(date.getTime())) return String(iso || '');
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
            ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    function formatShortDate(iso) {
        var date = new Date(iso);
        if (isNaN(date.getTime())) return '';
        return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
            ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    function parseLocationCell(cell) {
        var text = String(cell == null ? '' : cell).trim();
        if (!text) return { location: null, note: '' };

        var match = text.match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
        if (match) {
            var lat = Number(match[1]);
            var lng = Number(match[2]);
            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                return { location: { lat: lat, lng: lng }, note: '' };
            }
        }

        if (text === '未記錄' || text === '未記錄位置') {
            return { location: null, note: '' };
        }
        return { location: null, note: text };
    }

    function locationText(entry) {
        if (entry.location &&
            Number.isFinite(entry.location.lat) &&
            Number.isFinite(entry.location.lng)) {
            return entry.location.lat.toFixed(5) + ', ' + entry.location.lng.toFixed(5);
        }
        return entry.locationNote || '未記錄';
    }

    /* ----------------------------------------------------------------------
       資料正規化 / 儲存
       ---------------------------------------------------------------------- */

    function normalizeEntry(raw) {
        if (!raw || typeof raw !== 'object') return null;

        var rawNumber = raw.amountRaw != null ? raw.amountRaw : raw.number;
        var amountRaw = String(rawNumber == null ? '' : rawNumber).trim();
        var amount = Number.isFinite(raw.amount) ? raw.amount : parseAmount(amountRaw);

        var location = null;
        var note = '';

        if (raw.location && typeof raw.location === 'object') {
            var lat = Number(raw.location.lat);
            var lng = Number(raw.location.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                location = { lat: lat, lng: lng };
            }
        } else if (typeof raw.location === 'string') {
            var parsedLocation = parseLocationCell(raw.location);
            location = parsedLocation.location;
            note = parsedLocation.note;
        }

        if (raw.locationNote) note = String(raw.locationNote);

        return {
            id: raw.id ? String(raw.id) : uid(),
            amountRaw: amountRaw,
            amount: amount,
            unit: String(raw.unit == null ? '' : raw.unit),
            text: String(raw.text == null ? '' : raw.text),
            remarks: String(raw.remarks == null ? '' : raw.remarks),
            category: String(raw.category == null || raw.category === '' ? '未分類' : raw.category),
            time: parseTime(raw.time),
            location: location,
            locationNote: note
        };
    }

    function normalizeState(raw) {
        var source = raw && typeof raw === 'object' ? raw : {};

        var units = Array.isArray(source.units)
            ? source.units.filter(function (item) { return typeof item === 'string' && item.trim(); })
            : [];
        if (!units.length) units = DEFAULT_UNITS.slice();
        units = unique(units);

        var categories = Array.isArray(source.categories)
            ? source.categories.filter(function (item) { return typeof item === 'string' && item.trim(); })
            : [];
        if (!categories.length) categories = DEFAULT_CATEGORIES.slice();
        categories = unique(categories);

        var entries = Array.isArray(source.entries)
            ? source.entries.map(normalizeEntry).filter(Boolean)
            : [];

        // 確保每一筆記錄用到的單位 / 分類都存在於清單中
        entries.forEach(function (entry) {
            if (entry.unit && units.indexOf(entry.unit) === -1) units.push(entry.unit);
            if (entry.category && categories.indexOf(entry.category) === -1) categories.push(entry.category);
        });

        var prefs = source.prefs && typeof source.prefs === 'object' ? source.prefs : {};

        return {
            version: 2,
            entries: entries,
            units: units,
            categories: categories,
            lastUnit: units.indexOf(source.lastUnit) !== -1 ? source.lastUnit : units[0],
            lastCategory: categories.indexOf(source.lastCategory) !== -1 ? source.lastCategory : categories[0],
            prefs: {
                viewMode: prefs.viewMode === 'detailed' ? 'detailed' : 'simple',
                sort: prefs.sort === 'asc' ? 'asc' : 'desc',
                recordLocation: prefs.recordLocation !== false
            }
        };
    }

    function getItem(key) {
        try {
            return localStorage.getItem(key);
        } catch (err) {
            return null;
        }
    }

    function migrateLegacy() {
        var legacyEntries = [];
        var units = [];
        var categories = [];
        var lastUnit = '';
        var lastCategory = '';

        try {
            legacyEntries = JSON.parse(getItem('entries') || '[]');
        } catch (err) {
            legacyEntries = [];
        }
        try {
            units = JSON.parse(getItem('units') || '[]');
        } catch (err) {
            units = [];
        }
        try {
            categories = JSON.parse(getItem('categories') || '[]');
        } catch (err) {
            categories = [];
        }
        lastUnit = getItem('lastUnit') || '';
        lastCategory = getItem('lastCategory') || '';

        return normalizeState({
            entries: legacyEntries,
            units: units,
            categories: categories,
            lastUnit: lastUnit,
            lastCategory: lastCategory
        });
    }

    function loadState() {
        var saved = getItem(STORAGE_KEY);
        if (saved) {
            try {
                var parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') return normalizeState(parsed);
            } catch (err) {
                console.warn('讀取儲存資料失敗，改用備份資料。', err);
            }
        }
        return migrateLegacy();
    }

    function saveState() {
        if (!storageAvailable) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (err) {
            console.error(err);
            storageAvailable = false;
            if (el.storageWarning) el.storageWarning.hidden = false;
            showToast('無法寫入本機儲存空間，資料不會保留');
        }
    }

    function detectStorage() {
        try {
            var probe = '__wuliangbu_probe__';
            localStorage.setItem(probe, '1');
            localStorage.removeItem(probe);
            return true;
        } catch (err) {
            return false;
        }
    }

    /* ----------------------------------------------------------------------
       DOM 小工具
       ---------------------------------------------------------------------- */

    function make(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function renderChips(container, items, selected, options) {
        container.textContent = '';

        items.forEach(function (item) {
            var chip = make('button', 'chip' + (item === selected ? ' is-selected' : ''), item);
            chip.type = 'button';
            chip.setAttribute('aria-pressed', item === selected ? 'true' : 'false');
            chip.addEventListener('click', function () {
                options.onPick(item);
            });
            container.appendChild(chip);
        });

        var add = make('button', 'chip chip-add', options.addLabel || '＋ 新增');
        add.type = 'button';
        add.addEventListener('click', options.onAdd);
        container.appendChild(add);
    }

    /* ----------------------------------------------------------------------
       對話框
       ---------------------------------------------------------------------- */

    function setPromptError(message) {
        el.promptError.textContent = message;
        el.promptError.hidden = false;
        el.promptInput.classList.add('is-invalid');
        el.promptInput.focus();
    }

    function clearPromptError() {
        el.promptError.hidden = true;
        el.promptInput.classList.remove('is-invalid');
    }

    /**
     * 詢問一段文字，回傳 Promise<string|null>。
     * validate(value) 回傳錯誤訊息字串代表不合法。
     */
    function openPrompt(options) {
        options = options || {};
        return new Promise(function (resolve) {
            var settled = false;

            function finish(value) {
                if (settled) return;
                settled = true;
                cleanup();
                // 等 close 事件真正結束再 resolve，避免下一個對話框被殘留事件關閉
                if (el.promptDialog.open) {
                    el.promptDialog.addEventListener('close', function () {
                        resolve(value);
                    }, { once: true });
                    el.promptDialog.close();
                } else {
                    resolve(value);
                }
            }

            function cancel() {
                finish(null);
            }

            function onClose() {
                finish(null);
            }

            function onSubmit(event) {
                event.preventDefault();
                var value = el.promptInput.value.trim();
                var message = '';

                if (!value) {
                    message = '請輸入名稱';
                } else if (value.length > MAX_NAME_LENGTH) {
                    message = '最多 ' + MAX_NAME_LENGTH + ' 個字';
                } else if (typeof options.validate === 'function') {
                    message = options.validate(value) || '';
                }

                if (message) {
                    setPromptError(message);
                    return;
                }
                finish(value);
            }

            function cleanup() {
                el.promptForm.removeEventListener('submit', onSubmit);
                el.promptCancel.removeEventListener('click', cancel);
                el.promptClose.removeEventListener('click', cancel);
                el.promptDialog.removeEventListener('cancel', cancel);
                el.promptDialog.removeEventListener('close', onClose);
                el.promptInput.removeEventListener('input', clearPromptError);
            }

            el.promptTitle.textContent = options.title || '新增';
            el.promptLabel.textContent = options.label || '名稱';
            el.promptInput.value = options.value || '';
            el.promptInput.placeholder = options.placeholder || '';
            el.promptInput.maxLength = options.maxLength || MAX_NAME_LENGTH;
            clearPromptError();

            el.promptForm.addEventListener('submit', onSubmit);
            el.promptCancel.addEventListener('click', cancel);
            el.promptClose.addEventListener('click', cancel);
            el.promptDialog.addEventListener('cancel', cancel);
            el.promptDialog.addEventListener('close', onClose);
            el.promptInput.addEventListener('input', clearPromptError);

            el.promptDialog.showModal();
            el.promptInput.focus();
            el.promptInput.select();
        });
    }

    /**
     * 一般確認框，回傳 Promise<boolean>。
     */
    function openConfirm(options) {
        options = options || {};
        return new Promise(function (resolve) {
            var settled = false;

            function finish(value) {
                if (settled) return;
                settled = true;
                cleanup();
                if (el.confirmDialog.open) {
                    el.confirmDialog.addEventListener('close', function () {
                        resolve(value);
                    }, { once: true });
                    el.confirmDialog.close();
                } else {
                    resolve(value);
                }
            }

            function cancel() {
                finish(false);
            }

            function onClose() {
                finish(false);
            }

            function cleanup() {
                el.confirmOk.removeEventListener('click', onOk);
                el.confirmCancel.removeEventListener('click', cancel);
                el.confirmDialog.removeEventListener('cancel', cancel);
                el.confirmDialog.removeEventListener('close', onClose);
            }

            function onOk() {
                finish(true);
            }

            el.confirmTitle.textContent = options.title || '確認';
            el.confirmMessage.textContent = options.message || '';
            el.confirmOk.textContent = options.okText || '確定';
            el.confirmCancel.textContent = options.cancelText || '取消';
            el.confirmOk.className = 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary');
            el.confirmCancel.className = 'btn btn-ghost';

            el.confirmOk.addEventListener('click', onOk);
            el.confirmCancel.addEventListener('click', cancel);
            el.confirmDialog.addEventListener('cancel', cancel);
            el.confirmDialog.addEventListener('close', onClose);

            el.confirmDialog.showModal();
            (options.danger ? el.confirmCancel : el.confirmOk).focus();
        });
    }

    /**
     * 匯入方式選擇，回傳 Promise<'merge'|'replace'|null>。
     */
    function openImportChoice(summaryText) {
        return new Promise(function (resolve) {
            var settled = false;

            function finish(value) {
                if (settled) return;
                settled = true;
                cleanup();
                if (el.importDialog.open) {
                    el.importDialog.addEventListener('close', function () {
                        resolve(value);
                    }, { once: true });
                    el.importDialog.close();
                } else {
                    resolve(value);
                }
            }

            function cancel() {
                finish(null);
            }

            function onClose() {
                finish(null);
            }

            function onMerge() {
                finish('merge');
            }

            function onReplace() {
                finish('replace');
            }

            function cleanup() {
                el.importMerge.removeEventListener('click', onMerge);
                el.importReplace.removeEventListener('click', onReplace);
                el.importCancel.removeEventListener('click', cancel);
                el.importDialog.removeEventListener('cancel', cancel);
                el.importDialog.removeEventListener('close', onClose);
            }

            el.importSummary.textContent = summaryText;

            el.importMerge.addEventListener('click', onMerge);
            el.importReplace.addEventListener('click', onReplace);
            el.importCancel.addEventListener('click', cancel);
            el.importDialog.addEventListener('cancel', cancel);
            el.importDialog.addEventListener('close', onClose);

            el.importDialog.showModal();
            el.importMerge.focus();
        });
    }

    /* ----------------------------------------------------------------------
       Toast
       ---------------------------------------------------------------------- */

    function hideToast() {
        if (toastTimer) {
            clearTimeout(toastTimer);
            toastTimer = 0;
        }
        el.toast.classList.remove('is-visible');
    }

    function showToast(message, options) {
        options = options || {};
        if (!el.toast) return;

        if (toastTimer) clearTimeout(toastTimer);

        el.toastMessage.textContent = message;
        el.toastAction.hidden = !options.actionLabel;
        el.toastAction.textContent = options.actionLabel || '';
        el.toastAction.onclick = options.onAction
            ? function () {
                hideToast();
                options.onAction();
            }
            : null;

        el.toast.classList.add('is-visible');
        toastTimer = window.setTimeout(hideToast, options.duration || 3200);
    }

    /* ----------------------------------------------------------------------
       單位 / 分類
       ---------------------------------------------------------------------- */

    function promptNewUnit() {
        return openPrompt({
            title: '新增單位',
            label: '單位名稱',
            placeholder: '例如：公里',
            validate: function (value) {
                return state.units.indexOf(value) !== -1 ? '這個單位已存在' : '';
            }
        });
    }

    function promptNewCategory() {
        return openPrompt({
            title: '新增分類',
            label: '分類名稱',
            placeholder: '例如：交通',
            validate: function (value) {
                return state.categories.indexOf(value) !== -1 ? '這個分類已存在' : '';
            }
        });
    }

    function renderFormChips() {
        renderChips(el.unitChips, state.units, formUnit, {
            onPick: function (unit) {
                formUnit = unit;
                state.lastUnit = unit;
                saveState();
                renderFormChips();
            },
            onAdd: async function () {
                var unit = await promptNewUnit();
                if (!unit) return;
                state.units.push(unit);
                formUnit = unit;
                state.lastUnit = unit;
                saveState();
                renderFormChips();
                if (el.editDialog.open) renderEditChips();
            }
        });

        renderChips(el.categoryChips, state.categories, formCategory, {
            onPick: function (category) {
                formCategory = category;
                state.lastCategory = category;
                saveState();
                renderFormChips();
            },
            onAdd: async function () {
                var category = await promptNewCategory();
                if (!category) return;
                state.categories.push(category);
                formCategory = category;
                state.lastCategory = category;
                saveState();
                renderFormChips();
                if (el.editDialog.open) renderEditChips();
            }
        });
    }

    function renderEditChips() {
        renderChips(el.editUnitChips, state.units, editUnit, {
            onPick: function (unit) {
                editUnit = unit;
                renderEditChips();
            },
            onAdd: async function () {
                var unit = await promptNewUnit();
                if (!unit) return;
                state.units.push(unit);
                editUnit = unit;
                saveState();
                renderEditChips();
                renderFormChips();
            }
        });

        renderChips(el.editCategoryChips, state.categories, editCategory, {
            onPick: function (category) {
                editCategory = category;
                renderEditChips();
            },
            onAdd: async function () {
                var category = await promptNewCategory();
                if (!category) return;
                state.categories.push(category);
                editCategory = category;
                saveState();
                renderEditChips();
                renderFormChips();
            }
        });
    }

    /* ----------------------------------------------------------------------
       記錄列表
       ---------------------------------------------------------------------- */

    function sortedEntries() {
        var copy = state.entries.slice();
        var direction = state.prefs.sort === 'asc' ? 1 : -1;

        copy.sort(function (a, b) {
            var timeA = Date.parse(a.time) || 0;
            var timeB = Date.parse(b.time) || 0;
            if (timeA !== timeB) return (timeA - timeB) * direction;
            return String(a.id).localeCompare(String(b.id)) * direction;
        });

        return copy;
    }

    function totalsOf(entries) {
        var map = new Map();
        entries.forEach(function (entry) {
            if (!Number.isFinite(entry.amount)) return;
            var unit = entry.unit || '';
            map.set(unit, (map.get(unit) || 0) + entry.amount);
        });
        return Array.from(map.entries());
    }

    function totalsText(entries) {
        return totalsOf(entries).map(function (pair) {
            return (formatAmount(pair[1]) + ' ' + pair[0]).trim();
        }).join(' · ');
    }

    function matchesQuery(entry, query) {
        if (!query) return true;
        var haystack = [
            entry.amountRaw,
            entry.unit,
            entry.text,
            entry.remarks,
            entry.category,
            locationText(entry)
        ].join(' ').toLowerCase();
        return haystack.indexOf(query) !== -1;
    }

    function renderEntry(entry) {
        var button = make('button', 'entry');
        button.type = 'button';
        button.dataset.id = entry.id;

        var top = make('span', 'entry-top');
        var amount = make('span', 'entry-amount', displayNumber(entry));
        if (entry.unit) amount.appendChild(make('span', 'unit', entry.unit));
        top.appendChild(amount);

        var timeText = state.prefs.viewMode === 'detailed'
            ? formatFullDate(entry.time)
            : formatShortDate(entry.time);
        top.appendChild(make('span', 'entry-time', timeText));
        button.appendChild(top);

        if (entry.text) button.appendChild(make('span', 'entry-text', entry.text));

        if (state.prefs.viewMode === 'detailed') {
            if (entry.remarks) button.appendChild(make('span', 'entry-extra', entry.remarks));
            button.appendChild(make('span', 'entry-extra', '📍 ' + locationText(entry)));
        }

        button.addEventListener('click', function () {
            openEdit(entry.id);
        });

        return button;
    }

    function renderCategory(category, entries) {
        var details = document.createElement('details');
        details.className = 'cat';
        details.open = !collapsedCategories.has(category);

        details.addEventListener('toggle', function () {
            if (details.open) collapsedCategories.delete(category);
            else collapsedCategories.add(category);
        });

        var summary = document.createElement('summary');
        summary.appendChild(make('span', 'cat-name', category));

        var meta = entries.length + ' 筆';
        var subtotal = totalsText(entries);
        if (subtotal) meta += ' · ' + subtotal;
        summary.appendChild(make('span', 'cat-meta', meta));
        details.appendChild(summary);

        var box = make('div', 'entries');
        entries.forEach(function (entry) {
            box.appendChild(renderEntry(entry));
        });
        details.appendChild(box);

        return details;
    }

    function renderRecords() {
        el.recordCount.textContent = String(state.entries.length);

        var allTotals = totalsText(state.entries);
        el.summary.textContent = state.entries.length
            ? '共 ' + state.entries.length + ' 筆' + (allTotals ? ' · ' + allTotals : '')
            : '';

        var query = searchQuery.trim().toLowerCase();
        var entries = sortedEntries().filter(function (entry) {
            return matchesQuery(entry, query);
        });

        el.dataList.textContent = '';

        if (!entries.length) {
            var empty = make('div', 'empty');
            empty.appendChild(make('p', '', state.entries.length ? '找不到符合的記錄' : '還沒有任何記錄'));
            if (!state.entries.length) {
                empty.appendChild(make('p', 'empty-sub', '切換到「輸入」開始記一筆。'));
            }
            el.dataList.appendChild(empty);
            return;
        }

        var groups = new Map();
        entries.forEach(function (entry) {
            if (!groups.has(entry.category)) groups.set(entry.category, []);
            groups.get(entry.category).push(entry);
        });

        groups.forEach(function (items, category) {
            el.dataList.appendChild(renderCategory(category, items));
        });
    }

    /* ----------------------------------------------------------------------
       新增記錄
       ---------------------------------------------------------------------- */

    function flagAmountInvalid(message) {
        el.amountField.classList.add('is-invalid');
        el.amountInput.setAttribute('aria-invalid', 'true');
        el.amountInput.focus();
        showToast(message);
    }

    function clearAmountInvalid() {
        el.amountField.classList.remove('is-invalid');
        el.amountInput.removeAttribute('aria-invalid');
    }

    function saveEntry(event) {
        event.preventDefault();

        if (el.entryForm.dataset.busy === '1') return;

        var raw = el.amountInput.value.trim();
        var amount = parseAmount(raw);

        if (!raw) {
            flagAmountInvalid('請輸入數字');
            return;
        }
        if (!Number.isFinite(amount)) {
            flagAmountInvalid('請輸入有效的數字');
            return;
        }

        var entry = {
            id: uid(),
            amountRaw: raw,
            amount: amount,
            unit: formUnit,
            text: el.textInput.value.trim(),
            remarks: el.remarksInput.value.trim(),
            category: formCategory,
            time: nowISO(),
            location: null,
            locationNote: ''
        };

        state.entries.push(entry);
        state.lastUnit = formUnit;
        state.lastCategory = formCategory;
        saveState();
        renderRecords();

        // 防止連點造成重複寫入
        el.entryForm.dataset.busy = '1';
        var submitButton = el.entryForm.querySelector('[type="submit"]');
        submitButton.disabled = true;
        window.setTimeout(function () {
            submitButton.disabled = false;
            delete el.entryForm.dataset.busy;
        }, 400);

        el.amountInput.value = '';
        el.textInput.value = '';
        el.remarksInput.value = '';
        clearAmountInvalid();
        el.amountInput.focus();

        showToast('已儲存');

        if (state.prefs.recordLocation) requestLocation(entry.id);
    }

    function requestLocation(entryId) {
        if (!('geolocation' in navigator)) {
            updateLocationNote(entryId, '定位不可用');
            return;
        }

        try {
            navigator.geolocation.getCurrentPosition(
                function (position) {
                    var entry = findEntry(entryId);
                    if (!entry) return;
                    entry.location = {
                        lat: position.coords.latitude,
                        lng: position.coords.longitude
                    };
                    entry.locationNote = '';
                    saveState();
                    if (!el.panelRecords.hidden) renderRecords();
                },
                function (error) {
                    updateLocationNote(entryId, error && error.code === 1 ? '未授權定位' : '無法獲取位置');
                },
                { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
            );
        } catch (err) {
            updateLocationNote(entryId, '無法獲取位置');
        }
    }

    function updateLocationNote(entryId, note) {
        var entry = findEntry(entryId);
        if (!entry) return;
        entry.locationNote = note;
        saveState();
        if (!el.panelRecords.hidden) renderRecords();
    }

    function findEntry(id) {
        for (var i = 0; i < state.entries.length; i++) {
            if (state.entries[i].id === id) return state.entries[i];
        }
        return null;
    }

    /* ----------------------------------------------------------------------
       編輯記錄
       ---------------------------------------------------------------------- */

    function openEdit(id) {
        var entry = findEntry(id);
        if (!entry) return;

        openEntryId = id;
        editUnit = entry.unit || state.units[0];
        editCategory = entry.category || state.categories[0];

        el.editAmount.value = entry.amountRaw || formatAmount(entry.amount);
        el.editText.value = entry.text || '';
        el.editRemarks.value = entry.remarks || '';
        el.editMeta.textContent = formatFullDate(entry.time) + ' · ' + locationText(entry);
        el.editAmount.classList.remove('is-invalid');

        renderEditChips();
        el.editDialog.showModal();
        el.editAmount.focus();
    }

    function submitEdit(event) {
        event.preventDefault();

        var entry = findEntry(openEntryId);
        if (!entry) {
            el.editDialog.close();
            return;
        }

        var raw = el.editAmount.value.trim();
        var amount = parseAmount(raw);

        if (!raw || !Number.isFinite(amount)) {
            el.editAmount.classList.add('is-invalid');
            el.editAmount.focus();
            showToast('請輸入有效的數字');
            return;
        }

        entry.amountRaw = raw;
        entry.amount = amount;
        entry.unit = editUnit;
        entry.text = el.editText.value.trim();
        entry.category = editCategory;
        entry.remarks = el.editRemarks.value.trim();

        saveState();
        el.editDialog.close();
        renderRecords();
        showToast('已更新');
    }

    async function deleteCurrentEntry() {
        var entry = findEntry(openEntryId);
        if (!entry) return;

        var label = displayNumber(entry) + (entry.unit ? ' ' + entry.unit : '') +
            (entry.text ? '（' + entry.text + '）' : '');

        var confirmed = await openConfirm({
            title: '刪除這筆記錄？',
            message: label,
            okText: '刪除',
            danger: true
        });
        if (!confirmed) return;

        var index = state.entries.findIndex(function (item) {
            return item.id === entry.id;
        });
        if (index === -1) return;

        state.entries.splice(index, 1);
        saveState();
        el.editDialog.close();
        renderRecords();

        showToast('已刪除', {
            actionLabel: '復原',
            duration: 6000,
            onAction: function () {
                state.entries.splice(Math.min(index, state.entries.length), 0, entry);
                saveState();
                renderRecords();
                showToast('已復原');
            }
        });
    }

    /* ----------------------------------------------------------------------
       CSV
       ---------------------------------------------------------------------- */

    function csvEscape(value) {
        var text = value == null ? '' : String(value);
        if (/[",\r\n]/.test(text)) {
            return '"' + text.replace(/"/g, '""') + '"';
        }
        return text;
    }

    /**
     * RFC 4180 風格的 CSV 解析器：
     * 支援引號內逗號、換行、跳脫引號（""）、CRLF 與 BOM。
     */
    function parseCSV(text) {
        var source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
        var rows = [];
        var row = [];
        var field = '';
        var inQuotes = false;
        var i = 0;

        while (i < source.length) {
            var char = source[i];

            if (inQuotes) {
                if (char === '"') {
                    if (source[i + 1] === '"') {
                        field += '"';
                        i += 2;
                        continue;
                    }
                    inQuotes = false;
                    i += 1;
                    continue;
                }
                field += char;
                i += 1;
                continue;
            }

            if (char === '"') {
                inQuotes = true;
                i += 1;
                continue;
            }
            if (char === ',') {
                row.push(field);
                field = '';
                i += 1;
                continue;
            }
            if (char === '\r' || char === '\n') {
                if (char === '\r' && source[i + 1] === '\n') i += 1;
                row.push(field);
                rows.push(row);
                row = [];
                field = '';
                i += 1;
                continue;
            }

            field += char;
            i += 1;
        }

        if (field.length || row.length) {
            row.push(field);
            rows.push(row);
        }

        return rows.filter(function (cells) {
            return cells.some(function (cell) {
                return String(cell).trim() !== '';
            });
        });
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    function exportCSV() {
        if (!state.entries.length) {
            showToast('尚無資料可匯出');
            return;
        }

        var rows = state.entries.map(function (entry) {
            return [
                entry.amountRaw,
                entry.unit,
                entry.text,
                entry.remarks,
                entry.category,
                formatFullDate(entry.time),
                locationText(entry)
            ];
        });

        var csv = '\uFEFF' +
            [CSV_HEADER].concat(rows).map(function (row) {
                return row.map(csvEscape).join(',');
            }).join('\r\n') + '\r\n';

        var now = new Date();
        var stamp = '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
            '-' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());

        downloadBlob(
            new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
            stamp + ' Immeasurable Ledger.csv'
        );
    }

    function detectColumns(headerRow) {
        var normalized = headerRow.map(function (cell) {
            return String(cell).trim().toLowerCase();
        });

        var map = {};
        Object.keys(CSV_ALIASES).forEach(function (key) {
            var aliases = CSV_ALIASES[key];
            for (var i = 0; i < normalized.length; i++) {
                if (aliases.indexOf(normalized[i]) !== -1) {
                    map[key] = i;
                    return;
                }
            }
        });

        return map.number != null ? map : null;
    }

    function entryFingerprint(entry) {
        return [entry.time, entry.amountRaw, entry.unit, entry.text, entry.category].join('\u0001');
    }

    function registerEntryNames(entries) {
        entries.forEach(function (entry) {
            if (entry.unit && state.units.indexOf(entry.unit) === -1) state.units.push(entry.unit);
            if (entry.category && state.categories.indexOf(entry.category) === -1) state.categories.push(entry.category);
        });
        if (state.units.indexOf(state.lastUnit) === -1) state.lastUnit = state.units[0];
        if (state.categories.indexOf(state.lastCategory) === -1) state.lastCategory = state.categories[0];
    }

    async function importCSVFile(file) {
        var text;

        try {
            text = await file.text();
        } catch (err) {
            showToast('讀取檔案失敗');
            return;
        }

        var rows = parseCSV(text);
        if (!rows.length) {
            showToast('檔案是空的');
            return;
        }

        var mapping = detectColumns(rows[0]);
        var column = mapping || POSITIONAL_COLUMNS;
        var dataRows = mapping ? rows.slice(1) : rows;

        var imported = dataRows.map(function (row) {
            function cell(key) {
                var index = column[key];
                if (index == null || row[index] == null) return '';
                return String(row[index]).trim();
            }

            var raw = cell('number');
            var amount = parseAmount(raw);
            if (!raw || !Number.isFinite(amount)) return null;

            var parsedLocation = parseLocationCell(cell('location'));

            return {
                id: uid(),
                amountRaw: raw,
                amount: amount,
                unit: cell('unit'),
                text: cell('text'),
                remarks: cell('remarks'),
                category: cell('category') || '未分類',
                time: parseTime(cell('time')),
                location: parsedLocation.location,
                locationNote: parsedLocation.note
            };
        }).filter(Boolean);

        if (!imported.length) {
            showToast('CSV 中沒有可匯入的資料');
            return;
        }

        var mode = await openImportChoice('找到 ' + imported.length + ' 筆可匯入的資料。');
        if (!mode) return;

        registerEntryNames(imported);

        if (mode === 'replace') {
            state.entries = imported;
            showToast('已取代並匯入 ' + imported.length + ' 筆');
        } else {
            var fingerprints = new Set(state.entries.map(entryFingerprint));
            var added = 0;

            imported.forEach(function (entry) {
                var fingerprint = entryFingerprint(entry);
                if (fingerprints.has(fingerprint)) return;
                fingerprints.add(fingerprint);
                state.entries.push(entry);
                added += 1;
            });

            showToast(added ? '已合併 ' + added + ' 筆' : '沒有新資料（全部重複）');
        }

        if (state.units.indexOf(formUnit) === -1) formUnit = state.lastUnit;
        if (state.categories.indexOf(formCategory) === -1) formCategory = state.lastCategory;

        saveState();
        renderFormChips();
        renderRecords();
    }

    /* ----------------------------------------------------------------------
       清空
       ---------------------------------------------------------------------- */

    async function clearAll() {
        if (!state.entries.length) {
            showToast('目前沒有資料');
            return;
        }

        var first = await openConfirm({
            title: '清空所有資料？',
            message: '此操作無法復原。建議先匯出 CSV 作為備份。',
            okText: '匯出並繼續'
        });
        if (!first) return;

        exportCSV();

        var second = await openConfirm({
            title: '確定要清空嗎？',
            message: '備份已匯出，確認刪除全部記錄？',
            okText: '確認清空',
            danger: true
        });
        if (!second) return;

        state.entries = [];
        state.units = DEFAULT_UNITS.slice();
        state.categories = DEFAULT_CATEGORIES.slice();
        state.lastUnit = DEFAULT_UNITS[0];
        state.lastCategory = DEFAULT_CATEGORIES[0];
        formUnit = state.lastUnit;
        formCategory = state.lastCategory;
        searchQuery = '';
        el.searchInput.value = '';
        collapsedCategories.clear();

        saveState();
        renderFormChips();
        renderRecords();
        showToast('已清空');
    }

    /* ----------------------------------------------------------------------
       頁籤
       ---------------------------------------------------------------------- */

    function switchTab(name) {
        if (name !== 'records') name = 'input';
        currentTab = name;

        var isInput = name === 'input';
        el.tabInput.setAttribute('aria-selected', String(isInput));
        el.tabRecords.setAttribute('aria-selected', String(!isInput));
        el.panelInput.hidden = !isInput;
        el.panelRecords.hidden = isInput;

        if (!isInput) renderRecords();
    }

    /* ----------------------------------------------------------------------
       使用說明（內容來自 help.js，可自由修改）
       ---------------------------------------------------------------------- */

    function appendInline(parent, text) {
        var parts = String(text).split(/\*\*(.+?)\*\*/g);
        parts.forEach(function (part, index) {
            if (!part) return;
            if (index % 2 === 1) {
                parent.appendChild(make('strong', '', part));
            } else {
                parent.appendChild(document.createTextNode(part));
            }
        });
    }

    function renderHelp() {
        var raw = typeof window.WULIANGBU_HELP === 'string' ? window.WULIANGBU_HELP : '';

        el.helpBody.textContent = '';

        if (!raw.trim()) {
            el.helpBody.appendChild(make('p', '', '找不到說明內容。請確認 help.js 是否存在且格式正確。'));
            return;
        }

        var lines = raw.replace(/\r\n?/g, '\n').split('\n');
        var list = null;

        lines.forEach(function (line) {
            var text = line.trim();

            if (!text) {
                list = null;
                return;
            }

            if (text.indexOf('## ') === 0) {
                list = null;
                el.helpBody.appendChild(make('h3', '', text.slice(3).trim()));
                return;
            }

            if (text.indexOf('- ') === 0) {
                if (!list) {
                    list = make('ul', 'help-list');
                    el.helpBody.appendChild(list);
                }
                var item = document.createElement('li');
                appendInline(item, text.slice(2).trim());
                list.appendChild(item);
                return;
            }

            if (text.indexOf('> ') === 0) {
                list = null;
                var note = make('div', 'help-note');
                appendInline(note, text.slice(2).trim());
                el.helpBody.appendChild(note);
                return;
            }

            list = null;
            var paragraph = document.createElement('p');
            appendInline(paragraph, text);
            el.helpBody.appendChild(paragraph);
        });
    }

    function openHelp() {
        renderHelp();
        el.helpDialog.showModal();
        el.helpClose.focus();
    }

    /* ----------------------------------------------------------------------
       事件綁定
       ---------------------------------------------------------------------- */

    function cacheElements() {
        var ids = [
            'tabInput', 'tabRecords', 'panelInput', 'panelRecords', 'recordCount',
            'storageWarning', 'entryForm', 'amountField', 'amountInput', 'unitChips',
            'textInput', 'categoryChips', 'remarksInput', 'recordLocation',
            'searchInput', 'sortBtn', 'detailToggle', 'exportBtn', 'importBtn',
            'clearBtn', 'importFile', 'summary', 'dataList',
            'editDialog', 'editForm', 'editClose', 'editAmount', 'editUnitChips',
            'editText', 'editCategoryChips', 'editRemarks', 'editMeta',
            'editDelete', 'editCancel', 'editSave',
            'promptDialog', 'promptForm', 'promptTitle', 'promptClose',
            'promptInput', 'promptLabel', 'promptError', 'promptCancel', 'promptOk',
            'confirmDialog', 'confirmTitle', 'confirmMessage', 'confirmCancel', 'confirmOk',
            'importDialog', 'importSummary', 'importMerge', 'importReplace', 'importCancel',
            'helpDialog', 'helpBody', 'helpBtn', 'helpClose', 'helpOk',
            'toast', 'toastMessage', 'toastAction'
        ];

        ids.forEach(function (id) {
            el[id] = $(id);
        });
        el.tabs = document.querySelector('.tabs');
    }

    function bindEvents() {
        el.tabInput.addEventListener('click', function () { switchTab('input'); });
        el.tabRecords.addEventListener('click', function () { switchTab('records'); });

        el.tabs.addEventListener('keydown', function (event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            var next = currentTab === 'input' ? 'records' : 'input';
            switchTab(next);
            (next === 'input' ? el.tabInput : el.tabRecords).focus();
        });

        el.entryForm.addEventListener('submit', saveEntry);
        el.amountInput.addEventListener('input', clearAmountInvalid);

        el.recordLocation.addEventListener('change', function () {
            state.prefs.recordLocation = el.recordLocation.checked;
            saveState();
        });

        el.searchInput.addEventListener('input', function () {
            searchQuery = el.searchInput.value;
            renderRecords();
        });

        el.sortBtn.addEventListener('click', function () {
            state.prefs.sort = state.prefs.sort === 'desc' ? 'asc' : 'desc';
            saveState();
            updateSortButton();
            renderRecords();
        });

        el.detailToggle.addEventListener('change', function () {
            state.prefs.viewMode = el.detailToggle.checked ? 'detailed' : 'simple';
            saveState();
            renderRecords();
        });

        el.exportBtn.addEventListener('click', exportCSV);
        el.importBtn.addEventListener('click', function () {
            el.importFile.click();
        });
        el.importFile.addEventListener('change', function (event) {
            var file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (file) importCSVFile(file);
        });
        el.clearBtn.addEventListener('click', clearAll);

        el.editForm.addEventListener('submit', submitEdit);
        el.editAmount.addEventListener('input', function () {
            el.editAmount.classList.remove('is-invalid');
        });
        el.editClose.addEventListener('click', function () { el.editDialog.close(); });
        el.editCancel.addEventListener('click', function () { el.editDialog.close(); });
        el.editDelete.addEventListener('click', deleteCurrentEntry);
        el.editDialog.addEventListener('close', function () {
            openEntryId = null;
            el.editAmount.classList.remove('is-invalid');
        });

        el.helpBtn.addEventListener('click', openHelp);
        el.helpClose.addEventListener('click', function () { el.helpDialog.close(); });
        el.helpOk.addEventListener('click', function () { el.helpDialog.close(); });

        // 點擊對話框外部（backdrop）關閉
        [el.editDialog, el.promptDialog, el.confirmDialog, el.importDialog, el.helpDialog].forEach(function (dialog) {
            dialog.addEventListener('click', function (event) {
                if (event.target === dialog) dialog.close();
            });
        });
    }

    function updateSortButton() {
        el.sortBtn.textContent = state.prefs.sort === 'desc' ? '新 → 舊' : '舊 → 新';
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js').catch(function (err) {
                console.warn('Service Worker 註冊失敗', err);
            });
        });
    }

    /* ----------------------------------------------------------------------
       啟動
       ---------------------------------------------------------------------- */

    function init() {
        cacheElements();

        storageAvailable = detectStorage();
        if (!storageAvailable) el.storageWarning.hidden = false;

        state = loadState();
        formUnit = state.lastUnit;
        formCategory = state.lastCategory;

        el.detailToggle.checked = state.prefs.viewMode === 'detailed';
        el.recordLocation.checked = state.prefs.recordLocation;

        bindEvents();
        updateSortButton();
        renderFormChips();
        renderRecords();
        saveState();

        if (!storageAvailable) {
            showToast('本機儲存不可用，關閉頁面後資料會消失', { duration: 6000 });
        }

        registerServiceWorker();
    }

    init();
})();
