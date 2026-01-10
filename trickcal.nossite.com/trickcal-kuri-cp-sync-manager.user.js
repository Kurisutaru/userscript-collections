// ==UserScript==
// @name         Kuri CP : Nossite Trickcal Enhancer
// @namespace    https://www.kurisutaru.net/
// @version      1.13
// @description  Enhances Trickcal with a custom control panel: local & Pantry.cloud sync (with auto-sync), JSON backup/restore, real-time layer bonus stats, and UI cleanup.
// @author       Kurisutaru
// @match        https://trickcal.nossite.com/*
// @downloadURL  https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/trickcal.nossite.com/trickcal-kuri-cp-sync-manager.user.js
// @updateURL    https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/trickcal.nossite.com/trickcal-kuri-cp-sync-manager.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================
       CONSTANTS & CONFIGURATION
       ================================================ */
    const CONFIG = {
        STORAGE_KEYS: [
            'trickcal_board_progress',
            'trickcal_language',
            'trickcal_sweep_selected_materials',
            'trickcal_theme',
        ],
        BASKET_NAME: 'kurisutaru.trickcal.nossite',
        AUTO_SYNC_DEFAULT_INTERVAL: 300,
        MUTATION_CHECK_INTERVAL: 2000,
        STATS_UPDATE_DELAY: 100,
        NOTIFICATION_DURATION: 3000,
        MIN_AUTO_SYNC_INTERVAL: 10,
        STATUS_RESET_DELAY: 3000,
        DEFAULT_LAYER_MULTIPLIERS: {
            layer1: { attack: 3, crit: 3, defense: 3, critResist: 3, hp: 3 },
            layer2: { attack: 4, crit: 4, defense: 4, critResist: 4, hp: 4 },
            layer3: { attack: 5, crit: 5, defense: 5, critResist: 5, hp: 5 }
        },
        MENU_ITEMS: [
            { id: 'sync_now', icon: '🔄', name: 'Sync Now', desc: 'Save current data to storage' },
            { id: 'open_config', icon: '⚙️', name: 'Configuration', desc: 'Open overlay to edit sync & backup settings' }
        ],
        DEBUG_MODE: false
    };

    /* ================================================
       STATE MANAGEMENT
       ================================================ */
    const AppState = {
        autoSyncInterval: null,
        lastSyncDate: null,
        isDropdownOpen: false,
        lastCheckedGoogleBtn: null,
        lastCheckedUsageDiv: null,
        currentDropdown: null,
        pantryClient: null,
        boardDataCache: null,
        cachedBoardProgress: null,
        lastBoardProgressRaw: null,
        domCache: {
            navActions: null,
            layerPanel: null,
            googleBtn: null,
            usageDiv: null
        }
    };

    /* ================================================
       EVENT MANAGER - Priority 2: Proper Cleanup
       ================================================ */
    class EventManager {
        constructor() {
            this.listeners = [];
        }

        add(element, event, handler, options = {}) {
            if (!element) return;
            element.addEventListener(event, handler, options);
            this.listeners.push({ element, event, handler, options });
        }

        remove(element, event, handler) {
            const index = this.listeners.findIndex(
                l => l.element === element && l.event === event && l.handler === handler
            );
            if (index !== -1) {
                const { element: el, event: evt, handler: h } = this.listeners[index];
                el.removeEventListener(evt, h);
                this.listeners.splice(index, 1);
            }
        }

        removeAll() {
            this.listeners.forEach(({ element, event, handler }) => {
                if (element && element.removeEventListener) {
                    element.removeEventListener(event, handler);
                }
            });
            this.listeners = [];
        }
    }

    const eventManager = new EventManager();

    /* ================================================
       DOM CACHE MANAGER - Priority 3: Cache DOM Queries
       ================================================ */
    const DOMCache = {
        cache: {},

        get(selector, forceRefresh = false) {
            if (forceRefresh || !this.cache[selector] || !document.contains(this.cache[selector])) {
                this.cache[selector] = document.querySelector(selector);
            }
            return this.cache[selector];
        },

        getAll(selector, forceRefresh = false) {
            if (forceRefresh) {
                return document.querySelectorAll(selector);
            }
            return document.querySelectorAll(selector);
        },

        clear(selector = null) {
            if (selector) {
                delete this.cache[selector];
            } else {
                this.cache = {};
            }
        },

        refresh() {
            AppState.domCache.navActions = this.get('.nav-actions', true);
            AppState.domCache.layerPanel = this.get('.layer-panel', true);
            AppState.domCache.googleBtn = this.get('.google-signin-btn span', true);
            AppState.domCache.usageDiv = this.get('div.usage-counter', true);
        }
    };

    /* ================================================
       STORAGE MANAGER - Priority 4: Extract Constants
       ================================================ */
    const StorageManager = {
        getLocalData() {
            const data = {};
            CONFIG.STORAGE_KEYS.forEach(k => {
                const v = localStorage.getItem(k);
                if (v !== null) data[k] = v;
            });
            return data;
        },

        setLocalData(data) {
            Object.keys(data).forEach(k => {
                if (CONFIG.STORAGE_KEYS.includes(k)) {
                    localStorage.setItem(k, data[k]);
                }
            });
        },

        clearLocalData() {
            CONFIG.STORAGE_KEYS.forEach(k => localStorage.removeItem(k));
        },

        getBoardProgress() {
            const raw = localStorage.getItem('trickcal_board_progress');
            if (raw === AppState.lastBoardProgressRaw && AppState.cachedBoardProgress) {
                return AppState.cachedBoardProgress;
            }

            AppState.lastBoardProgressRaw = raw;
            try {
                AppState.cachedBoardProgress = raw ? JSON.parse(raw) : null;
            } catch (e) {
                console.error('Failed to parse board progress:', e);
                AppState.cachedBoardProgress = null;
            }
            return AppState.cachedBoardProgress;
        },

        invalidateBoardProgressCache() {
            AppState.cachedBoardProgress = null;
            AppState.lastBoardProgressRaw = null;
        }
    };

    /* ================================================
       GM STORAGE WRAPPER
       ================================================ */
    const GMStorage = {
        get(key, defaultValue = null) {
            return GM_getValue(key, defaultValue);
        },

        set(key, value) {
            GM_setValue(key, value);
        },

        delete(key) {
            GM_deleteValue(key);
        },

        getPantryId() {
            return this.get('pantry_id', '').trim();
        },

        setPantryId(id) {
            this.set('pantry_id', id.trim());
        },

        isOnlineSyncEnabled() {
            return this.get('online_sync_enabled', false);
        },

        isAutoSyncEnabled() {
            return this.get('auto_sync_enabled', false);
        },

        getAutoSyncInterval() {
            return this.get('auto_sync_interval', CONFIG.AUTO_SYNC_DEFAULT_INTERVAL);
        },

        getLastSyncDate() {
            const dateStr = this.get('last_sync_date', new Date().toISOString());
            return new Date(dateStr);
        },

        setLastSyncDate(date = new Date()) {
            this.set('last_sync_date', date.toISOString());
            const dateElement = DOMCache.get('#kuri-last-sync-date');
            if (dateElement) {
                dateElement.innerHTML = Utils.formatDateTime(date);
            }
        },

        getLayerMultipliers() {
            const saved = this.get('layer_multipliers', null);
            return saved ? JSON.parse(saved) : CONFIG.DEFAULT_LAYER_MULTIPLIERS;
        },

        setLayerMultipliers(multipliers) {
            this.set('layer_multipliers', JSON.stringify(multipliers));
        },

        initLayerMultipliers() {
            if (!this.get('layer_multipliers', null)) {
                this.setLayerMultipliers(CONFIG.DEFAULT_LAYER_MULTIPLIERS);
            }
        }
    };

    /* ================================================
       UTILITIES - Priority 4: Extract Constants
       ================================================ */
    const Utils = {
        formatDateTime(date) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        },

        getCurrentTheme() {
            return document.body.getAttribute('data-theme') || 'dark';
        },

        getCSSVar(varName) {
            return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        },

        debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        }
    };

    /* ================================================
       STATUS INDICATOR CLASS - Priority 5: Refactor
       ================================================ */
    class StatusIndicator {
        constructor(element) {
            this.element = element;
            this.timeout = null;
        }

        set(status) {
            if (!this.element) return;

            clearTimeout(this.timeout);
            this.element.className = `kuri-status-indicator kuri-status-${status}`;

            if (['success', 'error'].includes(status)) {
                this.timeout = setTimeout(() => {
                    this.set('idle');
                }, CONFIG.STATUS_RESET_DELAY);
            }
        }

        clear() {
            clearTimeout(this.timeout);
        }
    }

    /* ================================================
       KURIPOPUP CLASS
       ================================================ */
    class KuriPopup {
        constructor({
                        title = 'Info',
                        content = '',
                        yesText = null,
                        yesCallback = null,
                        noText = null,
                        noCallback = null,
                        closeOnOverlay = true
                    } = {}) {
            this.title = title;
            this.content = content;
            this.yesText = yesText;
            this.yesCallback = yesCallback;
            this.noText = noText;
            this.noCallback = noCallback;
            this.closeOnOverlay = closeOnOverlay;
            this.overlay = null;
            this.panel = null;
            this.escHandler = null;
            this.create();
        }

        create() {
            this.remove();

            this.overlay = document.createElement('div');
            this.overlay.className = 'kuri-popup-overlay';

            this.panel = document.createElement('div');
            this.panel.className = 'kuri-popup-panel';

            const titleEl = document.createElement('h3');
            titleEl.textContent = this.title;
            titleEl.className = 'kuri-popup-title';

            const contentEl = document.createElement('div');
            contentEl.innerHTML = this.content;
            contentEl.className = 'kuri-popup-content';

            const btnContainer = document.createElement('div');
            btnContainer.className = 'kuri-popup-btn-container';

            if (this.yesText) {
                const yesBtn = document.createElement('button');
                yesBtn.textContent = this.yesText;
                yesBtn.className = 'kuri-btn-base kuri-popup-yes-btn';
                yesBtn.onclick = () => {
                    this.yesCallback?.();
                    this.remove();
                };
                btnContainer.appendChild(yesBtn);
            }

            if (this.noText) {
                const noBtn = document.createElement('button');
                noBtn.textContent = this.noText;
                noBtn.className = 'kuri-btn-base kuri-popup-no-btn';
                noBtn.onclick = () => {
                    this.noCallback?.();
                    this.remove();
                };
                btnContainer.appendChild(noBtn);
            }

            if (!this.yesText && !this.noText) {
                const okBtn = document.createElement('button');
                okBtn.textContent = 'OK';
                okBtn.className = 'kuri-btn-base kuri-popup-ok-btn';
                okBtn.onclick = () => this.remove();
                btnContainer.appendChild(okBtn);
            }

            this.panel.appendChild(titleEl);
            this.panel.appendChild(contentEl);
            this.panel.appendChild(btnContainer);
            this.overlay.appendChild(this.panel);
            document.body.appendChild(this.overlay);

            if (this.closeOnOverlay) {
                eventManager.add(this.overlay, 'click', (e) => {
                    if (e.target === this.overlay) this.remove();
                });
            }

            this.escHandler = (e) => {
                if (e.key === 'Escape') {
                    this.remove();
                }
            };
            eventManager.add(document, 'keydown', this.escHandler);
        }

        remove() {
            if (this.overlay && this.overlay.parentNode) {
                this.overlay.classList.add('kuri-popup-fade-out');
                this.panel.classList.add('kuri-popup-scale-out');
                setTimeout(() => {
                    this.overlay.remove();
                    if (this.escHandler) {
                        eventManager.remove(document, 'keydown', this.escHandler);
                    }
                }, 200);
            }
        }
    }

    /* ================================================
       PANTRY CLIENT
       ================================================ */
    class Pantry {
        constructor(pantryId) {
            if (!pantryId) throw new Error('Pantry ID required');
            this.base = `https://getpantry.cloud/apiv1/pantry/${pantryId}`;
        }

        _req(method, url, data = null) {
            return new Promise((resolve, reject) => {
                const opts = {
                    method,
                    url,
                    responseType: 'json',
                    headers: { 'Content-Type': 'application/json' },
                    onload: r => (r.status >= 200 && r.status < 300)
                        ? resolve(r.response)
                        : reject(new Error(`${r.status} ${r.statusText}`)),
                    onerror: reject
                };
                if (data) opts.data = JSON.stringify(data);
                if (typeof GM !== 'undefined' && GM.xmlHttpRequest) {
                    GM.xmlHttpRequest(opts);
                } else if (typeof GM_xmlhttpRequest !== 'undefined') {
                    GM_xmlhttpRequest(opts);
                } else {
                    reject(new Error('No HTTP client'));
                }
            });
        }

        details() {
            return this._req('GET', this.base);
        }

        basket = {
            get: name => this._req('GET', `${this.base}/basket/${name}`),
            create: (name, data) => this._req('POST', `${this.base}/basket/${name}`, data),
            update: (name, data) => this._req('PUT', `${this.base}/basket/${name}`, data),
            delete: name => this._req('DELETE', `${this.base}/basket/${name}`)
        };
    }

    /* ================================================
       SYNC MANAGER - Priority 5: Separate Concerns
       ================================================ */
    const SyncManager = {
        initPantryClient() {
            const id = GMStorage.getPantryId();
            if (id) {
                try {
                    AppState.pantryClient = new Pantry(id);
                } catch (e) {
                    AppState.pantryClient = null;
                    UIManager.showNotification('Invalid Pantry ID', 'error');
                }
            } else {
                AppState.pantryClient = null;
            }
        },

        async syncLocal(statusIndicator) {
            try {
                if (statusIndicator) statusIndicator.set('syncing');

                const data = StorageManager.getLocalData();
                const now = new Date();

                GMStorage.set('trickcal_sync_data', JSON.stringify({
                    data,
                    timestamp: now.toISOString()
                }));

                GMStorage.setLastSyncDate(now);

                if (statusIndicator) statusIndicator.set('success');
                UIManager.showNotification('✅ Local sync successful!', 'success');
            } catch (e) {
                if (statusIndicator) statusIndicator.set('error');
                UIManager.showNotification('❌ Local sync failed: ' + e.message, 'error');
                console.error(e);
            }
        },

        async syncOnline(statusIndicator) {
            if (!AppState.pantryClient) {
                UIManager.showNotification('Pantry ID not set', 'warning');
                return;
            }

            try {
                if (statusIndicator) statusIndicator.set('syncing');

                const data = StorageManager.getLocalData();
                GMStorage.setLastSyncDate(new Date());

                await AppState.pantryClient.basket.create(CONFIG.BASKET_NAME, data);

                if (statusIndicator) statusIndicator.set('success');
                UIManager.showNotification('✅ Online sync successful!', 'success');
            } catch (e) {
                if (statusIndicator) statusIndicator.set('error');
                UIManager.showNotification('Online sync failed: ' + e.message, 'error');
                console.error('Pantry sync error:', e);
            }
        },

        async clearAndPullLocal(statusIndicator) {
            try {
                if (statusIndicator) statusIndicator.set('syncing');

                const raw = GMStorage.get('trickcal_sync_data', null);
                if (!raw) {
                    if (statusIndicator) statusIndicator.set('idle');
                    return UIManager.showNotification('No local synced data', 'warning');
                }

                const { data } = JSON.parse(raw);
                StorageManager.clearLocalData();
                StorageManager.setLocalData(data);

                if (statusIndicator) statusIndicator.set('success');
                UIManager.showNotification('Local data restored!', 'success');
                setTimeout(() => location.reload(), 1000);
            } catch (e) {
                if (statusIndicator) statusIndicator.set('error');
                UIManager.showNotification('Pull failed: ' + e.message, 'error');
                console.error(e);
            }
        },

        async forceResyncOnline(statusIndicator) {
            if (!AppState.pantryClient) {
                return UIManager.showNotification('Pantry ID not set', 'warning');
            }

            try {
                if (statusIndicator) statusIndicator.set('syncing');

                const remote = await AppState.pantryClient.basket.get(CONFIG.BASKET_NAME);
                StorageManager.clearLocalData();
                StorageManager.setLocalData(remote);

                if (statusIndicator) statusIndicator.set('success');
                UIManager.showNotification('Online data pulled!', 'success');
                setTimeout(() => location.reload(), 1000);
            } catch (e) {
                if (statusIndicator) statusIndicator.set('error');
                if (e.message.includes('404')) {
                    UIManager.showNotification('No online data found', 'warning');
                } else {
                    UIManager.showNotification('Pull failed: ' + e.message, 'error');
                }
                console.error(e);
            }
        },

        startAutoSync(seconds, indicator) {
            try {
                this.stopAutoSync();
                AppState.autoSyncInterval = setInterval(() => {
                    this.syncLocal(indicator).then(() => {
                        if (GMStorage.isOnlineSyncEnabled() && AppState.pantryClient) {
                            this.syncOnline(indicator);
                        }
                    });
                }, seconds * 1000);
                GMStorage.set('auto_sync_interval', seconds);
                GMStorage.set('auto_sync_enabled', true);
                UIManager.showNotification(`⏱️ Auto-sync started (${seconds}s)`, 'info');
            } catch (e) {
                console.error('startAutoSync error', e);
            }
        },

        stopAutoSync() {
            if (AppState.autoSyncInterval) {
                clearInterval(AppState.autoSyncInterval);
            }
            AppState.autoSyncInterval = null;
            GMStorage.delete('auto_sync_enabled');
        }
    };

    /* ================================================
       BACKUP MANAGER
       ================================================ */
    const BackupManager = {
        exportToJson() {
            const raw = GMStorage.get('trickcal_sync_data', null);
            if (!raw) {
                return UIManager.showNotification('⚠️ Nothing to export', 'warning');
            }

            const blob = new Blob([raw], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `trickcal-backup.${Utils.formatDateTime(new Date()).replace(' ', '_')}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            UIManager.showNotification('📤 Exported JSON backup', 'success');
        },

        importFromJson() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = async e => {
                const f = e.target.files[0];
                if (!f) return;

                try {
                    const text = await f.text();
                    const parsed = JSON.parse(text);

                    GMStorage.set('trickcal_sync_data', JSON.stringify({
                        data: parsed.data || parsed,
                        timestamp: new Date().toISOString()
                    }));

                    StorageManager.clearLocalData();
                    StorageManager.setLocalData(parsed.data || parsed);
                    UIManager.showNotification('📥 Imported JSON! Reloading...', 'success');
                    setTimeout(() => location.reload(), 1000);
                } catch (err) {
                    UIManager.showNotification('❌ Import failed: ' + err.message, 'error');
                }
            };
            input.click();
        }
    };

    /* ================================================
       BOARD DATA MANAGER - Priority 3: Cache
       ================================================ */
    const BoardDataManager = {
        async fetchBoardData() {
            if (AppState.boardDataCache) {
                return AppState.boardDataCache;
            }

            try {
                const response = await fetch('/board/data.json');
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                AppState.boardDataCache = await response.json();
                return AppState.boardDataCache;
            } catch (err) {
                console.error('Failed to fetch board data:', err);
                return null;
            }
        },

        getTotalCellsFromBoardData(layerNumber) {
            if (!AppState.boardDataCache || !AppState.boardDataCache.characterBoards) {
                return { attack: '?', crit: '?', hp: '?', defense: '?', critResist: '?' };
            }

            const layerKey = `layer${layerNumber}`;
            const totals = { attack: 0, crit: 0, hp: 0, defense: 0, critResist: 0 };

            Object.values(AppState.boardDataCache.characterBoards).forEach(character => {
                const layer = character[layerKey];
                if (layer && Array.isArray(layer)) {
                    layer.forEach(cellType => {
                        if (totals.hasOwnProperty(cellType)) {
                            totals[cellType]++;
                        }
                    });
                }
            })

            return totals;
        }
    };

    /* ================================================
       LAYER STATS MANAGER - Priority 5: Refactor
       ================================================ */
    const LayerStatsManager = {
        getCurrentActiveLayer() {
            const activeTab = DOMCache.get('.layer-panel .tab-btn.active');
            if (activeTab) {
                const match = activeTab.textContent.trim().match(/Layer (\d+)/i);
                if (match) return parseInt(match[1], 10);
            }
            return 1;
        },

        calculateLayerStats(layerNumber) {
            const boardProgress = StorageManager.getBoardProgress();

            if (!boardProgress) {
                return {
                    attack: { count: '?', total: '?', percentage: '?' },
                    crit: { count: '?', total: '?', percentage: '?' },
                    hp: { count: '?', total: '?', percentage: '?' },
                    defense: { count: '?', total: '?', percentage: '?' },
                    critResist: { count: '?', total: '?', percentage: '?' }
                };
            }

            const activatedCells = boardProgress.activatedCells || {};
            const multipliers = GMStorage.getLayerMultipliers();
            const layerKey = `layer${layerNumber}`;
            const layerMultiplier = multipliers[layerKey] || CONFIG.DEFAULT_LAYER_MULTIPLIERS[layerKey];

            const stats = { attack: 0, crit: 0, hp: 0, defense: 0, critResist: 0 };

            Object.keys(activatedCells).forEach(key => {
                if (activatedCells[key] === true) {
                    const parts = key.split('_');
                    if (parts.length >= 3) {
                        const keyLayer = parts[parts.length - 2];
                        const statusType = parts[parts.length - 1];

                        if (keyLayer === layerKey && stats.hasOwnProperty(statusType)) {
                            stats[statusType]++;
                        }
                    }
                }
            });

            const totals = BoardDataManager.getTotalCellsFromBoardData(layerNumber);

            return {
                attack: {
                    percentage: Math.floor(stats.attack * layerMultiplier.attack),
                    count: stats.attack,
                    total: totals.attack
                },
                crit: {
                    percentage: Math.floor(stats.crit * layerMultiplier.crit),
                    count: stats.crit,
                    total: totals.crit
                },
                hp: {
                    percentage: Math.floor(stats.hp * layerMultiplier.hp),
                    count: stats.hp,
                    total: totals.hp
                },
                defense: {
                    percentage: Math.floor(stats.defense * layerMultiplier.defense),
                    count: stats.defense,
                    total: totals.defense
                },
                critResist: {
                    percentage: Math.floor(stats.critResist * layerMultiplier.critResist),
                    count: stats.critResist,
                    total: totals.critResist
                }
            };
        },

        createLayerStatsDisplay(stats) {
            return `
                <div class="panel-card kuri-layer-stats">
                    <div class="layer-summary">
                        <h3 class="kuri-summary-title">Layer Bonus Stats</h3>
                        <div class="kuri-stat-item">
                            <span class="kuri-stat-label">Attack</span>
                            <span class="kuri-stat-value">+${stats.attack.percentage}% [${stats.attack.count}/${stats.attack.total}]</span>
                        </div>
                        <div class="kuri-stat-item">
                            <span class="kuri-stat-label">Critical</span>
                            <span class="kuri-stat-value">+${stats.crit.percentage}% [${stats.crit.count}/${stats.crit.total}]</span>
                        </div>
                        <div class="kuri-stat-item">
                            <span class="kuri-stat-label">HP</span>
                            <span class="kuri-stat-value">+${stats.hp.percentage}% [${stats.hp.count}/${stats.hp.total}]</span>
                        </div>
                        <div class="kuri-stat-item">
                            <span class="kuri-stat-label">Crit Resist</span>
                            <span class="kuri-stat-value">+${stats.critResist.percentage}% [${stats.critResist.count}/${stats.critResist.total}]</span>
                        </div>
                        <div class="kuri-stat-item">
                            <span class="kuri-stat-label">Defense</span>
                            <span class="kuri-stat-value">+${stats.defense.percentage}% [${stats.defense.count}/${stats.defense.total}]</span>
                        </div>
                    </div>
                </div>
            `;
        },

        updateLayerStatsDisplay(layerNumber) {
            const stats = this.calculateLayerStats(layerNumber);
            const existingStats = DOMCache.get('.kuri-layer-stats');
            const statsHTML = this.createLayerStatsDisplay(stats);

            if (existingStats) {
                existingStats.outerHTML = statsHTML;
            } else {
                const firstPanelCard = DOMCache.get('.layer-panel .panel-card');
                if (firstPanelCard) {
                    firstPanelCard.insertAdjacentHTML('afterend', statsHTML);
                }
            }
            DOMCache.clear('.kuri-layer-stats');
        },

        initLayerStatsDisplay() {
            const layerPanel = DOMCache.get('.layer-panel');
            if (!layerPanel) return false;

            GMStorage.initLayerMultipliers();

            BoardDataManager.fetchBoardData().then(() => {
                const currentLayer = this.getCurrentActiveLayer();
                this.updateLayerStatsDisplay(currentLayer);

                const tabButtons = DOMCache.getAll('.layer-panel .tab-btn');
                tabButtons.forEach((btn, index) => {
                    const handler = () => {
                        setTimeout(() => {
                            const layerNum = index + 1;
                            this.updateLayerStatsDisplay(layerNum);
                        }, CONFIG.STATS_UPDATE_DELAY);
                    };
                    eventManager.add(btn, 'click', handler);
                });
            });

            return true;
        },

        watchLocalStorageChanges() {
            const originalSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                originalSetItem.apply(this, arguments);
                if (key === 'trickcal_board_progress') {
                    StorageManager.invalidateBoardProgressCache();
                    setTimeout(() => {
                        const currentLayer = LayerStatsManager.getCurrentActiveLayer();
                        LayerStatsManager.updateLayerStatsDisplay(currentLayer);
                    }, CONFIG.STATS_UPDATE_DELAY);
                }
            };
        }
    };

    /* ================================================
       UI MANAGER - Priority 5: Separate Concerns
       ================================================ */
    const UIManager = {
        showNotification(message, type = 'info', duration = CONFIG.NOTIFICATION_DURATION) {
            let container = DOMCache.get('.kuri-notification-container');
            if (!container) {
                container = document.createElement('div');
                container.className = 'kuri-notification-container';
                document.body.appendChild(container);
            }

            const notif = document.createElement('div');
            notif.className = `kuri-notification kuri-notification-${type}`;
            notif.textContent = message;
            container.appendChild(notif);

            void notif.offsetWidth;

            setTimeout(() => {
                notif.classList.add('kuri-notification-exit');
                eventManager.add(notif, 'animationend', () => notif.remove());
            }, duration);
        },

        createSyncDropdown() {
            const container = document.createElement('div');
            container.className = 'kuri-cp-container';

            const mainButton = document.createElement('button');
            mainButton.className = 'kuri-cp-button';
            const chevron = document.createElement('span');
            chevron.className = 'kuri-cp-chevron';
            chevron.textContent = '▼';
            mainButton.innerHTML = `<span>⚙️</span><span>Kuri CP</span>`;
            mainButton.appendChild(chevron);

            const statusIndicatorElement = document.createElement('span');
            statusIndicatorElement.className = 'kuri-status-indicator kuri-status-idle';
            const statusIndicator = new StatusIndicator(statusIndicatorElement);

            const dropdownMenu = document.createElement('div');
            dropdownMenu.className = 'kuri-dropdown-menu';

            const dropdownHeader = document.createElement('div');
            dropdownHeader.className = 'kuri-dropdown-header';
            dropdownHeader.innerHTML = `<h3>Kurisutaru CP Sync</h3>`;
            dropdownMenu.appendChild(dropdownHeader);

            const list = document.createElement('div');
            list.className = 'kuri-dropdown-list';

            CONFIG.MENU_ITEMS.forEach(item => {
                const btn = document.createElement('button');
                btn.className = 'kuri-dropdown-item';
                btn.innerHTML = `<span class="kuri-dropdown-icon">${item.icon}</span><div class="kuri-dropdown-text"><div class="kuri-dropdown-name">${item.name}</div><div class="kuri-dropdown-desc">${item.desc}</div></div>`;

                const handler = async (e) => {
                    e.stopPropagation();
                    dropdownMenu.classList.remove('kuri-dropdown-open');
                    AppState.isDropdownOpen = false;
                    mainButton.classList.remove('active');
                    await this.handleSyncAction(item.id, statusIndicator);
                };

                eventManager.add(btn, 'click', handler);
                list.appendChild(btn);
            });
            dropdownMenu.appendChild(list);

            const mainButtonHandler = (e) => {
                e.stopPropagation();
                AppState.isDropdownOpen = !AppState.isDropdownOpen;
                if (AppState.isDropdownOpen) {
                    dropdownMenu.classList.add('kuri-dropdown-open');
                    mainButton.classList.add('active');
                } else {
                    dropdownMenu.classList.remove('kuri-dropdown-open');
                    mainButton.classList.remove('active');
                }
            };
            eventManager.add(mainButton, 'click', mainButtonHandler);

            const documentClickHandler = (e) => {
                if (!container.contains(e.target)) {
                    dropdownMenu.classList.remove('kuri-dropdown-open');
                    AppState.isDropdownOpen = false;
                    mainButton.classList.remove('active');
                }
            };
            eventManager.add(document, 'click', documentClickHandler);

            container.appendChild(mainButton);
            container.appendChild(statusIndicatorElement);
            container.appendChild(dropdownMenu);
            return { container, statusIndicator };
        },

        async handleSyncAction(action, indicator) {
            if (action === 'open_config') {
                return this.createConfigOverlay(indicator);
            }
            if (action === 'sync_now') {
                await SyncManager.syncLocal(indicator);
                if (GMStorage.isOnlineSyncEnabled() && AppState.pantryClient) {
                    await SyncManager.syncOnline(indicator);
                }
            }
        },

        createConfigOverlay(statusIndicator) {
            if (DOMCache.get('.kuri-config-overlay')) return;

            const overlay = document.createElement('div');
            overlay.className = 'kuri-config-overlay';

            const panel = document.createElement('div');
            panel.className = 'kuri-config-panel';

            const enabled = GMStorage.isAutoSyncEnabled();
            const interval = GMStorage.getAutoSyncInterval();
            const lastSyncDate = GMStorage.getLastSyncDate();
            const onlineEnabled = GMStorage.isOnlineSyncEnabled();
            const pantryId = GMStorage.getPantryId();

            panel.innerHTML = `
                <div class="kuri-config-header">
                    <h3>⚙️ Kurisutaru CP Config</h3>
                </div>
                <h3 class="kuri-config-section-title">🗂️ Sync Options</h3>
                <div class="kuri-config-row">
                    <span>Last Sync Date</span>
                    <span id="kuri-last-sync-date">${!isNaN(lastSyncDate) ? Utils.formatDateTime(lastSyncDate) : '-'}</span>
                </div>
                <hr class="kuri-config-divider">
                <div class="kuri-config-row">
                    <span>Enable Auto Sync</span>
                    <label class="kuri-switch"><input type="checkbox" id="cfg-autosync-toggle" ${enabled ? 'checked' : ''}><span class="kuri-slider"></span></label>
                </div>
                <div class="kuri-config-input-group">
                    <label>Auto Sync Interval (seconds):</label>
                    <input id="cfg-autosync" type="number" min="10" step="10" class="kuri-config-input" value="${interval}">
                </div>
                <div class="kuri-config-btn-group">
                    <button id="btn-sync-now" class="kuri-btn-base kuri-btn-primary kuri-flex-1">🔄 Sync Now</button>
                    <button id="btn-force-resync" class="kuri-btn-base kuri-btn-secondary kuri-flex-1">🗑️ Force Resync</button>
                </div>
                <hr class="kuri-config-divider">
                <h3 class="kuri-config-section-title">🌐 Online Sync</h3>
                <div class="kuri-config-row">
                    <span>Enable Online Sync</span>
                    <label class="kuri-switch"><input type="checkbox" id="cfg-online-toggle" ${onlineEnabled ? 'checked' : ''}><span class="kuri-slider"></span></label>
                </div>
                <div class="kuri-config-input-group">
                    <label>🍊Pantry ID <span id="pantry-info" class="kuri-config-info-btn">[?]</span></label>
                    <input id="cfg-pantry-id" type="text" placeholder="Your Pantry ID" class="kuri-config-input" value="${pantryId}">
                </div>
                <div class="kuri-config-btn-group">
                    <button id="btn-online-sync" class="kuri-btn-base kuri-btn-primary kuri-flex-1">🔄 Sync Now</button>
                    <button id="btn-online-pull" class="kuri-btn-base kuri-btn-secondary kuri-flex-1">🗑️ Force Resync</button>
                </div>
                <hr class="kuri-config-divider">
                <h3 class="kuri-config-section-title">💾 Backup Options</h3>
                <div class="kuri-config-btn-group">
                    <button id="btn-export" class="kuri-btn-base kuri-btn-success kuri-flex-1">📤 Export JSON</button>
                    <button id="btn-import" class="kuri-btn-base kuri-btn-warning kuri-flex-1">📥 Import JSON</button>
                </div>
                <div class="kuri-config-footer">
                    <button id="cfg-save" class="kuri-btn-base kuri-popup-yes-btn">Save</button>
                    <button id="cfg-close" class="kuri-btn-base kuri-popup-no-btn">Cancel</button>
                </div>
            `;

            overlay.appendChild(panel);
            document.body.appendChild(overlay);

            // Event Handlers
            eventManager.add(panel.querySelector('#pantry-info'), 'click', () => {
                new KuriPopup({
                    title: '🪣getPantry.cloud',
                    content: `You can create your free online storage at<br><a href="https://getpantry.cloud" target="_blank" style="color:var(--primary-color);text-decoration:none;font-weight:bold;">getPantry.cloud</a>.`,
                    yesText: 'getPantry.cloud',
                    yesCallback: () => window.open("https://getpantry.cloud", "_blank"),
                    noText: 'Ok',
                });
            });

            eventManager.add(panel.querySelector('#btn-sync-now'), 'click', () => {
                SyncManager.syncLocal(statusIndicator).then(() => {
                    if (GMStorage.isOnlineSyncEnabled() && AppState.pantryClient) {
                        SyncManager.syncOnline(statusIndicator);
                    }
                });
            });

            eventManager.add(panel.querySelector('#btn-force-resync'), 'click', () => {
                new KuriPopup({
                    title: '🔄 Force Local Resync ?',
                    content: 'This will clear and pull from local sync. Continue?',
                    yesText: 'Yes',
                    yesCallback: () => SyncManager.clearAndPullLocal(statusIndicator),
                    noText: 'Cancel',
                });
            });

            eventManager.add(panel.querySelector('#btn-online-sync'), 'click', () => {
                if (!AppState.pantryClient) {
                    UIManager.showNotification('Pantry ID not set', 'warning');
                    return;
                }
                SyncManager.syncLocal(statusIndicator).then(() => SyncManager.syncOnline(statusIndicator));
            });

            eventManager.add(panel.querySelector('#btn-online-pull'), 'click', () => {
                if (!AppState.pantryClient) {
                    UIManager.showNotification('Pantry ID not set', 'warning');
                    return;
                }
                new KuriPopup({
                    title: '🔄 Force Online Resync ?',
                    content: 'This will pull from Pantry and overwrite local data. Continue?',
                    yesText: 'Yes',
                    yesCallback: () => SyncManager.forceResyncOnline(statusIndicator),
                    noText: 'Cancel',
                });
            });

            eventManager.add(panel.querySelector('#btn-export'), 'click', BackupManager.exportToJson);
            eventManager.add(panel.querySelector('#btn-import'), 'click', BackupManager.importFromJson);

            eventManager.add(panel.querySelector('#cfg-close'), 'click', () => {
                overlay.remove();
                DOMCache.clear('.kuri-config-overlay');
            });

            eventManager.add(overlay, 'click', (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    DOMCache.clear('.kuri-config-overlay');
                }
            });

            eventManager.add(panel.querySelector('#cfg-save'), 'click', () => {
                const seconds = parseInt(panel.querySelector('#cfg-autosync').value, 10);
                const autoEnabled = panel.querySelector('#cfg-autosync-toggle').checked;
                const onlineEnabled = panel.querySelector('#cfg-online-toggle').checked;
                const pantryId = panel.querySelector('#cfg-pantry-id').value.trim();

                if (isNaN(seconds) || seconds < CONFIG.MIN_AUTO_SYNC_INTERVAL) {
                    return UIManager.showNotification(`Interval must be ≥${CONFIG.MIN_AUTO_SYNC_INTERVAL}s`, 'error');
                }

                GMStorage.set('auto_sync_interval', seconds);
                GMStorage.set('online_sync_enabled', onlineEnabled);

                if (pantryId) GMStorage.setPantryId(pantryId);
                else GMStorage.delete('pantry_id');

                SyncManager.initPantryClient();

                if (autoEnabled) SyncManager.startAutoSync(seconds, statusIndicator);
                else SyncManager.stopAutoSync();

                UIManager.showNotification(`Saved! Auto: ${autoEnabled ? seconds + 's' : 'Off'} | Online: ${onlineEnabled && pantryId ? 'On' : 'Off'}`, 'success');
                overlay.remove();
                DOMCache.clear('.kuri-config-overlay');
            });
        },

        removeGoogleSignInText() {
            const googleBtn = DOMCache.get('.google-signin-btn span');
            if (googleBtn && googleBtn.textContent.includes('Sign in with Google')) {
                googleBtn.remove();
                return true;
            }
            return false;
        },

        removeTotalUsageText() {
            const usageDiv = DOMCache.get('div.usage-counter');
            if (usageDiv) {
                usageDiv.remove();
                return true;
            }
            return false;
        }
    };

    /* ================================================
       INJECTION MANAGER
       ================================================ */
    const InjectionManager = {
        injectDropdown() {
            const navActions = DOMCache.get('.nav-actions', true);
            const existing = DOMCache.get('[data-injected="true"]');

            if (navActions && !existing) {
                const { container, statusIndicator } = UIManager.createSyncDropdown();
                container.setAttribute('data-injected', 'true');
                navActions.prepend(container);
                AppState.currentDropdown = container;

                console.log('✅ Kuri CP Sync Manager injected!');

                if (GMStorage.isAutoSyncEnabled()) {
                    const interval = GMStorage.getAutoSyncInterval();
                    SyncManager.startAutoSync(interval, statusIndicator);
                }

                return true;
            }
            return false;
        },

        checkAndReinject() {
            const existing = DOMCache.get('[data-injected="true"]');
            if (existing && document.contains(existing)) {
                AppState.currentDropdown = existing;
                return;
            }

            const navActions = DOMCache.get('.nav-actions');
            if (navActions && !existing) {
                this.injectDropdown();
            }
        },

        checkAndInjectLayerStats() {
            const layerPanel = DOMCache.get('.layer-panel');
            if (layerPanel && !layerPanel.hasAttribute('data-kuri-stats-injected')) {
                layerPanel.setAttribute('data-kuri-stats-injected', 'true');
                if (LayerStatsManager.initLayerStatsDisplay()) {
                    LayerStatsManager.watchLocalStorageChanges();
                }
            }
        }
    };

    /* ================================================
       THEME WATCHER
       ================================================ */
    function watchThemeChanges() {
        const themeObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                    const newTheme = Utils.getCurrentTheme();
                    const container = DOMCache.get('.kuri-cp-container');
                    if (container) {
                        container.setAttribute('data-current-theme', newTheme);
                    }
                }
            });
        });

        themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    /* ================================================
       INITIALIZATION
       ================================================ */
    function init() {
        // Initialize managers
        SyncManager.initPantryClient();
        GMStorage.initLayerMultipliers();

        // Initial injection
        InjectionManager.injectDropdown();
        watchThemeChanges();
        UIManager.removeGoogleSignInText();
        UIManager.removeTotalUsageText();

        // Setup MutationObserver
        const observer = new MutationObserver(() => {
            if (!observer.throttled) {
                observer.throttled = true;
                requestAnimationFrame(() => {
                    InjectionManager.checkAndReinject();
                    UIManager.removeGoogleSignInText();
                    UIManager.removeTotalUsageText();
                    InjectionManager.checkAndInjectLayerStats();
                    observer.throttled = false;
                });
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Backup polling (keeping as requested)
        setInterval(() => {
            DOMCache.refresh();
            InjectionManager.checkAndReinject();
            UIManager.removeGoogleSignInText();
            UIManager.removeTotalUsageText();
            InjectionManager.checkAndInjectLayerStats();
        }, CONFIG.MUTATION_CHECK_INTERVAL);
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        eventManager.add(document, 'DOMContentLoaded', init);
    } else {
        init();
    }

    // Cleanup on unload
    eventManager.add(window, 'beforeunload', () => {
        eventManager.removeAll();
        SyncManager.stopAutoSync();
    });

    // CSS styles (keeping original styles)
    const style = document.createElement('style');
    style.textContent = `
    /* ===================================
       ANIMATIONS
       =================================== */
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(400px); opacity: 0; }
    }

    @keyframes dropdownSlideIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes scaleOut {
      from { opacity: 1; transform: scale(1); }
      to { opacity: 0; transform: scale(0.95); }
    }

    @keyframes fadeOut {
      from { opacity: 1; }
      to { opacity: 0; }
    }

    /* ===================================
       UTILITY CLASSES (Atomic Layer)
       =================================== */

    /* --- Spacing --- */
    .kuri-p-xs { padding: 6px; }
    .kuri-p-sm { padding: 8px; }
    .kuri-p-md { padding: 12px; }
    .kuri-p-lg { padding: 20px; }

    .kuri-px-sm { padding-left: 8px; padding-right: 8px; }
    .kuri-px-md { padding-left: 12px; padding-right: 12px; }
    .kuri-px-lg { padding-left: 16px; padding-right: 16px; }

    .kuri-py-sm { padding-top: 8px; padding-bottom: 8px; }
    .kuri-py-md { padding-top: 12px; padding-bottom: 12px; }

    .kuri-pt-md { padding-top: 12px; }
    .kuri-pb-xs { padding-bottom: 4px; }

    .kuri-m-0 { margin: 0; }
    .kuri-mt-xs { margin-top: 4px; }
    .kuri-mt-sm { margin-top: 8px; }
    .kuri-mt-md { margin-top: 12px; }
    .kuri-mt-lg { margin-top: 20px; }
    .kuri-mb-sm { margin-bottom: 8px; }
    .kuri-mb-md { margin-bottom: 12px; }
    .kuri-mr-sm { margin-right: 8px; }
    .kuri-mr-md { margin-right: 12px; }

    .kuri-gap-xs { gap: 4px; }
    .kuri-gap-sm { gap: 8px; }
    .kuri-gap-md { gap: 12px; }
    .kuri-gap-lg { gap: 20px; }

    /* --- Layout --- */
    .kuri-flex { display: flex; }
    .kuri-inline-flex { display: inline-flex; }
    .kuri-flex-col { flex-direction: column; }
    .kuri-items-center { align-items: center; }
    .kuri-items-start { align-items: flex-start; }
    .kuri-justify-between { justify-content: space-between; }
    .kuri-justify-center { justify-content: center; }
    .kuri-justify-start { justify-content: flex-start; }
    .kuri-flex-1 { flex: 1; }

    .kuri-relative { position: relative; }
    .kuri-absolute { position: absolute; }
    .kuri-fixed { position: fixed; }

    .kuri-inset-0 { top: 0; left: 0; right: 0; bottom: 0; }

    .kuri-w-full { width: 100%; }
    .kuri-w-auto { width: auto; }
    .kuri-min-w-260 { min-width: 260px; }

    .kuri-max-w-90vw { max-width: 90vw; }

    /* --- Display --- */
    .kuri-block { display: block; }
    .kuri-inline-block { display: inline-block; }
    .kuri-hidden { display: none; }

    /* --- Borders & Radius --- */
    .kuri-rounded-xs { border-radius: 4px; }
    .kuri-rounded-sm { border-radius: 6px; }
    .kuri-rounded-md { border-radius: 8px; }
    .kuri-rounded-lg { border-radius: 12px; }
    .kuri-rounded-full { border-radius: 50%; }
    .kuri-rounded-pill { border-radius: 22px; }

    .kuri-border { border: 2px solid var(--border-color); }
    .kuri-border-1 { border: 1px solid var(--border-color); }
    .kuri-border-none { border: none; }
    .kuri-border-primary { border-color: var(--primary-color); }

    .kuri-border-b { border-bottom: 1px solid var(--border-color); }
    .kuri-border-t { border-top: 1px solid var(--border-color); }

    /* --- Backgrounds --- */
    .kuri-bg-transparent { background: transparent; }
    .kuri-bg-card { background: var(--card-bg); }
    .kuri-bg-panel { background: var(--panel-bg); }
    .kuri-bg-overlay { background: var(--overlay-bg); }
    .kuri-bg-hover { background: var(--hover-bg); }
    .kuri-bg-button { background: var(--button-bg); }

    .kuri-bg-primary { background: var(--primary-color); }
    .kuri-bg-primary-soft { background: var(--primary-bg); }
    .kuri-bg-primary-hover { background: var(--primary-hover); }

    .kuri-bg-success { background: var(--success-color); }
    .kuri-bg-success-soft { background: var(--success-bg); }

    .kuri-bg-warning { background: var(--warning-color); }
    .kuri-bg-warning-soft { background: var(--warning-bg); }

    .kuri-bg-secondary { background: var(--secondary-bg); }

    /* --- Text --- */
    .kuri-text-primary { color: var(--text-primary); }
    .kuri-text-secondary { color: var(--text-secondary); }
    .kuri-text-tertiary { color: var(--text-tertiary); }
    .kuri-text-white { color: white; }

    .kuri-text-color-primary { color: var(--primary-color); }
    .kuri-text-color-success { color: var(--success-color); }
    .kuri-text-color-warning { color: var(--warning-text); }

    .kuri-text-xs { font-size: 10px; }
    .kuri-text-sm { font-size: 12px; }
    .kuri-text-md { font-size: 14px; }
    .kuri-text-base { font-size: 1rem; }
    .kuri-text-lg { font-size: 1.1rem; }
    .kuri-text-xl { font-size: 1.4rem; }

    .kuri-font-normal { font-weight: normal; }
    .kuri-font-medium { font-weight: 500; }
    .kuri-font-semibold { font-weight: 600; }
    .kuri-font-bold { font-weight: bold; }

    .kuri-text-center { text-align: center; }
    .kuri-text-left { text-align: left; }
    .kuri-text-right { text-align: right; }

    .kuri-uppercase { text-transform: uppercase; }
    .kuri-letter-spacing-sm { letter-spacing: 0.5px; }

    .kuri-line-height-normal { line-height: 1.5; }

    /* --- Effects --- */
    .kuri-shadow-sm { box-shadow: var(--shadow-sm); }
    .kuri-shadow-md { box-shadow: var(--shadow-md); }
    .kuri-shadow-lg { box-shadow: var(--shadow-lg); }

    .kuri-backdrop-blur { backdrop-filter: blur(3px); }

    .kuri-opacity-0 { opacity: 0; }

    /* --- Transitions --- */
    .kuri-transition-bg { transition: background-color 0.2s; }
    .kuri-transition-colors { transition: background-color 0.3s, border-color 0.3s; }
    .kuri-transition-all { transition: all 0.2s; }
    .kuri-transition-transform { transition: transform 0.25s ease; }

    /* --- Cursor --- */
    .kuri-cursor-pointer { cursor: pointer; }

    /* --- Z-index --- */
    .kuri-z-9999 { z-index: 9999; }
    .kuri-z-10000 { z-index: 10000; }
    .kuri-z-10001 { z-index: 10001; }

    /* --- Positioning --- */
    .kuri-top-neg-4 { top: -4px; }
    .kuri-right-neg-4 { right: -4px; }
    .kuri-top-20 { top: 20px; }
    .kuri-right-20 { right: 20px; }
    .kuri-top-full-8 { top: calc(100% + 8px); }
    .kuri-right-0 { right: 0; }

    /* --- Sizing --- */
    .kuri-size-10 { width: 10px; height: 10px; }
    .kuri-size-16 { width: 16px; height: 16px; }
    .kuri-w-42 { width: 42px; }
    .kuri-h-22 { height: 22px; }
    .kuri-w-380 { width: 380px; }
    .kuri-w-420 { width: 420px; }

    /* ===================================
       BUTTON UTILITIES
       =================================== */

    /* Base button structure */
    .kuri-btn-base {
      padding: 8px 12px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: normal;
      transition: background 0.2s, color 0.2s;
    }

    /* Primary variants */
    .kuri-btn-primary {
      background: var(--primary-color);
      color: var(--text-primary);
    }

    .kuri-btn-primary:hover {
      background: var(--primary-hover);
    }

    .kuri-btn-primary-soft {
      background: var(--primary-bg);
      color: var(--primary-color);
    }

    .kuri-btn-primary-soft:hover {
      background: var(--primary-color);
      color: var(--text-primary);
    }

    .kuri-btn-primary-outline {
      background: transparent;
      color: var(--primary-color);
      border: 2px solid var(--primary-color);
    }

    .kuri-btn-primary-outline:hover {
      background: var(--primary-bg);
    }

    /* Success variants */
    .kuri-btn-success {
      background: var(--success-color);
      color: var(--text-primary);
    }

    .kuri-btn-success:hover {
      background: color-mix(in srgb, var(--success-color) 85%, black);
    }

    .kuri-btn-success-soft {
      background: var(--success-bg);
      color: var(--success-color);
    }

    .kuri-btn-success-soft:hover {
      background: var(--success-color);
      color: var(--text-primary);
    }

    /* Warning variants */
    .kuri-btn-warning {
      background: var(--warning-color);
      color: var(--text-primary);
    }

    .kuri-btn-warning:hover {
      background: color-mix(in srgb, var(--warning-color) 80%, black);
    }

    .kuri-btn-warning-soft {
      background: var(--warning-bg);
      color: var(--warning-text);
    }

    .kuri-btn-warning-soft:hover {
      background: color-mix(in srgb, var(--warning-bg) 80%, var(--warning-color));
      color: var(--text-primary);
    }

    /* Secondary/Neutral variants */
    .kuri-btn-secondary {
      background: var(--button-bg);
      color: var(--text-primary);
    }

    .kuri-btn-secondary:hover {
      background: var(--button-hover);
    }

    .kuri-btn-ghost {
      background: transparent;
      color: var(--text-primary);
    }

    .kuri-btn-ghost:hover {
      background: var(--hover-bg);
    }

    .kuri-btn-card {
      background: var(--card-bg);
      color: var(--text-primary);
      border: 2px solid var(--border-color);
    }

    .kuri-btn-card:hover {
      border-color: var(--primary-color);
      background: var(--primary-bg);
    }

    /* ===================================
       COMPONENT CLASSES
       =================================== */

    /* Legacy shorthand for compatibility */
    .kuri-btn {
      flex: 1;
      padding: 8px 12px;
      border: none;
      border-radius: 6px;
      background: var(--primary-color);
      color: var(--text-primary);
      cursor: pointer;
      font-weight: normal;
    }

    .kuri-btn:hover {
      background: var(--primary-hover);
    }

    /* --- Switch Toggle --- */
    .kuri-switch {
      position: relative;
      display: inline-block;
      width: 42px;
      height: 22px;
    }

    .kuri-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .kuri-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--border-color);
      transition: .2s;
      border-radius: 22px;
    }

    .kuri-slider:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background: white;
      transition: .2s;
      border-radius: 50%;
    }

    .kuri-switch input:checked + .kuri-slider {
      background: var(--primary-color);
    }

    .kuri-switch input:checked + .kuri-slider:before {
      transform: translateX(20px);
    }

    /* --- Popup Overlay & Panel --- */
    .kuri-popup-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10001;
      backdrop-filter: blur(3px);
      animation: fadeIn 0.25s ease forwards;
      max-width: 200vw;
      max-height: 200vw;
    }

    .kuri-popup-overlay.kuri-popup-fade-out {
      animation: fadeOut 0.2s ease forwards;
    }

    .kuri-popup-panel {
      background: var(--card-bg);
      border: 2px solid var(--border-color);
      border-radius: 12px;
      box-shadow: var(--shadow-lg);
      padding: 20px;
      width: 380px;
      max-width: 90vw;
      color: var(--text-primary);
      font-family: var(--site-font);
      animation: scaleIn 0.25s ease forwards;
      text-align: center;
    }

    .kuri-popup-panel.kuri-popup-scale-out {
      animation: scaleOut 0.2s ease forwards;
    }

    .kuri-popup-title {
      margin: 0 0 12px;
      font-size: 1.1rem;
    }

    .kuri-popup-content {
      font-size: 14px;
      margin: 12px 0;
      line-height: 1.5;
    }

    .kuri-popup-btn-container {
      margin-top: 20px;
      display: flex;
      gap: 8px;
      justify-content: center;
    }

    /* Popup Button Variants */
    .kuri-popup-yes-btn {
      background: var(--primary-bg);
      color: var(--primary-color);
      font-weight: 500;
    }

    .kuri-popup-yes-btn:hover {
      background: var(--primary-color);
      color: var(--text-primary);
    }

    .kuri-popup-no-btn {
      background: var(--warning-bg);
      color: var(--warning-text);
    }

    .kuri-popup-no-btn:hover {
      background: color-mix(in srgb, var(--warning-bg) 80%, var(--warning-color));
      color: var(--text-primary);
    }

    .kuri-popup-ok-btn {
      background: var(--success-color);
      color: var(--text-primary);
    }

    .kuri-popup-ok-btn:hover {
      background: color-mix(in srgb, var(--success-color) 85%, black);
    }

    /* --- CP Container & Button --- */
    .kuri-cp-container {
      position: relative;
      margin-right: 12px;
      display: inline-block;
    }

    .kuri-cp-button {
      padding: 8px 16px;
      border-radius: 8px;
      border: 2px solid var(--border-color);
      background: var(--card-bg);
      color: var(--text-primary);
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-start;
    }

    .kuri-cp-button:hover,
    .kuri-cp-button.active {
      border-color: var(--primary-color) !important;
      background: var(--primary-bg) !important;
      transition: background-color .3s, border-color .3s;
    }

    .kuri-cp-button span {
      background: transparent !important;
      padding: 0 !important;
      margin: 0 !important;
      border-radius: 0 !important;
      display: inline !important;
    }

    .kuri-cp-button > span:first-child {
      margin-right: 8px;
    }

    .kuri-cp-chevron {
      font-size: 10px;
      transition: transform 0.25s ease;
      display: inline-block;
    }

    .kuri-cp-button.active .kuri-cp-chevron {
      transform: rotate(180deg);
    }

    /* --- Status Indicator --- */
    .kuri-status-indicator {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid var(--card-bg);
    }

    .kuri-status-idle {
      background: #ccc;
    }

    .kuri-status-syncing {
      background: #ffa500;
    }

    .kuri-status-success {
      background: #4caf50;
    }

    .kuri-status-error {
      background: #f44336;
    }

    /* --- Dropdown Menu --- */
    .kuri-dropdown-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: var(--card-bg);
      border: 2px solid var(--border-color);
      border-radius: 12px;
      box-shadow: var(--shadow-lg);
      min-width: 260px;
      display: none;
      z-index: 9999;
      animation: dropdownSlideIn .2s ease;
      text-align: left;
    }

    .kuri-dropdown-menu.kuri-dropdown-open {
      display: block;
    }

    .kuri-dropdown-header {
      padding: 1rem 1rem 0.5rem;
      border-bottom: 1px solid var(--border-color);
    }

    .kuri-dropdown-header h3 {
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-secondary);
      font-family: var(--site-font);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .kuri-dropdown-list {
      padding: 0.5rem;
    }

    .kuri-dropdown-item {
      width: 100%;
      padding: 0.75rem;
      border: none;
      background: transparent;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      color: var(--text-primary);
      cursor: pointer;
      border-radius: 8px;
      transition: background 0.2s;
      justify-content: flex-start;
      text-align: left;
    }

    .kuri-dropdown-item:hover {
      background: var(--hover-bg);
    }

    .kuri-dropdown-icon {
      font-size: 20px;
    }

    .kuri-dropdown-text {
      text-align: left;
    }

    .kuri-dropdown-name {
      font-weight: 500;
    }

    .kuri-dropdown-desc {
      font-size: 12px;
      color: var(--text-secondary);
    }
    
    /* --- Toast --- */
    .toast-container {
        position: fixed;
        top: 1rem;
        right: 1rem;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.5rem;
        z-index: 9999;
    }
    
    .toast {
        background: var(--card-bg, #333);
        color: var(--text-color, #fff);
        padding: 10px 16px;
        border-radius: 6px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        opacity: 0;
        transform: translateY(20px);
        transition: transform 0.35s ease, opacity 0.35s ease;
        pointer-events: auto;
        min-width: 200px;
        max-width: 300px;
    }
    
    /* Appear */
    .toast.show {
        opacity: 1;
        transform: translateY(0);
    }
    
    /* Disappear */
    .toast.hide {
        opacity: 0;
        transform: translateY(-20px);
    }
    
    /* Optional color variants */
    .toast-info {
        background: #2196f3;
    }
    .toast-success {
        background: #4caf50;
    }
    .toast-warning {
        background: #ff9800;
    }
    .toast-error {
        background: #f44336;
    }

    /* --- Notification --- */
    .kuri-notification-container {
      position: fixed;
      top: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      z-index: 10000;
      pointer-events: none;
    }
    
    /* Each notification smoothly shifts upward when others are removed */
    .kuri-notification {
      position: relative;
      margin-top: 10px;
      padding: 12px 20px;
      border-radius: 6px;
      color: #fff;
      box-shadow: var(--shadow-md);
      z-index: 10000;
      font-size: 14px;
      animation: slideIn 0.35s cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto;
      transition: transform 0.35s ease, opacity 0.35s ease;
      transform-origin: top right;
      will-change: transform, opacity;
    }
    
    .kuri-notification.kuri-notification-exit {
      animation: slideOut 0.3s ease forwards;
    }
    
    /* Slight spacing illusion — newer toast slides from below */
    .kuri-notification-container .kuri-notification:not(:last-child) {
      transform: translateY(0);
    }

    .kuri-notification-success {
      background: var(--success-color);
    }

    .kuri-notification-error {
      background: var(--primary-color);
    }

    .kuri-notification-warning {
      background: var(--warning-color);
    }

    .kuri-notification-info {
      background: #2196f3;
    }

    /* --- Config Overlay --- */
    .kuri-config-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      backdrop-filter: blur(3px);
    }

    .kuri-config-panel {
      background: var(--card-bg);
      border: 2px solid var(--border-color);
      border-radius: 12px;
      box-shadow: var(--shadow-lg);
      padding: 20px;
      width: 420px;
      color: var(--text-primary);
      font-family: var(--site-font);
      animation: fadeIn .25s ease;
    }

    .kuri-config-header {
      border-bottom: 1px solid var(--border-color);
    }

    .kuri-config-header h3 {
      font-size: 1.4rem;
    }

    .kuri-config-section-title {
      font-size: 1rem;
      margin-top: 12px;
    }

    .kuri-config-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 6px 0;
    }

    .kuri-config-divider {
      margin: 18px 0;
      border: none;
      border-top: 1px solid var(--border-color);
    }

    .kuri-config-input-group {
      margin: 8px 0;
    }

    .kuri-config-input {
      width: 100%;
      margin-top: 4px;
      padding: 6px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      background: var(--card-bg);
      color: var(--text-primary);
    }

    .kuri-config-info-btn {
      cursor: pointer;
      color: var(--primary-color);
      font-weight: bold;
    }

    .kuri-config-btn-group {
      margin-top: 12px;
      display: flex;
      gap: 8px;
    }

    .kuri-config-footer {
      text-align: right;
      margin-top: 20px;
    }
    
    /* --- Added for Calculate Counter --- */
    .kuri-layer-stats {
        background: var(--panel-bg);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 1rem;
    }
    
    .kuri-summary-title {
        margin: 0 0 1.5rem;
        font-size: 1rem;
        font-weight: 600;
    }

    .kuri-stat-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: .75rem 0;
        border-bottom: 1px solid var(--border-color);
    }

    .kuri-stat-label {
        font-size: .875rem;
        color: var(--text-secondary);
    }

    .kuri-stat-value {
        font-size: .875rem;
        font-weight: 600;
        color: var(--primary-color, #00d4ff);
    }
    `;
    document.head.appendChild(style);

})();