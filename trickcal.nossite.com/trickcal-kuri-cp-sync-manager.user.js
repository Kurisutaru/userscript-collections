// ==UserScript==
// @name         Trickcal Kuri CP Sync Manager
// @namespace    https://www.kurisutaru.net/
// @version      1.10
// @description  Sync localStorage data for Trickcal with Kuri CP dropdown + Pantry.cloud online sync
// @author       Kurisutaru
// @match        https://trickcal.nossite.com/*
// @downloadURL  https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/trickcal.nossite.com/trickcal-kuri-cp-sync-manager.user.js
// @updateURL    https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/trickcal.nossite.com/trickcal-kuri-cp-sync-manager.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

/* -------------------------------------------------
   KuriPopup - Reuseable Popup
   ------------------------------------------------- */
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
            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) this.remove();
            });
        }

        const escHandler = (e) => {
            if (e.key === 'Escape') {
                this.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    remove() {
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.classList.add('kuri-popup-fade-out');
            this.panel.classList.add('kuri-popup-scale-out');
            setTimeout(() => {
                this.overlay.remove();
            }, 200);
        }
    }
}

/* -------------------------------------------------
   PANTRY.CLOUD HELPER
   ------------------------------------------------- */
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
                headers: {
                    'Content-Type': 'application/json'
                },
                onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.response) : reject(new Error(`${r.status} ${r.statusText}`)),
                onerror: reject
            };
            if (data) opts.data = JSON.stringify(data);
            if (typeof GM !== 'undefined' && GM.xmlHttpRequest) GM.xmlHttpRequest(opts);
            else if (typeof GM_xmlhttpRequest !== 'undefined') GM_xmlhttpRequest(opts);
            else reject(new Error('No HTTP client'));
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

/* -------------------------------------------------
   MAIN SCRIPT
   ------------------------------------------------- */
