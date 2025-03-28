const botCountEl = document.getElementById('bot-count');
const serverCountEl = document.getElementById('server-count');
const totalFlingsEl = document.getElementById('total-flings');
const flingRateEl = document.getElementById('fling-rate');
const regionListEl = document.getElementById('region-distribution-list');
const reservationsContainerEl = document.getElementById('reservations-container');
const lastUpdatedEl = document.getElementById('last-updated-time');
const toggleJsonBtn = document.getElementById('toggle-json');
const jsonPreContainer = document.getElementById('json-pre-container');
const copyJsonBtn = document.getElementById('copy-json');
const liveIndicator = document.querySelector('.live-indicator');
const topLiveIndicator = document.querySelector('.top-live-indicator');
const flingFeedList = document.getElementById('fling-feed');
const chatLogFeedList = document.getElementById('chat-log-feed');
const chatLogSection = document.getElementById('chat-log-section');
const chatSearchInput = document.getElementById('chat-search');
const noResultsMessage = chatLogFeedList?.querySelector('.no-results-message');

const statItems = {
    bots: document.getElementById('stat-bots'),
    servers: document.getElementById('stat-servers'),
    flings: document.getElementById('stat-flings'),
    flingRate: document.getElementById('stat-fling-rate')
};
const regionContainer = document.getElementById('region-stats-container');

const sortButtons = document.querySelectorAll('.sort-btn');
const themeSelectorEl = document.getElementById('theme-selector');
const themeLinkEl = document.getElementById('hljs-theme-link');
const gradientColorPicker1 = document.getElementById('gradient-color-1');
const gradientColorPicker2 = document.getElementById('gradient-color-2');
const gradientSelectorContainerEl = document.getElementById('gradient-selector-container');

const UPDATE_INTERVAL = 1500;
const HLJS_CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/";
const MAX_FEED_ITEMS = 250;
const MAX_CHAT_ITEMS = 250;
const LOCALSTORAGE_THEME_KEY = 'tcdDashboardTheme';
const LOCALSTORAGE_GRADIENT_COLOR_1 = 'tcdGradientColor1';
const LOCALSTORAGE_GRADIENT_COLOR_2 = 'tcdGradientColor2';
const DEFAULT_GRADIENT_COLOR_1 = '#ee44b6';
const DEFAULT_GRADIENT_COLOR_2 = '#ed9344';
const PREDEFINED_GRADIENTS = [
    { id: 'Jvnesh', color1: '#ee44b6', color2: '#ed9344', name: 'Jvnesh' },
    { id: 'sunset', color1: '#FF512F', color2: '#DD2476', name: 'Sunset Red' },
    { id: 'purple', color1: '#DA22FF', color2: '#9733EE', name: 'KRV' },
    { id: 'monotone', color1: '#d1d1d1', color2: '#787878', name: 'Corpo Neutral'}
];

let currentSortKey = 'timestamp';
let initialLoadComplete = false;
let previousReservationsData = null;
let updateScheduled = false;
let latestDisplayedFlingTimestamp = 0;
let latestDisplayedChatTimestamp = 0;
let currentChatFilter = '';


async function updateData() {
    try {
        const [statsResponse, reservationsResponse, flingsResponse, chatLogsResponse] = await Promise.all([
            fetch('/'),
            fetch('/reservations'),
            fetch('/flings'),
            fetch('/get_chatlogs?limit=' + MAX_CHAT_ITEMS)
        ]);

        if (!statsResponse.ok) throw new Error(`Stats fetch failed: ${statsResponse.status} ${statsResponse.statusText}`);
        if (!reservationsResponse.ok) throw new Error(`Reservations fetch failed: ${reservationsResponse.status} ${reservationsResponse.statusText}`);
        if (!flingsResponse.ok) throw new Error(`Flings fetch failed: ${flingsResponse.status} ${flingsResponse.statusText}`);
        if (!chatLogsResponse.ok) throw new Error(`ChatLogs fetch failed: ${chatLogsResponse.status} ${chatLogsResponse.statusText}`);

        const statsData = await statsResponse.json();
        const reservationsData = await reservationsResponse.json();
        const flingsData = await flingsResponse.json();
        const chatLogsData = await chatLogsResponse.json();

        processUpdate(statsData, reservationsData, flingsData, chatLogsData);

        setErrorState(null);
        initialLoadComplete = true;

    } catch (error) {
        console.error("Error fetching or processing data:", error);
        setErrorState(error.message || "Unknown error");
        initialLoadComplete = true;
    }
}

