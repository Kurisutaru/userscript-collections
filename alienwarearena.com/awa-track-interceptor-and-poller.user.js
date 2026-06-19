// ==UserScript==
// @name         AWA Track Interceptor and Poller
// @namespace    https://www.kurisutaru.net/
// @version      1.3
// @author       Kurisutaru
// @description  Optimized track request interceptor and poller
// @match        https://www.twitch.tv/*
// @match        https://ehc5ey5g9hoehi8ys54lr6eknomqgr.ext-twitch.tv/*
// @downloadURL  https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/alienwarearena.com/awa-track-interceptor-and-poller.user.js
// @updateURL    https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/alienwarearena.com/awa-track-interceptor-and-poller.user.js
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_notification
// @grant        GM_getResourceURL
// @grant        window.close
// @require      https://cdn.jsdelivr.net/npm/post-event@0.4.0/dist/PostEvent.min.js
// @resource     alertMP3 https://raw.githubusercontent.com/Kurisutaru/userscript-collections/main/alienwarearena.com/alert.mp3
// ==/UserScript==

(function () {
    'use strict';

    const win = unsafeWindow || window;
    let authToken = null;
    let channelId = null;
    const log = (msg, ...args) => console.log(`[AWA:${context}] ${msg}`, ...args);
    const RETRY_MAX = 5;
    const POLL_INTERVAL = 60000;
    const EVENT_NAME = "KuriAwaFixEvent";
    const url = location.href;
    let OFFLINE_COUNT = 0; // Fixed: changed from const to let
    let isPolling = false; // Track if polling is already active

    // Efficiently load MP3 via Tampermonkey resource
    var alertSound = new Audio(GM_getResourceURL("alertMP3"));

    let context = 'Main';

    if (url.indexOf("ehc5ey5g9hoehi8ys54lr6eknomqgr.ext-twitch.tv") !== -1) {
        context = 'Extension';
    }

    log('Script initialized');

    //Script run on the Alienware Extension to get the jwtKey and channelKey
    if (context === 'Extension') {
        // Fetch interception
        const originalFetch = win.fetch;
        win.fetch = async function (resource, init = {}) {
            const reqUrl = resource instanceof Request ? resource.url : resource.toString();

            if (reqUrl.includes('track')) {
                log('TRACK detected:', reqUrl);

                const headers = init?.headers ? new Headers(init.headers) : null;
                if (headers) {
                    const newAuthToken = headers.get('x-extension-jwt');
                    const newChannelId = headers.get('x-extension-channel');

                    if (newAuthToken && newChannelId) {
                        // Improved: Kept interceptor active for future token refreshes
                        if (newAuthToken !== authToken || newChannelId !== channelId) {
                            authToken = newAuthToken;
                            channelId = newChannelId;
                            log('Credentials captured/refreshed - pinging Main Thread');
                            var postEvent = new PostEvent();
                            postEvent.trigger(EVENT_NAME, {authTokenParam: authToken, channelIdParam: channelId});
                        }
                    }
                }

                try {
                    const response = await originalFetch.apply(this, arguments);
                    const cloned = response.clone();
                    const contentType = cloned.headers.get('content-type') || '';

                    if (contentType.includes('application/json')) {
                        log('TRACK response:', await cloned.json());
                    }
                    return response;
                } catch (error) {
                    log('Fetch error:', error);
                    return originalFetch.apply(this, arguments);
                }
            }
            return originalFetch.apply(this, arguments);
        };
    }

    //Script run on the Twitch to polling and report progress
    if (context === 'Main') {
        // Create progress container
        const mainContainer = document.createElement('div');
        mainContainer.style = `display: flex;
                          align-items: center;
                          flex-direction: column;
                          margin: 0 16px;
                          gap: 4px;
                          cursor: default;
                          `;

        const awaFixText = document.createElement('div');
        awaFixText.style = `color: #efeff1;
                        font-size: 12px;
                        font-family: Inter,
                        Roobert, Helvetica;
                        font-weight: bold;
                        `;
        awaFixText.textContent = 'Kuri Awa Fix';

        // Progress bar elements
        const progressbarContainer = document.createElement('div');
        progressbarContainer.style = `display: flex;
                                  align-items: center;
                                  `;

        const progressBarBackground = document.createElement('div');
        progressBarBackground.style = `width: 120px;
                                    height: 4px;
                                    background-color: #ffffff33;
                                    border-radius: 2px;
                                    overflow: hidden;
                                    `;

        const progressBar = document.createElement('div');
        progressBar.style = 'width: 0%; height: 100%; background-color: #9147ff; transition: width 0.3s ease;';

        // Assemble elements
        progressBarBackground.appendChild(progressBar);
        progressbarContainer.appendChild(progressBarBackground);
        mainContainer.appendChild(awaFixText);
        mainContainer.appendChild(progressbarContainer);

        // Insert into Twitch navigation
        let injectInterval = null;
        function injectProgressBar() {
            clearInterval(injectInterval);
            injectInterval = setInterval(() => {
                const twitchNav = document.querySelector('.top-nav__prime');
                if (twitchNav && !document.querySelector('#kuri-awa-fix-container')) {
                    mainContainer.id = 'kuri-awa-fix-container';
                    twitchNav.parentElement.insertBefore(mainContainer, twitchNav);
                    clearInterval(injectInterval);
                }
            }, 1000);
        }

        // Update function
        function updateProgress(current, max) {
            // Fixed: potential divide-by-zero issues
            const safeMax = max > 0 ? max : 1;
            const percent = Math.min((current / safeMax) * 100, 100);
            progressBar.style.width = `${percent}%`;
            mainContainer.title = `${Math.floor(percent)}%`
        }

        //Remove Watcher by adding Event Listener
        let event = new PostEvent();
        event.on(EVENT_NAME, function (params) {
            authToken = params.authTokenParam;
            channelId = params.channelIdParam;

            // Improved: Added sessionStorage credential persistence
            sessionStorage.setItem('awa_authToken', authToken);
            sessionStorage.setItem('awa_channelId', channelId);

            injectProgressBar();
            if (!isPolling) {
                awafix();
            }
        });

        // Improved: Restore from sessionStorage on load
        const savedToken = sessionStorage.getItem('awa_authToken');
        const savedChannel = sessionStorage.getItem('awa_channelId');
        if (savedToken && savedChannel) {
            authToken = savedToken;
            channelId = savedChannel;
            injectProgressBar();
            awafix();
        }

        // Polling system
        async function awafix() {
            if (isPolling) return;
            isPolling = true;

            let retries = 0;
            const controller = new AbortController();

            const poll = async () => {
                // Improved: Added request timeout protection
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                try {
                    const response = await fetch("https://www.alienwarearena.com/twitch/extensions/track", {
                        headers: {
                            'x-extension-jwt': authToken,
                            'x-extension-channel': channelId
                        },
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);
                    const data = await response.json();
                    log('Poll response:', data);

                    if (data.state === "daily_cap_reached") {
                        sendNotification("Daily Cap Reached", true);
                        log('Daily Cap Reach');
                        isPolling = false;
                        return;
                    }

                    // Fixed: crashes caused by missing ARP fields
                    const currentArp = data.userCurrentArp || 0;
                    const maxArp = data.userMaxArp || 1;

                    log(`ARP: ${currentArp.toFixed(2)}/${maxArp}`);
                    log(createProgressBar(currentArp, maxArp));
                    updateProgress(currentArp, maxArp);

                    if (data.state === "streamer_offline") {
                        OFFLINE_COUNT++;
                        if(OFFLINE_COUNT >= RETRY_MAX) {
                            sendNotification("Streamer Offline");
                            isPolling = false;
                            return;
                        }
                    } else {
                        // Fixed: OFFLINE_COUNT not resetting after successful polls
                        OFFLINE_COUNT = 0;
                    }

                    retries = 0;
                    setTimeout(poll, POLL_INTERVAL);
                } catch (error) {
                    clearTimeout(timeoutId);
                    if (error.name === 'AbortError') {
                        log('Request timed out');
                    } else {
                        log('Fetch error:', error);
                    }

                    if (retries++ < RETRY_MAX) {
                        // Improved: Improved retry diagnostics
                        log(`Retrying (${retries}/${RETRY_MAX})`);
                        setTimeout(poll, 1000 * Math.min(retries, 5));
                    } else {
                        log('Max retries reached - reloading');
                        isPolling = false;
                        win.location.reload();
                    }
                }
            };

            poll();
            win.addEventListener('beforeunload', () => controller.abort());
        }

        // Progress bar generator
        function createProgressBar(current, max, width = 20) {
            // Fixed: potential divide-by-zero issues
            const safeMax = max > 0 ? max : 1;
            const percentage = current / safeMax;
            const filled = Math.round(width * percentage);
            return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${(percentage * 100).toFixed(2)}%`;
        }

        //Function Send Notification
        function sendNotification(msg, closeWindow = true) {
            alertSound.play();
            GM_notification({
                title: 'Kurisutaru AWA Fix',
                text: msg,
                onclick: (event) => {
                    if (closeWindow) window.close();
                }
            });
        }
    }
})();