(function () {
    'use strict';

    const STORAGE_KEYS = [
        'trickcal_board_progress',
        'trickcal_language',
        'trickcal_sweep_selected_materials',
        'trickcal_theme',
    ];
    const BASKET_NAME = 'kurisutaru.trickcal.nossite';

    let autoSyncInterval = null;
    let lastSyncDate = null;
    let isDropdownOpen = false;
    let lastCheckedGoogleBtn = null;
    let lastCheckedUsageDiv = null;
    let currentDropdown = null;
    let pantryClient = null;

    let debugMode = false;

    initPantryClient();

    const MENU_ITEMS = [{
        id: 'sync_now',
        icon: '🔄',
        name: 'Sync Now',
        desc: 'Save current data to storage'
    },
        {
            id: 'open_config',
            icon: '⚙️',
            name: 'Configuration',
            desc: 'Open overlay to edit sync & backup settings'
        },
    ];

    if (debugMode) {
        setTimeout(async () => {
            console.clear();
            console.log('PANTRY DEBUG START');

            const pantryId = GM_getValue('pantry_id', '').trim();
            console.log('Saved Pantry ID:', pantryId ? `"${pantryId}"` : 'NOT SET');

            if (!pantryId) {
                console.error('Pantry ID missing. Set it in config.');
                return;
            }

            const data = {};
            STORAGE_KEYS.forEach(k => {
                const v = localStorage.getItem(k);
                console.log(`localStorage[${k}]:`, v);
                if (v !== null) {
                    try {
                        data[k] = JSON.parse(v);
                    } catch {
                        data[k] = v;
                    }
                }
            });

            console.log('Final data object:', data);

            let jsonStr;
            try {
                jsonStr = JSON.stringify(data);
                console.log('JSON stringified OK');
            } catch (e) {
                console.error('JSON.stringify FAILED:', e.message);
                return;
            }

            const url = `https://getpantry.cloud/apiv1/pantry/${pantryId}/basket/${BASKET_NAME}`;
            console.log('PUT URL:', url);

            try {
                const res = await fetch(url, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: jsonStr
                });

                const text = await res.text();
                if (res.ok) {
                    console.log('SUCCESS! Basket created/updated');
                    console.log('Response:', text);
                } else {
                    console.error(`HTTP ${res.status}:`, text);
                }
            } catch (e) {
                console.error('Fetch failed:', e);
            }
        }, 3000);
    }

    function getCurrentTheme() {
        return document.body.getAttribute('data-theme') || 'dark';
    }

    function getCSSVar(v) {
        return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    }

    function setLastSyncDate(date) {
        if(date == null) {
            date = new Date();
        }

        GM_setValue('last_sync_date', date.toISOString());

        if(document.querySelector('#kuri-last-sync-date')) {
            document.querySelector('#kuri-last-sync-date').innerHTML = formatDateTime(date);
        }
    }

    function formatDateTime(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    function getLocalStorageData() {
        const data = {};
        STORAGE_KEYS.forEach(k => {
            const v = localStorage.getItem(k);
            if (v !== null) data[k] = v;
        });
        return data;
    }

    function setLocalStorageData(data) {
        Object.keys(data).forEach(k => {
            if (STORAGE_KEYS.includes(k)) localStorage.setItem(k, data[k]);
        });
    }

    function clearLocalStorageData() {
        STORAGE_KEYS.forEach(k => localStorage.removeItem(k));
    }

    async function syncNowLocal(statusIndicator) {
        try {
            updateStatus(statusIndicator, 'syncing');
            const data = getLocalStorageData();
            const now = new Date();
            GM_setValue('trickcal_sync_data', JSON.stringify({
                data,
                timestamp: now.toISOString()
            }));
            setLastSyncDate(now);
            updateStatus(statusIndicator, 'success');
            showNotification('✅ Local sync successful!', 'success');
        } catch (e) {
            updateStatus(statusIndicator, 'error');
            showNotification('❌ Local sync failed: ' + e.message, 'error');
            console.error(e);
        }
    }

    async function clearAndPullLocal(statusIndicator) {
        try {
            updateStatus(statusIndicator, 'syncing');
            const raw = GM_getValue('trickcal_sync_data', null);
            if (!raw) {
                updateStatus(statusIndicator, 'idle');
                return showNotification('No local synced data', 'warning');
            }
            const {
                data
            } = JSON.parse(raw);
            clearLocalStorageData();
            setLocalStorageData(data);
            updateStatus(statusIndicator, 'success');
            showNotification('Local data restored!', 'success');
            setTimeout(() => location.reload(), 1000);
        } catch (e) {
            updateStatus(statusIndicator, 'error');
            showNotification('Pull failed: ' + e.message, 'error');
            console.error(e);
        }
    }

    function getPantryId() {
        return GM_getValue('pantry_id', '').trim();
    }

    function setPantryId(id) {
        GM_setValue('pantry_id', id.trim());
    }

    function isOnlineSyncEnabled() {
        return GM_getValue('online_sync_enabled', false);
    }

    function initPantryClient() {
        const id = getPantryId();
        if (id) {
            try {
                pantryClient = new Pantry(id);
            } catch (e) {
                pantryClient = null;
                showNotification('Invalid Pantry ID', 'error');
            }
        } else {
            pantryClient = null;
        }
    }

    async function syncNowOnline(statusIndicator) {
        if (!pantryClient) {
            showNotification('Pantry ID not set', 'warning');
            return;
        }
        try {
            updateStatus(statusIndicator, 'syncing');
            const data = getLocalStorageData();
            setLastSyncDate(new Date());

            await pantryClient.basket.create(BASKET_NAME, data);

            updateStatus(statusIndicator, 'success');
            showNotification('✅ Online sync successful!', 'success');
        } catch (e) {
            updateStatus(statusIndicator, 'error');
            showNotification('Online sync failed: ' + e.message, 'error');
            console.error('Pantry sync error:', e);
        }
    }

    async function forceResyncOnline(statusIndicator) {
        if (!pantryClient) return showNotification('Pantry ID not set', 'warning');
        try {
            updateStatus(statusIndicator, 'syncing');
            const remote = await pantryClient.basket.get(BASKET_NAME);
            clearLocalStorageData();
            setLocalStorageData(remote);
            updateStatus(statusIndicator, 'success');
            showNotification('Online data pulled!', 'success');
            setTimeout(() => location.reload(), 1000);
        } catch (e) {
            updateStatus(statusIndicator, 'error');
            if (e.message.includes('404')) {
                showNotification('No online data found', 'warning');
            } else {
                showNotification('Pull failed: ' + e.message, 'error');
            }
            console.error(e);
        }
    }

    function startAutoSync(seconds, indicator) {
        try {
            stopAutoSync();
            autoSyncInterval = setInterval(() => {
                syncNowLocal(indicator).then(() => {
                    if (isOnlineSyncEnabled() && pantryClient) {
                        syncNowOnline(indicator);
                    }
                });
            }, seconds * 1000);
            GM_setValue('auto_sync_interval', seconds);
            GM_setValue('auto_sync_enabled', true);
            showNotification(`⏱️ Auto-sync started (${seconds}s)`, 'info');
        } catch (e) {
            console.error('startAutoSync error', e);
        }
    }

    function stopAutoSync() {
        if (autoSyncInterval) clearInterval(autoSyncInterval);
        autoSyncInterval = null;
        GM_deleteValue('auto_sync_enabled');
    }

    function exportToJson() {
        const raw = GM_getValue('trickcal_sync_data', null);
        if (!raw) return showNotification('⚠️ Nothing to export', 'warning');
        const blob = new Blob([raw], {
            type: 'application/json'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `trickcal-backup.${formatDateTime(new Date()).replace(' ', '_')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showNotification('📤 Exported JSON backup', 'success');
    }

    function importFromJson() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async e => {
            const f = e.target.files[0];
            if (!f) return;
            try {
                const text = await f.text();
                const parsed = JSON.parse(text);
                GM_setValue('trickcal_sync_data', JSON.stringify({
                    data: parsed.data || parsed,
                    timestamp: new Date().toISOString()
                }));
                clearLocalStorageData();
                setLocalStorageData(parsed.data || parsed);
                showNotification('📥 Imported JSON! Reloading...', 'success');
                setTimeout(() => location.reload(), 1000);
            } catch (err) {
                showNotification('❌ Import failed: ' + err.message, 'error');
            }
        };
        input.click();
    }

    function updateStatus(indicator, status) {
        if (!indicator) return;
        indicator.className = `kuri-status-indicator kuri-status-${status}`;
        if (['success', 'error'].includes(status)) {
            setTimeout(() => {
                indicator.className = 'kuri-status-indicator kuri-status-idle';
            }, 3000);
        }
    }

    function showNotification(message, type = 'info', duration = 3000) {
        // Create a container once
        let container = document.querySelector('.kuri-notification-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'kuri-notification-container';
            document.body.appendChild(container);
        }

        // Create the notification
        const notif = document.createElement('div');
        notif.className = `kuri-notification kuri-notification-${type}`;
        notif.textContent = message;

        // Append at the bottom of the stack
        container.appendChild(notif);

        // Force reflow to trigger CSS animation
        void notif.offsetWidth;

        // Auto remove after duration
        setTimeout(() => {
            notif.classList.add('kuri-notification-exit');
            notif.addEventListener('animationend', () => {
                notif.remove();
            });
        }, duration);
    }



    function createSyncDropdown() {
        const container = document.createElement('div');
        container.className = 'kuri-cp-container';

        const mainButton = document.createElement('button');
        mainButton.className = 'kuri-cp-button';
        const chevron = document.createElement('span');
        chevron.className = 'kuri-cp-chevron';
        chevron.textContent = '▼';
        mainButton.innerHTML = `<span>⚙️</span><span>Kuri CP</span>`;
        mainButton.appendChild(chevron);

        const statusIndicator = document.createElement('span');
        statusIndicator.className = 'kuri-status-indicator kuri-status-idle';

        const dropdownMenu = document.createElement('div');
        dropdownMenu.className = 'kuri-dropdown-menu';

        const dropdownHeader = document.createElement('div');
        dropdownHeader.className = 'kuri-dropdown-header';
        dropdownHeader.innerHTML = `<h3>Kurisutaru CP Sync</h3>`;
        dropdownMenu.appendChild(dropdownHeader);

        const list = document.createElement('div');
        list.className = 'kuri-dropdown-list';
        MENU_ITEMS.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'kuri-dropdown-item';
            btn.innerHTML = `<span class="kuri-dropdown-icon">${item.icon}</span><div class="kuri-dropdown-text"><div class="kuri-dropdown-name">${item.name}</div><div class="kuri-dropdown-desc">${item.desc}</div></div>`;
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                dropdownMenu.classList.remove('kuri-dropdown-open');
                isDropdownOpen = false;
                mainButton.classList.remove('active');
                await handleSyncAction(item.id, statusIndicator);
            });
            list.appendChild(btn);
        });
        dropdownMenu.appendChild(list);

        mainButton.addEventListener('click', e => {
            e.stopPropagation();
            isDropdownOpen = !isDropdownOpen;
            if (isDropdownOpen) {
                dropdownMenu.classList.add('kuri-dropdown-open');
                mainButton.classList.add('active');
            } else {
                dropdownMenu.classList.remove('kuri-dropdown-open');
                mainButton.classList.remove('active');
            }
        });

        document.addEventListener('click', e => {
            if (!container.contains(e.target)) {
                dropdownMenu.classList.remove('kuri-dropdown-open');
                isDropdownOpen = false;
                mainButton.classList.remove('active');
            }
        });

        container.appendChild(mainButton);
        container.appendChild(statusIndicator);
        container.appendChild(dropdownMenu);
        return container;
    }

    function createConfigOverlay(statusIndicator) {
        if (document.querySelector('.kuri-cp-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'kuri-config-overlay';

        const panel = document.createElement('div');
        panel.className = 'kuri-config-panel';

        const enabled = GM_getValue('auto_sync_enabled', false);
        const interval = GM_getValue('auto_sync_interval', 300);
        const savedDateStr = GM_getValue('last_sync_date', new Date().toISOString());
        const lastSyncDate = new Date(savedDateStr);
        const onlineEnabled = isOnlineSyncEnabled();
        const pantryId = getPantryId();

        panel.innerHTML = `
      <div class="kuri-config-header">
        <h3>⚙️ Kurisutaru CP Config</h3>
      </div>

      <h3 class="kuri-config-section-title">🗂️ Sync Options</h3>
      <div class="kuri-config-row">
        <span>Last Sync Date</span>
        <span id="kuri-last-sync-date">${!isNaN(lastSyncDate) ? formatDateTime(lastSyncDate) : '-'}</span>
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

        panel.querySelector('#pantry-info').addEventListener('click', () => {
            new KuriPopup({
                title: '🍊getPantry.cloud',
                content: `
            You can create your free online storage at<br>
            <a href="https://getpantry.cloud" target="_blank"
               style="color:var(--primary-color);text-decoration:none;font-weight:bold;">
               getPantry.cloud
            </a>.
            `,
                yesText: 'getPantry.cloud',
                yesCallback: () => { window.open("https://getpantry.cloud", "_blank"); },
                noText: 'Ok',
            });
        });

        panel.querySelector('#btn-sync-now').onclick = () => {
            syncNowLocal(statusIndicator).then(() => {
                if (isOnlineSyncEnabled() && pantryClient) {
                    syncNowOnline(statusIndicator);
                }
            });
        };

        panel.querySelector('#btn-force-resync').onclick = () => {
            new KuriPopup({
                title: '🔄 Force Local Resync ?',
                content: `
                This will clear and pull from local sync. Continue?
            `,
                yesText: 'Yes',
                yesCallback: () => { clearAndPullLocal(statusIndicator); },
                noText: 'Cancel',
            });
        };

        panel.querySelector('#btn-online-sync').onclick = () => {
            if (!pantryClient) {
                showNotification('Pantry ID not set', 'warning');
                return;
            }
            syncNowLocal(statusIndicator).then(() => syncNowOnline(statusIndicator));
        };

        panel.querySelector('#btn-online-pull').onclick = () => {
            if (!pantryClient) {
                showNotification('Pantry ID not set', 'warning');
                return;
            }
            new KuriPopup({
                title: '🔄 Force Online Resync ?',
                content: `
                This will pull from Pantry and overwrite local data. Continue?
            `,
                yesText: 'Yes',
                yesCallback: () => { forceResyncOnline(statusIndicator); },
                noText: 'Cancel',
            });
        };

        panel.querySelector('#btn-export').onclick = exportToJson;
        panel.querySelector('#btn-import').onclick = importFromJson;
        panel.querySelector('#cfg-close').onclick = () => overlay.remove();
        overlay.onclick = e => {
            if (e.target === overlay) overlay.remove();
        };

        panel.querySelector('#cfg-save').onclick = () => {
            const seconds = parseInt(panel.querySelector('#cfg-autosync').value, 10);
            const autoEnabled = panel.querySelector('#cfg-autosync-toggle').checked;
            const onlineEnabled = panel.querySelector('#cfg-online-toggle').checked;
            const pantryId = panel.querySelector('#cfg-pantry-id').value.trim();

            if (isNaN(seconds) || seconds < 10) return showNotification('Interval must be ≥10s', 'error');
            GM_setValue('auto_sync_interval', seconds);
            GM_setValue('online_sync_enabled', onlineEnabled);
            if (pantryId) setPantryId(pantryId);
            else GM_deleteValue('pantry_id');
            initPantryClient();

            if (autoEnabled) startAutoSync(seconds, statusIndicator);
            else stopAutoSync();

            showNotification(`Saved! Auto: ${autoEnabled ? seconds + 's' : 'Off'} | Online: ${onlineEnabled && pantryId ? 'On' : 'Off'}`, 'success');
            overlay.remove();
        };
    }

    async function handleSyncAction(action, indicator) {
        if (action === 'open_config') return createConfigOverlay(indicator);
        if (action === 'sync_now') {
            await syncNowLocal(indicator);
            if (isOnlineSyncEnabled() && pantryClient) {
                await syncNowOnline(indicator);
            }
        }
    }

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
  `;
    document.head.appendChild(style);

    function removeGoogleSignInText() {
        try {
            const googleBtn = document.querySelector('.google-signin-btn span');
            if (googleBtn && googleBtn.textContent.includes('Sign in with Google')) {
                googleBtn.remove();
                return true;
            }
        } catch (e) {
            /* ignore */
        }
        return false;
    }

    function removeTotalUsageText() {
        try {
            const usageCounterDiv = document.querySelector('div.usage-counter');
            if (usageCounterDiv) {
                usageCounterDiv.remove();
                return true;
            }
        } catch (e) {
            /* ignore */
        }
        return false;
    }

    function injectDropdown() {
        const navActions = document.querySelector('.nav-actions');
        if (navActions && !document.querySelector('[data-injected="true"]')) {
            const dropdown = createSyncDropdown();
            dropdown.setAttribute('data-injected', 'true');
            navActions.prepend(dropdown);
            currentDropdown = dropdown;
            console.log('✅ Kuri CP Sync Manager injected!');
            const enabled = GM_getValue('auto_sync_enabled', false);
            const interval = GM_getValue('auto_sync_interval', 300);
            if (enabled && interval) startAutoSync(interval, dropdown.querySelector('.kuri-status-indicator'));
            return true;
        }
        return false;
    }

    function checkAndReinject() {
        const navActions = document.querySelector('.nav-actions');
        const existing = document.querySelector('[data-injected="true"]');
        if (existing && document.contains(existing)) {
            currentDropdown = existing;
            return;
        }
        if (navActions && !existing) {
            injectDropdown();
        }
    }

    function checkAndModifyGoogleButton() {
        try {
            const googleBtn = document.querySelector('.google-signin-btn span');
            if (googleBtn && googleBtn !== lastCheckedGoogleBtn) {
                if (googleBtn.textContent.includes('Sign in with Google')) {
                    removeGoogleSignInText();
                    lastCheckedGoogleBtn = googleBtn;
                }
            }
            if (lastCheckedGoogleBtn && !document.contains(lastCheckedGoogleBtn)) lastCheckedGoogleBtn = null;
        } catch (e) {
            /* ignore */
        }
    }

    function checkAndModifyTotalUsageText() {
        try {
            const usageText = document.querySelector('div.usage-counter');
            if (usageText && usageText !== lastCheckedUsageDiv) {
                removeTotalUsageText();
                lastCheckedUsageDiv = usageText;
            }
            if (lastCheckedUsageDiv && !document.contains(lastCheckedUsageDiv)) lastCheckedUsageDiv = null;
        } catch (e) {
            /* ignore */
        }
    }

    function watchThemeChanges() {
        const themeObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                    const newTheme = getCurrentTheme();
                    const container = document.querySelector('.kuri-cp-container');
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

    function init() {
        injectDropdown();
        watchThemeChanges();
        removeGoogleSignInText();
        removeTotalUsageText();

        const observer = new MutationObserver(() => {
            if (!observer.throttled) {
                observer.throttled = true;
                requestAnimationFrame(() => {
                    checkAndReinject();
                    checkAndModifyGoogleButton();
                    checkAndModifyTotalUsageText();
                    observer.throttled = false;
                });
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        setInterval(() => {
            checkAndReinject();
            checkAndModifyGoogleButton();
            checkAndModifyTotalUsageText();
        }, 2000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();