function processUpdate(stats, reservations, flings, chatLogs) {
    applyUpdateEffect(botCountEl, stats?.botCount);
    applyUpdateEffect(serverCountEl, stats?.serverCount);
    applyUpdateEffect(totalFlingsEl, stats?.totalFlings);
    const rate = stats?.flingRatePerMinute;
    applyUpdateEffect(flingRateEl, typeof rate === 'number' ? rate.toFixed(1) : '?');

    if (lastUpdatedEl) lastUpdatedEl.textContent = new Date().toLocaleTimeString();
    if (liveIndicator && !liveIndicator.classList.contains('pulsing')) liveIndicator.classList.add('pulsing');
    if (topLiveIndicator && !topLiveIndicator.classList.contains('pulsing')) topLiveIndicator.classList.add('pulsing');

    updateRegionDistribution(stats?.botsPerRegion);

    const currentDataString = JSON.stringify(reservations);
    const previousDataString = JSON.stringify(previousReservationsData);
    if (currentDataString !== previousDataString || !initialLoadComplete) {
        previousReservationsData = reservations;
        scheduleJsonUpdate(reservations);
    } else {
        if (reservationsContainerEl && reservationsContainerEl.classList.contains('loading')) {
            reservationsContainerEl.classList.remove('loading');
            if (!previousReservationsData || (Array.isArray(previousReservationsData) && previousReservationsData.length === 0)) {
                reservationsContainerEl.classList.add('empty');
                reservationsContainerEl.textContent = 'No active reservations.';
            } else {
                reservationsContainerEl.classList.remove('empty');
            }
        }
    }

    updateFlingFeed(flings);
    updateChatLogFeed(chatLogs);
}

function applyUpdateEffect(element, newValue) {
    if (!element) return;
    const isLoading = element.classList.contains('loading');
    const currentValue = isLoading ? null : element.textContent;
    const newValueStr = (newValue === null || newValue === undefined) ? '?' : String(newValue);

    if (isLoading) {
        element.classList.remove('loading');
    }

    if (newValueStr === 'Error' || newValueStr === '?') {
        element.textContent = newValueStr;
        element.classList.remove('updated');
        return;
    }

    if (currentValue !== newValueStr) {
        element.textContent = newValueStr;
        if (currentValue !== null && !isLoading) {
            element.classList.add('updated');
            setTimeout(() => {
                if (element) element.classList.remove('updated');
            }, 300);
        }
    }
}

function updateRegionDistribution(regionData) {
    if (!regionListEl) return;

    regionListEl.classList.remove('loading', 'error');
    regionListEl.innerHTML = '';
    if (regionContainer) regionContainer.classList.remove('error');

    if (!regionData || typeof regionData !== 'object') {
        regionListEl.classList.add('error');
        regionListEl.innerHTML = '<li>Error loading regional data</li>';
        if (regionContainer) regionContainer.classList.add('error');
        return;
    }

    const regions = Object.keys(regionData).sort();

    if (regions.length === 0) {
        regionListEl.innerHTML = '<li>No bots active in any specific region.</li>';
        return;
    }

    regions.forEach(region => {
        const count = regionData[region];
        const li = document.createElement('li');
        li.innerHTML = `<strong>${escapeHtml(region)}:</strong> ${count} ${count === 1 ? 'bot' : 'bots'}`;
        regionListEl.appendChild(li);
    });
}

