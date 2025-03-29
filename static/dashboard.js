const botCountEl = document.getElementById('bot-count');
const serverCountEl = document.getElementById('server-count');
const totalFlingsEl = document.getElementById('total-flings');
const flingRateEl = document.getElementById('fling-rate');
const regionListEl = document.getElementById('region-distribution-list');
const reservationsContainerEl = document.getElementById('reservations-container');
const lastUpdatedEl = document.getElementById('last-updated-time');
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

const flingHistoryChartCtx = document.getElementById('flingHistoryChart')?.getContext('2d');
const regionChartCtx = document.getElementById('regionChart')?.getContext('2d');

let flingHistoryChart;
let regionChart;
const MAX_CHART_POINTS = 30;

const UPDATE_INTERVAL = 2500;
const CHAT_UPDATE_INTERVAL = 750;
const FLING_UPDATE_INTERVAL = 1000;
const HLJS_CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/";
const MAX_FEED_ITEMS = 50;
const MAX_CHAT_ITEMS = 100;
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
const CHART_COLORS = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#E7E9ED', '#77DD77', '#FDFD96', '#84B4E9'];

let currentSortKey = 'timestamp';
let initialLoadComplete = false;
let previousReservationsData = null;
let updateScheduled = false;
let latestDisplayedFlingTimestamp = 0;
let latestDisplayedChatTimestamp = 0;
let currentChatFilter = '';
let globalErrorState = false;

function initializeCharts() {
    const chartFontColor = '#f0f0f0';
    const gridLineColor = 'rgba(240, 240, 240, 0.1)';

    Chart.defaults.color = chartFontColor;

    if (flingHistoryChartCtx && !flingHistoryChart) {
        flingHistoryChart = new Chart(flingHistoryChartCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Fling Rate (/min)',
                    data: [],
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    tension: 0.1,
                    yAxisID: 'yRate',
                    fill: true,
                }, {
                    label: 'Total Flings',
                    data: [],
                    borderColor: 'rgb(255, 99, 132)',
                    backgroundColor: 'rgba(255, 99, 132, 0.2)',
                    tension: 0.1,
                    yAxisID: 'yTotal',
                    fill: false,
                    pointRadius: 1,
                    borderWidth: 2,
                }]
            },
            options: {
                 responsive: true, maintainAspectRatio: false,
                 interaction: { intersect: false, mode: 'index' },
                 scales: {
                     x: { ticks: { color: chartFontColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: gridLineColor } },
                     yRate: { type: 'linear', position: 'left', ticks: { color: 'rgb(75, 192, 192)', beginAtZero: true }, grid: { color: gridLineColor }, title: { display: true, text: 'Rate', color: 'rgb(75, 192, 192)' } },
                     yTotal: { type: 'linear', position: 'right', ticks: { color: 'rgb(255, 99, 132)', beginAtZero: true }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Total', color: 'rgb(255, 99, 132)' } }
                 },
                 plugins: { legend: { labels: { color: chartFontColor } }, tooltip: { titleFont: { weight: 'bold' }, bodyFont: { size: 11 } } }
            }
        });
    }

    if (regionChartCtx && !regionChart) {
        regionChart = new Chart(regionChartCtx, {
            type: 'doughnut',
            data: { labels: [], datasets: [{ label: 'Servers by Region', data: [], backgroundColor: CHART_COLORS, borderColor: 'var(--bg-color)', borderWidth: 2 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { color: chartFontColor, boxWidth: 12, padding: 15 } } }
            }
        });
    }
}

function updateCharts(statsData) {
    const now = new Date();
    const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (flingHistoryChart) {
         const labels = flingHistoryChart.data.labels;
         const rateData = flingHistoryChart.data.datasets[0].data;
         const totalData = flingHistoryChart.data.datasets[1].data;

         labels.push(timeLabel);
         rateData.push(statsData?.flingRatePerMinute ?? 0);
         totalData.push(statsData?.totalFlings ?? 0);

         if (labels.length > MAX_CHART_POINTS) {
             labels.shift();
             rateData.shift();
             totalData.shift();
         }
         flingHistoryChart.update('none');
    }

    if (regionChart && statsData?.serversPerRegion) {
        const regionLabels = Object.keys(statsData.serversPerRegion).sort();
        const regionCounts = regionLabels.map(label => statsData.serversPerRegion[label]);

        regionChart.data.labels = regionLabels;
        regionChart.data.datasets[0].data = regionCounts;
        regionChart.data.datasets[0].backgroundColor = regionLabels.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]);
        regionChart.update('none');
    }
}


