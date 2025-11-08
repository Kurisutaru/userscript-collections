// ==UserScript==
// @name         Trickcal Kuri CP Sync Manager
// @namespace    https://www.kurisutaru.net/
// @version      1.6
// @description  Sync localStorage data for Trickcal with Kuri CP dropdown + Pantry.cloud online sync
// @author       Kurisutaru
// @match        https://trickcal.nossite.com/*
// @updateURL    https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/trickcal-kuri-cp-sync-manager.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

/* -------------------------------------------------
   PANTRY.CLOUD HELPER (userscript-ready)
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
    create: (name, data) => this._req('POST', `${this.base}/basket/${name}`, data), // CREATE OR REPLACE
    update: (name, data) => this._req('PUT', `${this.base}/basket/${name}`, data), // DEEP MERGE (requires exist)
    delete: name => this._req('DELETE', `${this.base}/basket/${name}`)
  };
}

/* -------------------------------------------------
   MAIN SCRIPT
   ------------------------------------------------- */
(function() {
  'use strict';

  // ------------------- CONFIG -------------------
  const STORAGE_KEYS = [
    'trickcal_board_progress',
    'trickcal_language',
    'trickcal_sweep_selected_materials',
    'trickcal_theme',
  ];
  const BASKET_NAME = 'kurisutaru.trickcal.nossite';



  let autoSyncInterval = null;
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
    // === DEBUG: Force test sync on load (REMOVE AFTER FIXING) ===
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
    }, 3000); // Runs 3 sec after page load
  }

  // ------------------- HELPERS -------------------
  function getCurrentTheme() {
    return document.body.getAttribute('data-theme') || 'dark';
  }

  function getCSSVar(v) {
    return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  }

  // ------------------- LOCAL STORAGE -------------------
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

  // ------------------- GM STORAGE (LOCAL SYNC) -------------------
  async function syncNowLocal(statusIndicator) {
    try {
      updateStatus(statusIndicator, 'syncing');
      const data = getLocalStorageData();
      GM_setValue('trickcal_sync_data', JSON.stringify({
        data,
        timestamp: new Date().toISOString()
      }));
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

  // ------------------- PANTRY (ONLINE) SYNC -------------------
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

      // POST = Create or Replace → Always works
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

  // ------------------- AUTO SYNC (LOCAL → ONLINE) -------------------
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

  // ------------------- EXPORT / IMPORT -------------------
  function exportToJson() {
    const raw = GM_getValue('trickcal_sync_data', null);
    if (!raw) return showNotification('⚠️ Nothing to export', 'warning');
    const blob = new Blob([raw], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trickcal-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
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

  // ------------------- UI ELEMENTS -------------------
  function updateStatus(indicator, status) {
    if (!indicator) return;
    const colors = {
      idle: '#ccc',
      syncing: '#ffa500',
      success: '#4caf50',
      error: '#f44336'
    };
    indicator.style.background = colors[status] || colors.idle;
    if (['success', 'error'].includes(status)) setTimeout(() => indicator.style.background = colors.idle, 3000);
  }

  function showNotification(msg, type) {
    const bg = {
      success: 'var(--success-color)',
      error: 'var(--primary-color)',
      warning: 'var(--warning-color)',
      info: '#2196f3'
    } [type] || '#555';
    const n = document.createElement('div');
    n.style.cssText = `position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:6px;background:${bg};color:#fff;box-shadow:var(--shadow-md);z-index:10000;font-size:14px;animation:slideIn .3s ease;`;
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => {
      n.style.animation = 'slideOut .3s ease';
      setTimeout(() => n.remove(), 300);
    }, 3000);
  }

  function createSyncDropdown() {
    const container = document.createElement('div');
    container.className = 'kuri-cp-container';
    container.style.cssText = `position:relative;margin-right:12px;display:inline-block;`;

    const mainButton = document.createElement('button');
    mainButton.className = 'kuri-cp-button';
    mainButton.style.cssText = `padding:8px 16px;border-radius:8px;border:2px solid var(--border-color);background:var(--card-bg);color:var(--text-primary);font-size:14px;cursor:pointer;display:flex;align-items:center;gap:8px;justify-content:flex-start;`;
    const chevron = document.createElement('span');
    chevron.textContent = '▼';
    chevron.style.cssText = `font-size:10px;transition:transform 0.25s ease;display:inline-block;`;
    mainButton.innerHTML = `<span>⚙️</span><span>Kuri CP</span>`;
    mainButton.appendChild(chevron);

    const statusIndicator = document.createElement('span');
    statusIndicator.style.cssText = `position:absolute;top:-4px;right:-4px;width:10px;height:10px;border-radius:50%;background:#ccc;border:2px solid var(--card-bg);`;

    const dropdownMenu = document.createElement('div');
    dropdownMenu.style.cssText = `position:absolute;top:calc(100% + 8px);right:0;background:var(--card-bg);border:2px solid var(--border-color);border-radius:12px;box-shadow:var(--shadow-lg);min-width:260px;display:none;z-index:9999;animation:dropdownSlideIn .2s ease;text-align:left;`;
    const dropdownHeader = document.createElement('div');
    dropdownHeader.style.cssText = `padding:1rem 1rem 0.5rem;border-bottom:1px solid var(--border-color);`;
    dropdownHeader.innerHTML = `<h3 style="margin:0;font-size:0.875rem;font-weight:600;color:var(--text-secondary);font-family:var(--site-font);text-transform:uppercase;letter-spacing:0.5px;">Kurisutaru CP Sync</h3>`;
    dropdownMenu.appendChild(dropdownHeader);

    const list = document.createElement('div');
    list.style.padding = '0.5rem';
    MENU_ITEMS.forEach(item => {
      const btn = document.createElement('button');
      btn.style.cssText = `width:100%;padding:0.75rem;border:none;background:transparent;display:flex;align-items:center;gap:0.75rem;color:var(--text-primary);cursor:pointer;border-radius:8px;transition:background 0.2s;justify-content:flex-start;text-align:left;`;
      btn.innerHTML = `<span style="font-size:20px;">${item.icon}</span><div style="text-align:left;"><div style="font-weight:500">${item.name}</div><div style="font-size:12px;color:var(--text-secondary)">${item.desc}</div></div>`;
      btn.addEventListener('mouseenter', () => btn.style.background = 'var(--hover-bg)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        dropdownMenu.style.display = 'none';
        isDropdownOpen = false;
        chevron.style.transform = 'rotate(0deg)';
        await handleSyncAction(item.id, statusIndicator);
      });
      list.appendChild(btn);
    });
    dropdownMenu.appendChild(list);

    mainButton.addEventListener('click', e => {
      e.stopPropagation();
      isDropdownOpen = !isDropdownOpen;
      dropdownMenu.style.display = isDropdownOpen ? 'block' : 'none';
      chevron.style.transform = isDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)';
      mainButton.classList.toggle('active', isDropdownOpen);
    });
    document.addEventListener('click', e => {
      if (!container.contains(e.target)) {
        dropdownMenu.style.display = 'none';
        chevron.style.transform = 'rotate(0deg)';
        isDropdownOpen = false;
        mainButton.classList.remove('active');
      }
    });

    container.appendChild(mainButton);
    container.appendChild(statusIndicator);
    container.appendChild(dropdownMenu);
    return container;
  }

  // ------------------- CONFIG OVERLAY WITH ONLINE SYNC -------------------
  function createConfigOverlay(statusIndicator) {
    if (document.querySelector('.kuri-cp-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'kuri-cp-overlay';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;backdrop-filter:blur(3px);`;
    const panel = document.createElement('div');
    panel.style.cssText = `background:var(--card-bg);border:2px solid var(--border-color);border-radius:12px;box-shadow:var(--shadow-lg);padding:20px;width:420px;color:var(--text-primary);font-family:var(--site-font);animation:fadeIn .25s ease;`;

    const enabled = GM_getValue('auto_sync_enabled', false);
    const interval = GM_getValue('auto_sync_interval', 300);
    const onlineEnabled = isOnlineSyncEnabled();
    const pantryId = getPantryId();

    panel.innerHTML = `
      <div style="border-bottom:1px solid var(--border-color);">
        <h3 style="font-size:1.4rem;">⚙️ Kurisutaru CP Config</h3>
      </div>

      <h3 style="font-size:1rem;margin-top:12px;">🗂️ Sync Options</h3>
      <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0;">
        <span>Enable Auto Sync</span>
        <label class="switch"><input type="checkbox" id="cfg-autosync-toggle" ${enabled ? 'checked' : ''}><span class="slider round"></span></label>
      </div>
      <div style="margin:8px 0;">
        <label>Auto Sync Interval (seconds):</label>
        <input id="cfg-autosync" type="number" min="10" step="10" style="width:100%;margin-top:4px;padding:6px;border-radius:6px;border:1px solid var(--border-color);background:var(--card-bg);color:var(--text-primary);" value="${interval}">
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button id="btn-sync-now" class="kuri-btn">🔄 Sync Now</button>
        <button id="btn-force-resync" class="kuri-btn"🗑️ >Force Resync</button>
      </div>

      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border-color);">

      <h3 style="font-size:1rem;">🌏 Online Sync</h3>
      <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0;">
        <span>Enable Online Sync</span>
        <label class="switch"><input type="checkbox" id="cfg-online-toggle" ${onlineEnabled ? 'checked' : ''}><span class="slider round"></span></label>
      </div>
      <div style="margin:8px 0;position:relative;">
        <label>Pantry ID <span id="pantry-info" style="cursor:pointer;color:var(--primary-color);font-weight:bold;">[?]</span></label>
        <input id="cfg-pantry-id" type="text" placeholder="Your Pantry ID" style="width:100%;margin-top:4px;padding:6px;border-radius:6px;border:1px solid var(--border-color);background:var(--card-bg);color:var(--text-primary);" value="${pantryId}">
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button id="btn-online-sync" class="kuri-btn">🔄 Sync Now</button>
        <button id="btn-online-pull" class="kuri-btn">🗑️ Force Resync</button>
      </div>

      <hr style="margin:18px 0;border:none;border-top:1px solid var(--border-color);">

      <h3 style="font-size:1rem;">💾 Backup Options</h3>
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button id="btn-export" class="kuri-btn">📤 Export JSON</button>
        <button id="btn-import" class="kuri-btn">📥 Import JSON</button>
      </div>

      <div style="text-align:right;margin-top:20px;">
        <button id="cfg-save" class="kuri-btn" style="background:var(--primary-color);color:#fff;">Save</button>
        <button id="cfg-close" class="kuri-btn" style="background:var(--hover-bg);">Cancel</button>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Switch & Button Styles
    const css = document.createElement('style');
    css.textContent = `
      .switch { position:relative;display:inline-block;width:42px;height:22px; }
      .switch input { opacity:0;width:0;height:0; }
      .slider { position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:var(--border-color);transition:.2s;border-radius:22px; }
      .slider:before { position:absolute;content:"";height:16px;width:16px;left:3px;bottom:3px;background:white;transition:.2s;border-radius:50%; }
      input:checked + .slider { background:var(--primary-color); }
      input:checked + .slider:before { transform:translateX(20px); }
      .kuri-btn { flex:1;padding:8px 12px;border:none;border-radius:6px;background:var(--primary-hover);color:var(--text-primary);cursor:pointer; }
      .kuri-btn:hover { background:var(--hover-bg); }
    `;
    document.head.appendChild(css);

    // Info Popup
    panel.querySelector('#pantry-info').addEventListener('click', () => {
      if (document.querySelector('.pantry-help-overlay')) return;
      const helpOverlay = document.createElement('div');
      helpOverlay.className = 'pantry-help-overlay';
      helpOverlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,0.6);
        display:flex;align-items:center;justify-content:center;
        z-index:10001;backdrop-filter:blur(3px);
    `;
      const helpPanel = document.createElement('div');
      helpPanel.style.cssText = `
        background:var(--card-bg);border:2px solid var(--border-color);
        border-radius:12px;box-shadow:var(--shadow-lg);
        padding:20px;width:380px;color:var(--text-primary);
        font-family:var(--site-font);animation:fadeIn .25s ease;
        text-align:center;
    `;
      helpPanel.innerHTML = `
        <h3 style="margin-top:0;">🌐 getPantry.cloud</h3>
        <p style="font-size:14px;margin:12px 0;">
          You can create your free online storage at
          <a href="https://getpantry.cloud" target="_blank"
             style="color:var(--primary-color);text-decoration:none;font-weight:bold;">
             getPantry.cloud
          </a>.
        </p>
        <button id="pantry-help-ok" class="kuri-btn"
          style="margin-top:10px;background:var(--primary-color);color:#fff;">
          OK
        </button>
    `;
      helpOverlay.appendChild(helpPanel);
      document.body.appendChild(helpOverlay);

      helpOverlay.addEventListener('click', e => {
        if (e.target === helpOverlay) helpOverlay.remove();
      });
      helpPanel.querySelector('#pantry-help-ok').addEventListener('click', () => {
        helpOverlay.remove();
      });
    });

    // Events
    // Events
    panel.querySelector('#btn-sync-now').onclick = () => {
      syncNowLocal(statusIndicator).then(() => {
        if (isOnlineSyncEnabled() && pantryClient) {
          syncNowOnline(statusIndicator);
        }
      });
    };

    panel.querySelector('#btn-force-resync').onclick = () => {
      if (confirm('This will clear and pull from local sync. Continue?')) {
        clearAndPullLocal(statusIndicator);
      }
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
      if (confirm('This will pull from Pantry and overwrite local data. Continue?')) {
        forceResyncOnline(statusIndicator);
      }
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

  // ------------------- STYLES & ANIMATIONS -------------------
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn { from{transform:translateX(400px);opacity:0;} to{transform:translateX(0);opacity:1;} }
    @keyframes slideOut { from{transform:translateX(0);opacity:1;} to{transform:translateX(400px);opacity:0;} }
    @keyframes dropdownSlideIn { from{opacity:0;transform:translateY(-10px);} to{opacity:1;transform:translateY(0);} }
    @keyframes fadeIn { from{opacity:0;transform:scale(0.95);} to{opacity:1;transform:scale(1);} }
    .kuri-cp-button:hover { border-color:var(--primary-color)!important;background:var(--primary-bg)!important;transition:background-color .3s,border-color .3s; }
    .kuri-cp-button.active { border-color:var(--primary-color)!important;background:var(--primary-bg)!important;transition:background-color .3s,border-color .3s; }
    .kuri-cp-button span {
    background: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 0 !important;
    display: inline !important;
  }

  /* Optional: ensure text alignment */
  .kuri-cp-button > span:first-child {
    margin-right: 8px;
  }
  `;
  document.head.appendChild(style);

  // ------------------- DOM CLEANUP & INJECTION -------------------
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

  // Inject dropdown
  function injectDropdown() {
    const navActions = document.querySelector('.nav-actions');
    if (navActions && !document.querySelector('[data-injected="true"]')) {
      const dropdown = createSyncDropdown();
      // mark injected so Vue won't re-add duplicate
      dropdown.setAttribute('data-injected', 'true');
      navActions.prepend(dropdown);
      currentDropdown = dropdown;
      console.log('✅ Kuri CP Sync Manager injected!');
      // if auto-sync is enabled on load, start it
      const enabled = GM_getValue('auto_sync_enabled', false);
      const interval = GM_getValue('auto_sync_interval', 300);
      if (enabled && interval) startAutoSync(interval, dropdown.querySelector('span'));
      return true;
    }
    return false;
  }

  // Check and re-inject if missing
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

  // Check and modify Google button
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

  // Check and modify Total Usage text
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

  // Watch for theme changes
  function watchThemeChanges() {
    const themeObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          const newTheme = getCurrentTheme();
          const container = document.querySelector('.kuri-cp-container');
          if (container) {
            container.setAttribute('data-current-theme', newTheme);
            // CSS vars handle visual updates
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