function scheduleJsonUpdate(reservationsData) {
    if (updateScheduled || !reservationsContainerEl) return;
    updateScheduled = true;

    let sortedData = [];
    if (Array.isArray(reservationsData)) {
        sortedData = [...reservationsData];
        const sortFunctions = {
            timestamp: (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
            players: (a, b) => (b.currentPlayerCount ?? -1) - (a.currentPlayerCount ?? -1),
            region: (a, b) => (a.region || '').localeCompare(b.region || ''),
            id: (a, b) => (a.serverId || '').localeCompare(b.serverId || '')
        };
        if (sortFunctions[currentSortKey]) {
            sortedData.sort(sortFunctions[currentSortKey]);
        } else {
            console.warn("Unknown sort key:", currentSortKey);
            sortedData.sort(sortFunctions.timestamp);
        }
    } else {
        console.warn("Reservations data is not an array:", reservationsData);
        sortedData = reservationsData;
    }

    requestAnimationFrame(() => {
        try {
            let finalHtml = '';
            let isEmpty = true;

            if (sortedData === null || sortedData === undefined) {
                finalHtml = 'No reservation data received.';
                reservationsContainerEl.classList.add('loading');
                reservationsContainerEl.classList.remove('empty', 'error');
            } else if (Array.isArray(sortedData)) {
                if (sortedData.length === 0) {
                    finalHtml = 'No active reservations.';
                    isEmpty = true;
                    reservationsContainerEl.classList.remove('loading', 'error');
                } else {
                    isEmpty = false;
                    sortedData.forEach(item => {
                        const itemString = JSON.stringify(item, null, 2);
                        let highlightedCode = escapeHtml(itemString);

                        if (typeof hljs !== 'undefined' && hljs.highlight) {
                            try {
                                highlightedCode = hljs.highlight(itemString, { language: 'json' }).value;
                            } catch (highlightError) {
                                console.error("Highlighting error for item:", item, highlightError);
                            }
                        }
                        finalHtml += `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                    });
                    reservationsContainerEl.classList.remove('loading', 'error');
                }
             } else if (typeof sortedData === 'object' && Object.keys(sortedData).length > 0) {
                console.warn("Rendering single object for reservations:", sortedData);
                isEmpty = false;
                const itemString = JSON.stringify(sortedData, null, 2);
                let highlightedCode = escapeHtml(itemString);
                if (typeof hljs !== 'undefined' && hljs.highlight) { try { highlightedCode = hljs.highlight(itemString, { language: 'json' }).value; } catch(e){} }
                finalHtml = `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                reservationsContainerEl.classList.remove('loading', 'error');
             } else if (typeof sortedData === 'object' && Object.keys(sortedData).length === 0) {
                finalHtml = 'No active reservations. (Empty object)';
                isEmpty = true;
                reservationsContainerEl.classList.remove('loading', 'error');
            } else {
                finalHtml = `Received unexpected data format.`;
                isEmpty = true;
                reservationsContainerEl.classList.add('error');
                reservationsContainerEl.classList.remove('loading', 'empty');
                console.error("Unexpected reservations data format received:", sortedData);
            }

            reservationsContainerEl.innerHTML = finalHtml;

            if (isEmpty && !reservationsContainerEl.classList.contains('loading') && !reservationsContainerEl.classList.contains('error')) {
                 reservationsContainerEl.classList.add('empty');
            } else {
                 reservationsContainerEl.classList.remove('empty');
            }
        } catch (e) {
            console.error("Error during DOM update in scheduleJsonUpdate:", e);
            if (reservationsContainerEl) {
                reservationsContainerEl.innerHTML = `Error displaying JSON view: ${escapeHtml(e.message)}`;
                reservationsContainerEl.classList.remove('loading', 'empty');
                reservationsContainerEl.classList.add('error');
            }
        } finally {
            updateScheduled = false;
        }
    });
}

function updateFlingFeed(flingsData) {
    if (!flingFeedList || !Array.isArray(flingsData)) {
        console.warn("Invalid flings data received or feed element missing.");
        if (flingFeedList) {
            flingFeedList.innerHTML = '<li class="error-feed-message">Error loading fling data.</li>';
        }
        return;
    }

    let newEventsAdded = false;

    for (let i = flingsData.length - 1; i >= 0; i--) {
        const fling = flingsData[i];
        if (fling.timestamp > latestDisplayedFlingTimestamp) {
            addFlingToFeed(fling);
            newEventsAdded = true;
            if (fling.timestamp > latestDisplayedFlingTimestamp) {
                latestDisplayedFlingTimestamp = fling.timestamp;
            }
        } else {
            break;
        }
    }

    if (newEventsAdded) {
        const placeholders = flingFeedList.querySelectorAll('.empty-feed-message, .error-feed-message');
        placeholders.forEach(p => p.remove());
    }

    while (flingFeedList.children.length > MAX_FEED_ITEMS) {
        if (flingFeedList.lastChild && !flingFeedList.lastChild.matches('.empty-feed-message, .error-feed-message')) {
            flingFeedList.lastChild.remove();
        } else {
            break;
        }
    }

    if (flingFeedList.children.length === 0 && !flingFeedList.querySelector('.error-feed-message')) {
         flingFeedList.innerHTML = '<li class="empty-feed-message">No recent fling reports.</li>';
    }
}

function addFlingToFeed(flingData) {
    if (!flingFeedList) return;

    const li = document.createElement('li');
    const eventTime = new Date(flingData.timestamp * 1000);
    const timeString = eventTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const botName = escapeHtml(flingData.botName || 'Unknown Bot');
    const targetName = escapeHtml(flingData.target || 'Unknown Target');

    li.innerHTML = `
        <span class="fling-details">
            <span class="fling-bot">${botName}</span> flung <span class="fling-target">${targetName}</span>
        </span>
        <span class="fling-time">${timeString}</span>
    `;
    flingFeedList.prepend(li);
}

function updateChatLogFeed(chatLogsData) {
    if (!chatLogFeedList || !Array.isArray(chatLogsData)) {
        console.warn("Invalid chat logs data received or feed element missing.");
        if (chatLogFeedList) {
            chatLogFeedList.innerHTML = `
                <li class="error-feed-message">Error loading chat data.</li>
                <li class="no-results-message" style="display: none;"></li>
            `;
        }
        return;
    }

    let newMessagesAdded = false;
    for (let i = chatLogsData.length - 1; i >= 0; i--) {
        const log = chatLogsData[i];
        if (log.received_at > latestDisplayedChatTimestamp) {
            addChatToFeed(log);
            newMessagesAdded = true;

            if (log.received_at > latestDisplayedChatTimestamp) {
                latestDisplayedChatTimestamp = log.received_at;
            }
        } else {
            break;
        }
    }

    if (newMessagesAdded || chatLogsData.length > 0) {
        const errorMessages = chatLogFeedList.querySelectorAll('.error-feed-message');
        errorMessages.forEach(msg => msg.remove());
    }

    const allEntries = chatLogFeedList.querySelectorAll('li.chat-entry');
    let currentItemCount = allEntries.length;

    while (currentItemCount > MAX_CHAT_ITEMS) {
        let oldestEntry = null;

        for(let k = chatLogFeedList.children.length - 1; k >= 0; k--) {
            if (chatLogFeedList.children[k].classList.contains('chat-entry')) {
                oldestEntry = chatLogFeedList.children[k];
                break;
            }
        }
        if (oldestEntry) {
            oldestEntry.remove();
            currentItemCount--;
        } else {
            break; 
        }
    }

    filterChatLogs();
}


function addChatToFeed(logData) {
    if (!chatLogFeedList) return;

    const li = document.createElement('li');
    li.classList.add('chat-entry');

    const receivedTime = new Date(logData.received_at * 1000);
    const timeString = receivedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const playerName = escapeHtml(logData.playerName || 'Unknown Player');
    const message = escapeHtml(logData.message || '');

    li.innerHTML = `
        <div class="chat-meta">
            <span class="chat-player">${playerName}:</span>
            <span class="chat-timestamp">${timeString}</span>
        </div>
        <div class="chat-message">${message}</div>
    `;

    chatLogFeedList.prepend(li);

    const playerNameLower = playerName.toLowerCase();
    const messageLower = message.toLowerCase();
    const combinedText = playerNameLower + ' ' + messageLower;
    const isMatch = currentChatFilter === '' || combinedText.includes(currentChatFilter);
    li.style.display = isMatch ? '' : 'none';
}

function filterChatLogs() {
    if (!chatLogFeedList || !chatSearchInput) return;

    currentChatFilter = chatSearchInput.value.toLowerCase().trim();
    const allMessages = chatLogFeedList.querySelectorAll('li.chat-entry');
    let visibleCount = 0;

    allMessages.forEach(li => {
        const playerName = li.querySelector('.chat-player')?.textContent.toLowerCase() || '';
        const messageText = li.querySelector('.chat-message')?.textContent.toLowerCase() || '';
        const combinedText = playerName + ' ' + messageText;

        const isMatch = currentChatFilter === '' || combinedText.includes(currentChatFilter);

        li.style.display = isMatch ? '' : 'none';
        if (isMatch) {
            visibleCount++;
        }
    });

    const hasAnyMessages = chatLogFeedList.querySelectorAll('li.chat-entry').length > 0;
    const emptyMessage = chatLogFeedList.querySelector('.empty-feed-message');
    const noResults = chatLogFeedList.querySelector('.no-results-message');

    if (emptyMessage) {
        emptyMessage.style.display = (!hasAnyMessages && currentChatFilter === '') ? 'flex' : 'none';
    }
    if (noResults) {
        const showNoResults = hasAnyMessages && visibleCount === 0 && currentChatFilter !== '';
        noResults.style.display = showNoResults ? 'flex' : 'none';
    }
}

function setInitialLoadingState() {
    // Stats
    const statElements = [botCountEl, serverCountEl, totalFlingsEl, flingRateEl];
    statElements.forEach(el => {
        if (el) {
            el.textContent = 'Loading...';
            el.classList.add('loading');
            const container = el.closest('.stat-item');
            if (container) container.classList.remove('error');
        }
    });

    if (reservationsContainerEl) {
        reservationsContainerEl.classList.add('loading');
        reservationsContainerEl.classList.remove('empty', 'error');
        reservationsContainerEl.innerHTML = 'Loading reservation data...';
    }

    if (regionListEl) {
         regionListEl.classList.add('loading');
         regionListEl.classList.remove('error');
         if (regionContainer) regionContainer.classList.remove('error');
         regionListEl.innerHTML = '<li>Loading regional data...</li>';
    }

    if (flingFeedList) {
        flingFeedList.innerHTML = '<li class="empty-feed-message">Waiting for fling reports...</li>';
    }

    if (chatLogFeedList) {
        chatLogFeedList.innerHTML = `
            <li class="empty-feed-message">Loading chat messages...</li>
            <li class="no-results-message" style="display: none;"></li>
        `;
    }
    if (chatLogSection) {
        chatLogSection.classList.remove('error');
    }
    if(chatSearchInput) {
        chatSearchInput.value = '';
        currentChatFilter = '';
    }

    if (liveIndicator) liveIndicator.classList.remove('pulsing');
    if (topLiveIndicator) topLiveIndicator.classList.remove('pulsing');
    if (lastUpdatedEl) lastUpdatedEl.textContent = 'Never';
}

function setErrorState(errorMessage) {
    const isError = errorMessage !== null;

    Object.values(statItems).forEach(itemContainer => {
        if (itemContainer) itemContainer.classList.toggle('error', isError);
    });
    if (regionContainer) regionContainer.classList.toggle('error', isError);

    if (isError) {
        applyUpdateEffect(botCountEl, 'Error');
        applyUpdateEffect(serverCountEl, 'Error');
        applyUpdateEffect(totalFlingsEl, 'Error');
        applyUpdateEffect(flingRateEl, 'Error');

        if (regionListEl) {
            regionListEl.classList.remove('loading');
            regionListEl.classList.add('error');
            regionListEl.innerHTML = `<li>Error: ${escapeHtml(errorMessage)}</li>`;
        }

        if (reservationsContainerEl) {
            reservationsContainerEl.classList.remove('loading', 'empty');
            reservationsContainerEl.classList.add('error');
            reservationsContainerEl.innerHTML = `Failed to load data: ${escapeHtml(errorMessage)}`;
        }

        if (flingFeedList) {
            flingFeedList.innerHTML = `<li class="error-feed-message">Fling Error: ${escapeHtml(errorMessage)}</li>`;
        }

        if (chatLogFeedList) {
            chatLogFeedList.innerHTML = `
                <li class="error-feed-message">Chat Error: ${escapeHtml(errorMessage)}</li>
                <li class="no-results-message" style="display: none;"></li>
            `;
        }

        if (lastUpdatedEl) lastUpdatedEl.textContent = 'Update Failed';
        if (liveIndicator) liveIndicator.classList.remove('pulsing');
        if (topLiveIndicator) topLiveIndicator.classList.remove('pulsing');

    } else {
        if (lastUpdatedEl && (lastUpdatedEl.textContent === 'Update Failed' || lastUpdatedEl.textContent === 'Never')) {
            lastUpdatedEl.textContent = 'Updating...';
        }
        if (liveIndicator && !liveIndicator.classList.contains('pulsing')) {
             liveIndicator.classList.add('pulsing');
        }
        if (topLiveIndicator && !topLiveIndicator.classList.contains('pulsing')) {
             topLiveIndicator.classList.add('pulsing');
        }

        const flingError = flingFeedList?.querySelector('.error-feed-message');
        if (flingError) flingError.remove();

        const chatError = chatLogFeedList?.querySelector('.error-feed-message');
        if (chatError) chatError.remove();

        const regionError = regionListEl?.querySelector('li');
        if (regionListEl && regionError && regionListEl.classList.contains('error')) {
            regionListEl.innerHTML = '<li>Reloading regional data...</li>';
            regionListEl.classList.add('loading');
            regionListEl.classList.remove('error');
        }

        if(reservationsContainerEl && reservationsContainerEl.classList.contains('error')){
            reservationsContainerEl.classList.remove('error');
            reservationsContainerEl.classList.add('loading');
            reservationsContainerEl.innerHTML = 'Reloading reservation data...';
        }

        filterChatLogs();
        if (flingFeedList && flingFeedList.children.length === 0) {
            flingFeedList.innerHTML = '<li class="empty-feed-message">Waiting for fling reports...</li>';
        }
    }
}

toggleJsonBtn?.addEventListener('click', () => {
    if (jsonPreContainer) {
        const isHidden = jsonPreContainer.classList.toggle('hidden');
        toggleJsonBtn.textContent = isHidden ? 'Show' : 'Hide';
        toggleJsonBtn.setAttribute('aria-expanded', String(!isHidden));
    }
});

copyJsonBtn?.addEventListener('click', () => {
    if (previousReservationsData === null || previousReservationsData === undefined) {
        console.warn("No valid reservation data to copy.");
        copyJsonBtn.innerHTML = '<i class="fas fa-times"></i> No Data';
        copyJsonBtn.disabled = true;
        setTimeout(() => {
            copyJsonBtn.innerHTML = '<i class="far fa-copy"></i> Copy';
            copyJsonBtn.disabled = false;
         }, 1500);
        return;
    }
    try {
         let dataToCopy = [];
         if (Array.isArray(previousReservationsData)) {
            dataToCopy = [...previousReservationsData];
            const sortFunctions = {
                timestamp: (a, b) => (b.timestamp || 0) - (a.timestamp || 0), players: (a, b) => (b.currentPlayerCount ?? -1) - (a.currentPlayerCount ?? -1), region: (a, b) => (a.region || '').localeCompare(b.region || ''), id: (a, b) => (a.serverId || '').localeCompare(b.serverId || '')};
            if (sortFunctions[currentSortKey]) dataToCopy.sort(sortFunctions[currentSortKey]);
            else dataToCopy.sort(sortFunctions.timestamp);
        } else {
            dataToCopy = previousReservationsData;
        }

        const jsonTextToCopy = JSON.stringify(dataToCopy, null, 2);
        navigator.clipboard.writeText(jsonTextToCopy).then(() => {
            copyJsonBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            copyJsonBtn.disabled = true;
            setTimeout(() => {
                copyJsonBtn.innerHTML = '<i class="far fa-copy"></i> Copy';
                copyJsonBtn.disabled = false;
            }, 1500);
        }).catch(err => {
            console.error('Failed to copy JSON: ', err);
            copyJsonBtn.innerHTML = '<i class="fas fa-times"></i> Failed';
            copyJsonBtn.disabled = true;
            setTimeout(() => {
                copyJsonBtn.innerHTML = '<i class="far fa-copy"></i> Copy';
                copyJsonBtn.disabled = false;
            }, 1500);
        });
    } catch (e) {
        console.error('Error preparing data for copy:', e);
        copyJsonBtn.innerHTML = '<i class="fas fa-times"></i> Error';
         copyJsonBtn.disabled = true;
         setTimeout(() => {
             copyJsonBtn.innerHTML = '<i class="far fa-copy"></i> Copy';
             copyJsonBtn.disabled = false;
          }, 1500);
    }
});

sortButtons?.forEach(button => {
    button.addEventListener('click', () => {
        const newSortKey = button.id.replace('sort-', '');
        if (newSortKey === currentSortKey) return;

        currentSortKey = newSortKey;

        sortButtons.forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        if (previousReservationsData !== null) {
            scheduleJsonUpdate(previousReservationsData);
        } else {
            console.log("Sort changed to:", currentSortKey, "but no reservation data to re-render yet.");
        }
    });
});

themeSelectorEl?.addEventListener('change', () => {
    const selectedTheme = themeSelectorEl.value;
    applyTheme(selectedTheme);
    try {
        localStorage.setItem(LOCALSTORAGE_THEME_KEY, selectedTheme);
    } catch(e) { console.warn("Could not save theme to localStorage:", e.message); }

    setTimeout(() => {
        if (previousReservationsData !== null && reservationsContainerEl && !reservationsContainerEl.classList.contains('loading') && !reservationsContainerEl.classList.contains('empty')) {
            console.log("Forcing JSON re-render for new theme:", selectedTheme);
            scheduleJsonUpdate(previousReservationsData);
        } else {
            console.log("Theme changed, but no JSON data to re-render/highlight.");
        }
    }, 150);
});

function applyTheme(themeValue) {
    if (!themeLinkEl || !themeValue) return;
    const newThemeUrl = `${HLJS_CDN_BASE}${themeValue}.min.css`;
    const currentHref = themeLinkEl.getAttribute('href');

    if (currentHref !== newThemeUrl) {
        console.log("Applying theme CSS:", themeValue);
        themeLinkEl.setAttribute('href', newThemeUrl);
    }

    if (themeSelectorEl.value !== themeValue) {
        themeSelectorEl.value = themeValue;
    }
}

function loadThemePreference() {
    let savedTheme = null;
    try {
        savedTheme = localStorage.getItem(LOCALSTORAGE_THEME_KEY);
    } catch(e) { console.warn("Could not access localStorage for theme:", e.message); }
    const initialTheme = savedTheme || 'atom-one-dark';
    applyTheme(initialTheme);
}

function findPresetByColors(color1, color2) {
     return PREDEFINED_GRADIENTS.find(g => g.color1 === color1 && g.color2 === color2);
}

function applyGradient(color1, color2) {
    const gradientValue = `linear-gradient(90deg, ${color1} 0%, ${color2} 100%)`;
    console.log("Applying gradient:", gradientValue);
    document.documentElement.style.setProperty('--brand-gradient', gradientValue);

    if (gradientColorPicker1 && gradientColorPicker1.value !== color1) {
        gradientColorPicker1.value = color1;
    }
    if (gradientColorPicker2 && gradientColorPicker2.value !== color2) {
        gradientColorPicker2.value = color2;
    }

    const swatches = gradientSelectorContainerEl?.querySelectorAll('.gradient-swatch');
    swatches?.forEach(swatch => {
        swatch.classList.remove('active');
        swatch.setAttribute('aria-pressed', 'false');
    });

    const matchingPreset = findPresetByColors(color1, color2);
    if (matchingPreset) {
        swatches?.forEach(swatch => {
            if (swatch.dataset.gradientId === matchingPreset.id) {
                swatch.classList.add('active');
                swatch.setAttribute('aria-pressed', 'true');
            }
        });
    }
}

function loadGradientPreference() {
    let savedColor1 = null;
    let savedColor2 = null;
    try {
      savedColor1 = localStorage.getItem(LOCALSTORAGE_GRADIENT_COLOR_1);
      savedColor2 = localStorage.getItem(LOCALSTORAGE_GRADIENT_COLOR_2);
    } catch (e) {
      console.warn("Could not access localStorage for gradient:", e.message);
    }

    const initialColor1 = savedColor1 || DEFAULT_GRADIENT_COLOR_1;
    const initialColor2 = savedColor2 || DEFAULT_GRADIENT_COLOR_2;

    applyGradient(initialColor1, initialColor2);
}


function handleGradientChange() {
    const color1 = gradientColorPicker1.value;
    const color2 = gradientColorPicker2.value;

    applyGradient(color1, color2);

    try {
       localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_1, color1);
       localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_2, color2);
    } catch (e) {
       console.warn("Could not save gradient colors to localStorage:", e.message);
    }
}

function setupGradientSelector() {
    if (!gradientSelectorContainerEl) return;
    gradientSelectorContainerEl.innerHTML = '';

    PREDEFINED_GRADIENTS.forEach(gradient => {
        const swatch = document.createElement('div');
        swatch.classList.add('gradient-swatch');
        swatch.dataset.gradientId = gradient.id;
        swatch.style.backgroundImage = `linear-gradient(90deg, ${gradient.color1} 0%, ${gradient.color2} 100%)`;
        swatch.title = gradient.name;
        swatch.setAttribute('role', 'button');
        swatch.setAttribute('aria-pressed', 'false');
        swatch.setAttribute('tabindex', '0');

        swatch.addEventListener('click', () => {
            applyGradient(gradient.color1, gradient.color2);
            try {
               localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_1, gradient.color1);
               localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_2, gradient.color2);
            } catch (e) {
               console.warn("Could not save preset gradient to localStorage:", e.message);
            }
        });

        swatch.addEventListener('keydown', (event) => {
             if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                swatch.click();
            }
         });

        gradientSelectorContainerEl.appendChild(swatch);
    });
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
         .replace(/&/g, "&")
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, '"')
         .replace(/'/g, "'");
}

chatSearchInput?.addEventListener('input', filterChatLogs);

if (gradientColorPicker1 && gradientColorPicker2) {
    gradientColorPicker1.addEventListener('input', handleGradientChange);
    gradientColorPicker2.addEventListener('input', handleGradientChange);
} else {
    console.error("Gradient color pickers not found!");
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded. Initializing TCD Dashboard (Polling Feeds including Chat).");
    setupGradientSelector();
    loadThemePreference();
    loadGradientPreference();
    setInitialLoadingState();
    filterChatLogs();
    updateData();
    setInterval(updateData, UPDATE_INTERVAL);
});