async function updateCoreData() {
    try {
        const [statsResponse, reservationsResponse] = await Promise.all([
            fetch('/'),
            fetch('/reservations')
        ]);

        if (!statsResponse.ok) throw new Error(`Stats fetch failed: ${statsResponse.status} ${statsResponse.statusText}`);
        if (!reservationsResponse.ok) throw new Error(`Reservations fetch failed: ${reservationsResponse.status} ${reservationsResponse.statusText}`);

        const statsData = await statsResponse.json();
        const reservationsData = await reservationsResponse.json();

        processCoreDataUpdate(statsData, reservationsData);
        updateCharts(statsData);

        if (globalErrorState) {
             setErrorState(null);
        }
        globalErrorState = false;

    } catch (error) {
        console.error("Error fetching core data:", error);
        setErrorState(error.message || "Unknown error fetching core data");
        globalErrorState = true;
    }
}

async function updateChatOnly() {
     if (globalErrorState) {
         return;
     }
    try {
        const chatLogsResponse = await fetch('/get_chatlogs?limit=' + MAX_CHAT_ITEMS);
        if (!chatLogsResponse.ok) {
             throw new Error(`ChatLogs fetch failed: ${chatLogsResponse.status} ${chatLogsResponse.statusText}`);
        }
        const chatLogsData = await chatLogsResponse.json();
        updateChatLogFeed(chatLogsData);
        const chatErrorMsg = chatLogFeedList?.querySelector('.error-feed-message');
        if(chatErrorMsg) {
            chatErrorMsg.remove();
             filterChatLogs();
        }
    } catch(error) {
        console.error("Error fetching chat data:", error);
        if (chatLogFeedList) {
            let errorMsgElement = chatLogFeedList.querySelector('.error-feed-message');
            if (!errorMsgElement) {
                 const li = document.createElement('li'); li.className = 'error-feed-message';
                 chatLogFeedList.prepend(li); errorMsgElement = li;
            }
             errorMsgElement.textContent = `Chat Update Failed: ${escapeHtml(error.message)}`;
             errorMsgElement.style.display = 'flex';
             const emptyMsg = chatLogFeedList.querySelector('.empty-feed-message'); if (emptyMsg) emptyMsg.style.display = 'none';
             const noResults = chatLogFeedList.querySelector('.no-results-message'); if (noResults) noResults.style.display = 'none';
        }
    }
}

async function updateFlingOnly() {
    if (globalErrorState) {
        return;
    }
    try {
        const flingsResponse = await fetch('/flings');
        if (!flingsResponse.ok) {
             throw new Error(`Flings fetch failed: ${flingsResponse.status} ${flingsResponse.statusText}`);
        }
        const flingsData = await flingsResponse.json();
        updateFlingFeed(flingsData);

        const flingErrorMsg = flingFeedList?.querySelector('.error-feed-message');
        if (flingErrorMsg) {
            flingErrorMsg.remove();
             if (flingFeedList.children.length === 0) {
                flingFeedList.innerHTML = '<li class="empty-feed-message">No recent fling reports.</li>';
            }
        }
    } catch (error) {
        console.error("Error fetching fling data:", error);
        if (flingFeedList) {
            let errorMsgElement = flingFeedList.querySelector('.error-feed-message');
            if (!errorMsgElement) {
                 const li = document.createElement('li'); li.className = 'error-feed-message';
                 flingFeedList.prepend(li); errorMsgElement = li;
            }
            errorMsgElement.textContent = `Fling Update Failed: ${escapeHtml(error.message)}`;
            errorMsgElement.style.display = 'flex';
             const emptyMsg = flingFeedList.querySelector('.empty-feed-message'); if (emptyMsg) emptyMsg.style.display = 'none';
        }
    }
}

function processCoreDataUpdate(stats, reservations) {
    applyUpdateEffect(botCountEl, stats?.botCount);
    applyUpdateEffect(serverCountEl, stats?.serverCount);
    applyUpdateEffect(totalFlingsEl, stats?.totalFlings);
    applyUpdateEffect(flingRateEl, typeof stats?.flingRatePerMinute === 'number' ? stats.flingRatePerMinute.toFixed(1) : '?');

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
            reservationsContainerEl.classList.toggle('empty', !previousReservationsData || (Array.isArray(previousReservationsData) && previousReservationsData.length === 0));
            if (reservationsContainerEl.classList.contains('empty')) {
                reservationsContainerEl.textContent = 'No active reservations.';
            }
        }
    }
}

