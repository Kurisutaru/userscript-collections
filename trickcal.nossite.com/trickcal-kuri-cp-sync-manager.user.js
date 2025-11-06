// ==UserScript==
// @name         Trickcal Kuri CP Sync Manager
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Sync localStorage data for Trickcal with Kuri CP dropdown
// @author       You
// @match        https://trickcal.nossite.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const STORAGE_KEYS = [
        'trickcal_board_progress',
        'trickcal_language',
        'trickcal_sweep_selected_materials',
        'trickcal_theme',
    ];

    let autoSyncInterval = null;
    let isDropdownOpen = false;
    let lastCheckedGoogleBtn = null;
    let lastCheckedUsageDiv = null;
    let currentDropdown = null;

    // Menu items configuration
    const MENU_ITEMS = [
        { id: 'sync_now', icon: '🔄', name: 'Sync Now', desc: 'Save current data to storage' },
        { id: 'clear_pull', icon: '🗑️', name: 'Clear & Pull', desc: 'Restore data from storage' },
        { id: 'sync_custom', icon: '⏱️', name: 'Sync (X)s', desc: 'Set custom auto-sync interval' },
        { id: 'auto_off', icon: '⏹️', name: 'Auto Sync OFF', desc: 'Disable automatic syncing' },
        { id: 'export_json', icon: '📥', name: 'Export JSON', desc: 'Download backup as JSON file' },
        { id: 'import_json', icon: '📤', name: 'Import JSON', desc: 'Restore from JSON backup' }
    ];

    // Get current theme
    function getCurrentTheme() {
        return document.body.getAttribute('data-theme') || 'dark';
    }

    // Get CSS variable value
    function getCSSVar(varName) {
        return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    }

    // Get theme-aware styles using site's CSS variables
    function getThemedStyles() {
        return {
            background: getCSSVar('--card-bg'),
            buttonBg: getCSSVar('--button-bg'),
            buttonHover: getCSSVar('--button-hover'),
            hover: getCSSVar('--hover-bg'),
            color: getCSSVar('--text-primary'),
            colorSecondary: getCSSVar('--text-secondary'),
            border: getCSSVar('--border-color'),
            shadow: getCSSVar('--shadow-md'),
            primaryColor: getCSSVar('--primary-color'),
            primaryHover: getCSSVar('--primary-hover')
        };
    }

    // Create custom dropdown with site-matching style
    function createSyncDropdown() {
        const container = document.createElement('div');
        container.className = 'kuri-cp-container';
        container.setAttribute('data-injected', 'true');
        container.style.cssText = `
            position: relative;
            margin-right: 12px;
            display: inline-block;
        `;

        const currentTheme = getCurrentTheme();
        const styles = getThemedStyles();

        // Main button
        const mainButton = document.createElement('button');
        mainButton.className = 'kuri-cp-button';
        mainButton.style.cssText = `
            padding: 8px 16px;
            border-radius: 8px;
            border: 2px solid var(--border-color);
            background: var(--card-bg);
            color: var(--text-primary);
            font-size: 14px;
            cursor: pointer;
            outline: none;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 500;
            font-family: var(--site-font);
        `;
        mainButton.innerHTML = `
            <span style="font-size: 16px;">⚙️</span>
            <span>Kuri CP</span>
            <span style="font-size: 10px; transition: transform 0.2s;">▼</span>
        `;

        // Status indicator
        const statusIndicator = document.createElement('span');
        statusIndicator.className = 'sync-status';
        statusIndicator.style.cssText = `
            position: absolute;
            top: -4px;
            right: -4px;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #ccc;
            border: 2px solid var(--card-bg);
            transition: background 0.3s;
            z-index: 10;
        `;

        // Dropdown menu
        const dropdownMenu = document.createElement('div');
        dropdownMenu.className = 'kuri-cp-dropdown-menu';
        dropdownMenu.style.cssText = `
            position: absolute;
            top: calc(100% + 8px);
            right: 0;
            background: var(--card-bg);
            border: 2px solid var(--border-color);
            border-radius: 12px;
            box-shadow: var(--shadow-lg);
            min-width: 280px;
            max-height: max-content;
            overflow-y: auto;
            display: none;
            z-index: 9999;
            animation: dropdownSlideIn 0.2s ease;
        `;

        // Dropdown header
        const dropdownHeader = document.createElement('div');
        dropdownHeader.style.cssText = `
            padding: 1rem 1rem 0.5rem;
            border-bottom: 1px solid var(--border-color);
        `;
        dropdownHeader.innerHTML = `<h3 style="margin: 0; font-size: 0.875rem; font-weight: 600; color: var(--text-secondary); font-family: var(--site-font); text-transform: uppercase; letter-spacing: 0.5px;">Kuri CP Sync</h3>`;
        dropdownMenu.appendChild(dropdownHeader);

        // Menu items container
        const menuList = document.createElement('div');
        menuList.style.cssText = `padding: 0.5rem;`;

        MENU_ITEMS.forEach(item => {
            const menuItem = document.createElement('button');
            menuItem.className = 'kuri-cp-menu-item';
            menuItem.setAttribute('data-action', item.id);
            menuItem.style.cssText = `
                width: 100%;
                display: flex;
                align-items: center;
                gap: 0.75rem;
                padding: 0.75rem;
                border: none;
                background: transparent;
                color: var(--text-primary);
                cursor: pointer;
                border-radius: 8px;
                transition: all 0.2s ease;
                text-align: left;
                font-family: var(--site-font);
                position: relative;
            `;

            menuItem.innerHTML = `
                <span style="font-size: 20px; flex-shrink: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">${item.icon}</span>
                <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.125rem;">
                    <div style="font-size: 0.875rem; font-weight: 500; color: var(--text-primary);">${item.name}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary); line-height: 1.3;">${item.desc}</div>
                </div>
            `;

            menuItem.addEventListener('mouseenter', () => {
                menuItem.style.background = 'var(--hover-bg)';
            });

            menuItem.addEventListener('mouseleave', () => {
                menuItem.style.background = 'transparent';
            });

            menuItem.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = menuItem.getAttribute('data-action');
                closeDropdown();
                await handleSyncAction(action, statusIndicator);
            });

            menuList.appendChild(menuItem);
        });

        dropdownMenu.appendChild(menuList);

        // Toggle dropdown
        const toggleDropdown = (e) => {
            e.stopPropagation();
            isDropdownOpen = !isDropdownOpen;

            if (isDropdownOpen) {
                dropdownMenu.style.display = 'block';
                mainButton.querySelector('span:last-child').style.transform = 'rotate(180deg)';
                // Keep active state styling
                mainButton.style.borderColor = 'var(--primary-color)';
                mainButton.style.background = 'var(--primary-bg)';
            } else {
                dropdownMenu.style.display = 'none';
                mainButton.querySelector('span:last-child').style.transform = 'rotate(0deg)';
                // Reset to normal state
                mainButton.style.borderColor = 'var(--border-color)';
                mainButton.style.background = 'var(--card-bg)';
            }
        };

        const closeDropdown = () => {
            isDropdownOpen = false;
            dropdownMenu.style.display = 'none';
            mainButton.querySelector('span:last-child').style.transform = 'rotate(0deg)';
            mainButton.style.borderColor = 'var(--border-color)';
            mainButton.style.background = 'var(--card-bg)';
        };

        mainButton.addEventListener('click', toggleDropdown);

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                closeDropdown();
            }
        });

        // Hover effect for button - matches .tool-selector-trigger:hover
        mainButton.addEventListener('mouseenter', () => {
            mainButton.style.borderColor = 'var(--primary-color)';
            mainButton.style.background = 'var(--primary-bg)';
        });

        mainButton.addEventListener('mouseleave', () => {
            if (!isDropdownOpen) {
                mainButton.style.borderColor = 'var(--border-color)';
                mainButton.style.background = 'var(--card-bg)';
            }
        });

        container.appendChild(mainButton);
        container.appendChild(statusIndicator);
        container.appendChild(dropdownMenu);

        // Store reference for theme updates
        container.setAttribute('data-current-theme', currentTheme);

        // Check for saved auto-sync setting
        const savedAutoSync = GM_getValue('auto_sync_interval', null);
        if (savedAutoSync) {
            startAutoSync(savedAutoSync, statusIndicator);
            showNotification(`Auto-sync enabled (${savedAutoSync}s)`, 'info');
        }

        return container;
    }

    // Apply theme to dropdown (now just triggers re-render since we use CSS vars)
    function applyThemeToDropdown(container, theme) {
        // CSS variables handle theme automatically, but we can add any additional logic here
        container.setAttribute('data-current-theme', theme);
        console.log('🎨 Theme updated, CSS variables will handle colors automatically');
    }

    // Get all localStorage data
    function getLocalStorageData() {
        const data = {};
        STORAGE_KEYS.forEach(key => {
            const value = localStorage.getItem(key);
            if (value !== null) {
                data[key] = value;
            }
        });
        return data;
    }

    // Set localStorage data
    function setLocalStorageData(data) {
        Object.keys(data).forEach(key => {
            if (STORAGE_KEYS.includes(key)) {
                localStorage.setItem(key, data[key]);
            }
        });
    }

    // Clear localStorage
    function clearLocalStorageData() {
        STORAGE_KEYS.forEach(key => {
            localStorage.removeItem(key);
        });
    }

    // Sync functions
    async function syncNow(statusIndicator) {
        try {
            updateStatus(statusIndicator, 'syncing');
            const data = getLocalStorageData();
            const timestamp = new Date().toISOString();

            GM_setValue('trickcal_sync_data', JSON.stringify({
                data: data,
                timestamp: timestamp
            }));

            updateStatus(statusIndicator, 'success');
            showNotification('✅ Sync successful!', 'success');
            console.log('Synced data:', data);
        } catch (error) {
            updateStatus(statusIndicator, 'error');
            showNotification('❌ Sync failed: ' + error.message, 'error');
            console.error('Sync error:', error);
        }
    }

    async function clearAndPull(statusIndicator) {
        try {
            updateStatus(statusIndicator, 'syncing');

            const syncedData = GM_getValue('trickcal_sync_data', null);

            if (!syncedData) {
                showNotification('⚠️ No synced data found', 'warning');
                updateStatus(statusIndicator, 'idle');
                return;
            }

            const parsed = JSON.parse(syncedData);

            clearLocalStorageData();
            setLocalStorageData(parsed.data);

            updateStatus(statusIndicator, 'success');
            showNotification('✅ Data cleared and pulled!', 'success');
            console.log('Pulled data from:', parsed.timestamp);

            setTimeout(() => location.reload(), 1000);
        } catch (error) {
            updateStatus(statusIndicator, 'error');
            showNotification('❌ Pull failed: ' + error.message, 'error');
            console.error('Pull error:', error);
        }
    }

    // Auto-sync functionality
    function startAutoSync(seconds, statusIndicator) {
        stopAutoSync();
        autoSyncInterval = setInterval(() => {
            syncNow(statusIndicator);
        }, seconds * 1000);
        GM_setValue('auto_sync_interval', seconds);
        console.log(`Auto-sync started (${seconds}s interval)`);
    }

    function stopAutoSync() {
        if (autoSyncInterval) {
            clearInterval(autoSyncInterval);
            autoSyncInterval = null;
        }
        GM_deleteValue('auto_sync_interval');
    }

    // Custom sync interval prompt
    function promptCustomSyncInterval(statusIndicator) {
        const currentInterval = GM_getValue('auto_sync_interval', 300);
        const input = prompt(`Enter sync interval in seconds:\n(Numeric only, default: 300)`, currentInterval);

        if (input === null) return;

        const seconds = parseInt(input, 10);

        if (isNaN(seconds) || seconds <= 0) {
            showNotification('❌ Invalid interval! Must be a positive number', 'error');
            return;
        }

        startAutoSync(seconds, statusIndicator);
        showNotification(`⏱️ Auto-sync enabled (${seconds}s)`, 'success');
    }

    // Export to JSON
    function exportToJson() {
        try {
            const syncedData = GM_getValue('trickcal_sync_data', null);

            if (!syncedData) {
                showNotification('⚠️ No data to export', 'warning');
                return;
            }

            const parsed = JSON.parse(syncedData);
            const exportData = {
                version: '1.0',
                exported_at: new Date().toISOString(),
                original_timestamp: parsed.timestamp,
                data: parsed.data
            };

            const jsonStr = JSON.stringify(exportData, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const time = new Date().toISOString().split('T')[1].split('.')[0].replace(/:/g, '');
            const filename = `trickcal-nossite-kuricp-${date}-${time}.json`;

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showNotification('✅ JSON exported successfully!', 'success');
            console.log('Exported data:', exportData);
        } catch (error) {
            showNotification('❌ Export failed: ' + error.message, 'error');
            console.error('Export error:', error);
        }
    }

    // Import from JSON
    function importFromJson() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const imported = JSON.parse(text);

                if (!imported.data || typeof imported.data !== 'object') {
                    throw new Error('Invalid JSON structure');
                }

                const timestamp = new Date().toISOString();
                GM_setValue('trickcal_sync_data', JSON.stringify({
                    data: imported.data,
                    timestamp: timestamp,
                    imported_from: imported.exported_at || 'unknown'
                }));

                clearLocalStorageData();
                setLocalStorageData(imported.data);

                showNotification('✅ JSON imported successfully! Reloading...', 'success');
                console.log('Imported data:', imported);

                setTimeout(() => location.reload(), 1500);
            } catch (error) {
                showNotification('❌ Import failed: ' + error.message, 'error');
                console.error('Import error:', error);
            }
        };

        input.click();
    }

    // Handle sync actions
    async function handleSyncAction(action, statusIndicator) {
        switch(action) {
            case 'sync_now':
                await syncNow(statusIndicator);
                break;
            case 'clear_pull':
                if (confirm('⚠️ This will clear current data and pull from sync. Continue?')) {
                    await clearAndPull(statusIndicator);
                }
                break;
            case 'sync_custom':
                promptCustomSyncInterval(statusIndicator);
                break;
            case 'auto_off':
                stopAutoSync();
                showNotification('⏹️ Auto-sync disabled', 'info');
                updateStatus(statusIndicator, 'idle');
                break;
            case 'export_json':
                exportToJson();
                break;
            case 'import_json':
                importFromJson();
                break;
        }
    }

    // Update status indicator
    function updateStatus(indicator, status) {
        const colors = {
            idle: '#ccc',
            syncing: '#ffa500',
            success: '#4caf50',
            error: '#f44336'
        };
        indicator.style.background = colors[status] || colors.idle;

        if (status === 'success' || status === 'error') {
            setTimeout(() => {
                indicator.style.background = colors.idle;
            }, 3000);
        }
    }

    // Show notification
    function showNotification(message, type) {
        // Use site's color scheme
        const bgColors = {
            success: 'var(--success-color)',
            error: 'var(--primary-color)',
            warning: 'var(--warning-color)',
            info: '#2196f3'
        };

        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: ${bgColors[type] || bgColors.info};
            color: white;
            border-radius: 6px;
            box-shadow: var(--shadow-md);
            z-index: 10000;
            font-size: 14px;
            font-family: var(--site-font);
            animation: slideIn 0.3s ease;
        `;
        notification.textContent = message;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    // Add CSS animations
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(400px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(400px); opacity: 0; }
        }
        @keyframes dropdownSlideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        .kuri-cp-dropdown-menu::-webkit-scrollbar {
            width: 8px;
        }
        .kuri-cp-dropdown-menu::-webkit-scrollbar-track {
            background: transparent;
        }
        .kuri-cp-dropdown-menu::-webkit-scrollbar-thumb {
            background: #888;
            border-radius: 4px;
        }
        .kuri-cp-dropdown-menu::-webkit-scrollbar-thumb:hover {
            background: #555;
        }
    `;
    document.head.appendChild(style);

    // Remove "Sign in with Google" text span to save space
    function removeGoogleSignInText() {
        const googleBtn = document.querySelector('.google-signin-btn span');
        if (googleBtn && googleBtn.textContent.includes('Sign in with Google')) {
            googleBtn.remove();
            //console.log('✂️ Removed Google sign-in text to save space');
            return true;
        }
        return false;
    }

    function removeTotalUsageText() {
        const usageCounterDiv = document.querySelector('div.usage-counter');
        if (usageCounterDiv) {
            usageCounterDiv.remove();
            //console.log('✂️ Removed Total Usage element to save space');
            return true;
        }
        return false;
    }

    // Inject dropdown
    function injectDropdown() {
        const navActions = document.querySelector('.nav-actions');

        if (navActions && !document.querySelector('[data-injected="true"]')) {
            const dropdown = createSyncDropdown();
            navActions.prepend(dropdown);
            console.log('✅ Kuri CP Sync Manager injected!');
            return true;
        }
        return false;
    }

    // Check and re-inject if missing
    function checkAndReinject() {
        const navActions = document.querySelector('.nav-actions');
        const existingDropdown = document.querySelector('[data-injected="true"]');

        // Dropdown exists and is still in DOM
        if (existingDropdown && document.contains(existingDropdown)) {
            currentDropdown = existingDropdown;
            return;
        }

        // Need to inject (either missing or removed by Vue)
        if (navActions && !existingDropdown) {
            const dropdown = injectDropdown();
            currentDropdown = dropdown;
        }
    }

    // Check and modify Google button
    function checkAndModifyGoogleButton() {
        const googleBtn = document.querySelector('.google-signin-btn span');
        // Check if it's a different element or text changed back
        if (googleBtn && googleBtn !== lastCheckedGoogleBtn) {
            if (googleBtn.textContent.includes('Sign in with Google')) {
                removeGoogleSignInText();
                lastCheckedGoogleBtn = googleBtn;
            }
        }
        // Reset if element disappeared (Vue unmounted it)
        if (lastCheckedGoogleBtn && !document.contains(lastCheckedGoogleBtn)) {
            lastCheckedGoogleBtn = null;
        }
    }

    // Check and modify Total Usage text
    function checkAndModifyTotalUsageText() {
        const usageText = document.querySelector('div.usage-counter');
        if (usageText) {
            removeTotalUsageText();
        }
        // Check if it's a different element or text changed back
        if (usageText && usageText !== lastCheckedUsageDiv) {
            removeTotalUsageText();
            lastCheckedUsageDiv = usageText;
        }
        // Reset if element disappeared (Vue unmounted it)
        if (lastCheckedUsageDiv && !document.contains(lastCheckedUsageDiv)) {
            lastCheckedUsageDiv = null;
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
                        applyThemeToDropdown(container, newTheme);
                        console.log('🎨 Theme changed to:', newTheme);
                    }
                }
            });
        });

        themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    // Initialize
    function init() {
        injectDropdown();
        watchThemeChanges();
        removeGoogleSignInText();
        removeTotalUsageText();

        const observer = new MutationObserver((mutations) => {
            // But add throttling to prevent excessive calls
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();