function applyUpdateEffect(element, newValue) {
    if (!element) return;
    const parentStatItem = element.closest('.stat-item');
    const isLoading = element.classList.contains('loading');
    const currentValue = isLoading ? null : element.textContent;
    const newValueStr = (newValue === null || newValue === undefined) ? '?' : String(newValue);

    if (isLoading) {
        element.classList.remove('loading');
        if (parentStatItem && parentStatItem.classList.contains('error') && newValueStr !== 'Error') {
             parentStatItem.classList.remove('error');
        }
    }

    if (newValueStr === 'Error' || newValueStr === '?') {
        element.textContent = newValueStr;
        element.classList.remove('updated');
        if (parentStatItem) parentStatItem.classList.add('error');
        return;
    } else {
         if (parentStatItem) parentStatItem.classList.remove('error');
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
                    let entriesHtml = '';
                    sortedData.forEach(item => {
                        const itemString = JSON.stringify(item, null, 2);
                        let highlightedCode = escapeHtml(itemString);
                        if (typeof hljs !== 'undefined' && hljs.highlight) {
                            try {
                                highlightedCode = hljs.highlight(itemString, { language: 'json' }).value;
                            } catch (highlightError) {
                                console.error('Highlight.js error:', highlightError);
                                highlightedCode = escapeHtml(itemString);
                            }
                        }
                        entriesHtml += `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                    });
                    finalHtml = entriesHtml;
                    reservationsContainerEl.classList.remove('loading', 'error');
                }
             } else if (typeof sortedData === 'object' && Object.keys(sortedData).length > 0) {
                 isEmpty = false;
                 const itemString = JSON.stringify(sortedData, null, 2);
                 let highlightedCode = escapeHtml(itemString);
                 if (typeof hljs !== 'undefined' && hljs.highlight) { try { highlightedCode = hljs.highlight(itemString, { language: 'json' }).value; } catch(e){ console.error('Highlight.js error:', e); highlightedCode = escapeHtml(itemString);}}
                 finalHtml = `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                 reservationsContainerEl.classList.remove('loading', 'error');
             } else if (typeof sortedData === 'object' && Object.keys(sortedData).length === 0) {
                 finalHtml = 'No active reservations. (Empty object)';
                 isEmpty = true;
                 reservationsContainerEl.classList.remove('loading', 'error');
            } else {
                finalHtml = `Received unexpected data format: ${typeof sortedData}`;
                isEmpty = true;
                reservationsContainerEl.classList.add('error');
                reservationsContainerEl.classList.remove('loading', 'empty');
            }

            reservationsContainerEl.innerHTML = finalHtml;

            if (isEmpty && !reservationsContainerEl.classList.contains('loading') && !reservationsContainerEl.classList.contains('error')) {
                 reservationsContainerEl.classList.add('empty');
            } else {
                 reservationsContainerEl.classList.remove('empty');
            }
            if (!isEmpty || reservationsContainerEl.classList.contains('error')) {
                reservationsContainerEl.classList.remove('loading');
            }

        } catch (e) {
            console.error("Error rendering JSON view:", e);
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
        if (flingFeedList) {
            flingFeedList.innerHTML = '<li class="error-feed-message">Error loading fling data.</li>';
        }
        return;
    }

    let newEventsAdded = false;
    let highestTimestampInBatch = latestDisplayedFlingTimestamp;
    const fragment = document.createDocumentFragment();

    for (let i = flingsData.length - 1; i >= 0; i--) {
        const fling = flingsData[i];
        if (typeof fling?.timestamp !== 'number' || typeof fling?.botName !== 'string') {
            console.warn("Skipping invalid fling data item:", fling);
            continue;
        }
        if (fling.timestamp > latestDisplayedFlingTimestamp) {
            const li = createFlingElement(fling);
            fragment.prepend(li);
            newEventsAdded = true;
            if (fling.timestamp > highestTimestampInBatch) {
                highestTimestampInBatch = fling.timestamp;
            }
        } else {
        }
    }

     if (highestTimestampInBatch > latestDisplayedFlingTimestamp) {
         latestDisplayedFlingTimestamp = highestTimestampInBatch;
     }

    if (newEventsAdded) {
        flingFeedList.prepend(fragment);
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

function createFlingElement(flingData) {
    const li = document.createElement('li');
    const eventTime = new Date(flingData.timestamp * 1000);
    const timeString = eventTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const botName = escapeHtml(flingData.botName || 'Unknown Bot');
    const targetName = escapeHtml(flingData.target || 'Unknown Target');
    const serverId = escapeHtml(flingData.serverId || 'Unknown');

    li.innerHTML = `
        <span class="fling-details">
            <span class="fling-bot">${botName}</span> flung
            <span class="fling-target">${targetName}</span>
            ${serverId !== 'Unknown' ? `<span class="fling-server">(Server: ${serverId})</span>` : ''}
        </span>
        <span class="fling-time">${timeString}</span>
    `;
    return li;
}


function updateChatLogFeed(chatLogsData) {
    if (!chatLogFeedList || !Array.isArray(chatLogsData)) {
        if (chatLogFeedList) {
            chatLogFeedList.innerHTML = `
                <li class="error-feed-message">Error loading chat data.</li>
                <li class="no-results-message" style="display: none;"></li>
            `;
        }
        return;
    }

    let newMessagesAdded = false;
    let highestTimestampInBatch = latestDisplayedChatTimestamp;
    const fragment = document.createDocumentFragment();

    for (let i = chatLogsData.length - 1; i >= 0; i--) {
        const log = chatLogsData[i];
        if (typeof log?.received_at !== 'number') {
             console.warn("Skipping invalid chat log item:", log);
             continue;
        }

        if (log.received_at > latestDisplayedChatTimestamp) {
            const li = createChatElement(log);
            li.style.display = filterMatches(log) ? '' : 'none';
            fragment.prepend(li);
            newMessagesAdded = true;
            if (log.received_at > highestTimestampInBatch) {
                highestTimestampInBatch = log.received_at;
            }
        } else {
        }
    }

    if (highestTimestampInBatch > latestDisplayedChatTimestamp) {
        latestDisplayedChatTimestamp = highestTimestampInBatch;
    }

    if (newMessagesAdded) {
        chatLogFeedList.prepend(fragment);
        const errorMessages = chatLogFeedList.querySelectorAll('.error-feed-message, .empty-feed-message');
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

    updateFilterVisibilityStates();
}

function createChatElement(logData) {
    const li = document.createElement('li');
    li.classList.add('chat-entry');

    const receivedTime = new Date(logData.received_at * 1000);
    const timeString = receivedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const botName = escapeHtml(logData.botName || 'Unknown Bot');
    const playerName = escapeHtml(logData.playerName || 'Unknown Player');
    const message = escapeHtml(logData.message || '');
    const serverId = escapeHtml(logData.serverId || 'Unknown');

    li.innerHTML = `
        <div class="chat-meta">
            <div>
                <span class="chat-player" data-player="${playerName.toLowerCase()}">${playerName}:</span>
                ${serverId !== 'Unknown' ? `<span class="chat-server">(Server: ${serverId})</span>` : ''}
                 <!-- (<span class="chat-bot">${botName}</span>) -->
            </div>
            <span class="chat-timestamp">${timeString}</span>
        </div>
        <div class="chat-message" data-message="${message.toLowerCase()}">${message}</div>
    `;
    li.dataset.combinedText = `${playerName.toLowerCase()} ${message.toLowerCase()}`;

    return li;
}

function filterMatches(logData) {
    if (currentChatFilter === '') return true;
    const playerNameLower = (logData.playerName || '').toLowerCase();
    const messageLower = (logData.message || '').toLowerCase();
    const combinedText = playerNameLower + ' ' + messageLower;
    return combinedText.includes(currentChatFilter);
}


function filterChatLogs() {
    if (!chatLogFeedList || !chatSearchInput) return;

    currentChatFilter = chatSearchInput.value.toLowerCase().trim();
    const allMessages = chatLogFeedList.querySelectorAll('li.chat-entry');

    allMessages.forEach(li => {
        const combinedText = li.dataset.combinedText || `${(li.querySelector('.chat-player')?.textContent || '').toLowerCase()} ${(li.querySelector('.chat-message')?.textContent || '').toLowerCase()}`;
        const isMatch = currentChatFilter === '' || combinedText.includes(currentChatFilter);
        li.style.display = isMatch ? '' : 'none';
    });

    updateFilterVisibilityStates();
}

function updateFilterVisibilityStates() {
     if (!chatLogFeedList) return;
     const allMessages = chatLogFeedList.querySelectorAll('li.chat-entry');
     const visibleMessages = chatLogFeedList.querySelectorAll('li.chat-entry:not([style*="display: none"])');

     const hasAnyMessages = allMessages.length > 0;
     const visibleCount = visibleMessages.length;

     const emptyMessage = chatLogFeedList.querySelector('.empty-feed-message');
     const noResults = chatLogFeedList.querySelector('.no-results-message');
     const errorMsg = chatLogFeedList.querySelector('.error-feed-message');

     if (emptyMessage) emptyMessage.style.display = 'none';
     if (noResults) noResults.style.display = 'none';
     if (errorMsg && errorMsg.style.display !== 'flex') {
     } else {
        if (!hasAnyMessages && currentChatFilter === '') {
            if (emptyMessage) emptyMessage.style.display = 'flex';
        } else if (hasAnyMessages && visibleCount === 0 && currentChatFilter !== '') {
            if (noResults) noResults.style.display = 'flex';
        }
     }
}


async function performInitialLoad() {
    setInitialLoadingStateVisuals();
    initializeCharts();
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

        processCoreDataUpdate(statsData, reservationsData);
        updateFlingFeed(flingsData);
        updateChatLogFeed(chatLogsData);
        updateCharts(statsData);

        setErrorState(null);
        globalErrorState = false;
        initialLoadComplete = true;
        console.log("Initial load successful.");

    } catch (error) {
        console.error("Initial data load failed:", error);
        setErrorState(error.message || "Initial data load failed");
        globalErrorState = true;
        initialLoadComplete = true;
    } finally {
        setInterval(updateCoreData, UPDATE_INTERVAL);
        setInterval(updateChatOnly, CHAT_UPDATE_INTERVAL);
        setInterval(updateFlingOnly, FLING_UPDATE_INTERVAL);
    }
}

function setInitialLoadingStateVisuals() {
    Object.values(statItems).forEach(itemContainer => {
        const valueEl = itemContainer?.querySelector('.value span');
        if (valueEl) {
            valueEl.textContent = 'Loading...';
            valueEl.classList.add('loading');
        }
        if (itemContainer) itemContainer.classList.remove('error');
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
            <li class="empty-feed-message" style="display: flex;">Loading chat messages...</li>
            <li class="no-results-message" style="display: none;">No messages match your filter.</li>
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

    if (flingHistoryChart) {
        flingHistoryChart.data.labels = [];
        flingHistoryChart.data.datasets.forEach(dataset => { dataset.data = []; });
        flingHistoryChart.update('none');
    }
     if (regionChart) {
        regionChart.data.labels = [];
        regionChart.data.datasets[0].data = [];
        regionChart.update('none');
    }
}

function setErrorState(errorMessage) {
    const isError = errorMessage !== null;
    globalErrorState = isError;

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
            regionListEl.classList.remove('loading'); regionListEl.classList.add('error');
            regionListEl.innerHTML = `<li>Error: ${escapeHtml(errorMessage)}</li>`;
        }
        if (reservationsContainerEl) {
            reservationsContainerEl.classList.remove('loading', 'empty'); reservationsContainerEl.classList.add('error');
            reservationsContainerEl.innerHTML = `Failed to load data: ${escapeHtml(errorMessage)}`;
        }
         if (flingFeedList) {
            flingFeedList.innerHTML = `<li class="error-feed-message">Feed Error: ${escapeHtml(errorMessage)}</li>`;
        }
         if (chatLogFeedList) {
            chatLogFeedList.innerHTML = `<li class="error-feed-message">Feed Error: ${escapeHtml(errorMessage)}</li> <li class="no-results-message" style="display: none;"></li>`;
        }

        if (lastUpdatedEl) lastUpdatedEl.textContent = 'Update Failed';
        if (liveIndicator) liveIndicator.classList.remove('pulsing');
        if (topLiveIndicator) topLiveIndicator.classList.remove('pulsing');

    } else {
        if (lastUpdatedEl && (lastUpdatedEl.textContent === 'Update Failed' || lastUpdatedEl.textContent === 'Never')) {
            lastUpdatedEl.textContent = 'Updating...';
        }
        if (liveIndicator && !liveIndicator.classList.contains('pulsing')) liveIndicator.classList.add('pulsing');
        if (topLiveIndicator && !topLiveIndicator.classList.contains('pulsing')) topLiveIndicator.classList.add('pulsing');

        const flingError = flingFeedList?.querySelector('.error-feed-message');
        if (flingError && flingError.textContent.startsWith('Feed Error:')) flingError.remove();
        if (flingFeedList && flingFeedList.children.length === 0) flingFeedList.innerHTML = '<li class="empty-feed-message">Waiting for fling reports...</li>';

        const chatError = chatLogFeedList?.querySelector('.error-feed-message');
        if (chatError && chatError.textContent.startsWith('Feed Error:')) chatError.remove();
        updateFilterVisibilityStates();

        const regionError = regionListEl?.querySelector('li');
        if (regionListEl && regionError && regionListEl.classList.contains('error')) {
            regionListEl.innerHTML = '<li>Reloading regional data...</li>'; regionListEl.classList.add('loading'); regionListEl.classList.remove('error');
        }
        if(reservationsContainerEl && reservationsContainerEl.classList.contains('error')){
            reservationsContainerEl.classList.remove('error'); reservationsContainerEl.classList.add('loading');
            reservationsContainerEl.innerHTML = 'Reloading reservation data...';
        }
    }
}

copyJsonBtn?.addEventListener('click', () => {
    if (previousReservationsData === null || previousReservationsData === undefined) {
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
            console.error("Failed to copy JSON:", err);
            copyJsonBtn.innerHTML = '<i class="fas fa-times"></i> Failed';
            copyJsonBtn.disabled = true;
            setTimeout(() => {
                copyJsonBtn.innerHTML = '<i class="far fa-copy"></i> Copy';
                copyJsonBtn.disabled = false;
            }, 1500);
        });
    } catch (e) {
        console.error("Error preparing JSON for copy:", e);
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
        }
    });
});

themeSelectorEl?.addEventListener('change', () => {
    const selectedTheme = themeSelectorEl.value;
    applyTheme(selectedTheme);
    try {
        localStorage.setItem(LOCALSTORAGE_THEME_KEY, selectedTheme);
    } catch(e) { console.warn("Could not save theme preference to localStorage."); }

    setTimeout(() => {
        if (previousReservationsData !== null && reservationsContainerEl && !reservationsContainerEl.classList.contains('loading') && !reservationsContainerEl.classList.contains('empty')) {
             scheduleJsonUpdate(previousReservationsData);
        }
    }, 150);
});

function applyTheme(themeValue) {
    if (!themeLinkEl || !themeValue) return;
    const newThemeUrl = `${HLJS_CDN_BASE}${themeValue}.min.css`;
    const currentHref = themeLinkEl.getAttribute('href');
    if (currentHref !== newThemeUrl) {
        themeLinkEl.setAttribute('href', newThemeUrl);
    }
    if (themeSelectorEl && themeSelectorEl.value !== themeValue) {
        themeSelectorEl.value = themeValue;
    }
}

function loadThemePreference() {
    let savedTheme = null;
    try {
        savedTheme = localStorage.getItem(LOCALSTORAGE_THEME_KEY);
    } catch(e) { console.warn("Could not load theme preference from localStorage."); }
    const initialTheme = savedTheme || 'atom-one-dark';
    applyTheme(initialTheme);
}

function findPresetByColors(color1, color2) {
     return PREDEFINED_GRADIENTS.find(g => g.color1 === color1 && g.color2 === color2);
}

function applyGradient(color1, color2) {
    const gradientValue = `linear-gradient(90deg, ${color1} 0%, ${color2} 100%)`;
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
    } catch (e) { console.warn("Could not load gradient preference from localStorage."); }
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
    } catch (e) { console.warn("Could not save gradient preference to localStorage."); }
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
            } catch (e) { console.warn("Could not save gradient preference to localStorage."); }
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
}

document.addEventListener('DOMContentLoaded', () => {
    setupGradientSelector();
    loadThemePreference();
    loadGradientPreference();
    initializeCharts();
    performInitialLoad();
    filterChatLogs();
});