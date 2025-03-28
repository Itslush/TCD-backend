// --- DOM Element Selectors ---
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
const statItems = { // Containers for error class toggling
    bots: document.getElementById('stat-bots'),
    servers: document.getElementById('stat-servers'),
    flings: document.getElementById('stat-flings'),
    flingRate: document.getElementById('stat-fling-rate')
};
const regionContainer = document.getElementById('region-stats-container');
const sortButtons = document.querySelectorAll('.sort-btn');
const themeSelectorEl = document.getElementById('theme-selector');
const themeLinkEl = document.getElementById('hljs-theme-link');

// --- Constants and State Variables ---
const UPDATE_INTERVAL = 1500; // ms
const HLJS_CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/";
const LOCALSTORAGE_THEME_KEY = 'tcdDashboardTheme';

let currentSortKey = 'timestamp'; // Default sort order
let initialLoadComplete = false;
let previousReservationsData = null; // Stores last valid UNSORTED reservation data
let updateScheduled = false; // Flag for requestAnimationFrame

// --- Core Data Fetching and Processing ---

async function updateData() {
    try {
        // Fetch stats and reservations concurrently
        const [statsResponse, reservationsResponse] = await Promise.all([
            fetch('/'),
            fetch('/reservations')
        ]);

        // Check if fetch responses are ok
        if (!statsResponse.ok) throw new Error(`Stats fetch failed: ${statsResponse.status} ${statsResponse.statusText}`);
        if (!reservationsResponse.ok) throw new Error(`Reservations fetch failed: ${reservationsResponse.status} ${reservationsResponse.statusText}`);

        // Parse JSON responses
        const statsData = await statsResponse.json();
        const reservationsData = await reservationsResponse.json();

        // Process and display the valid data
        processUpdate(statsData, reservationsData);

        // Clear any previous error state AFTER successful processing
        setErrorState(null);
        initialLoadComplete = true;

    } catch (error) {
        // Handle errors during fetch or JSON parsing
        console.error("Error fetching or processing data:", error);
        setErrorState(error.message || "Unknown error");
        initialLoadComplete = true; // Mark load as complete even on error to prevent infinite loading state
    }
}

function processUpdate(stats, reservations) {
    // Update main stat cards
    applyUpdateEffect(botCountEl, stats?.botCount);
    applyUpdateEffect(serverCountEl, stats?.serverCount);
    applyUpdateEffect(totalFlingsEl, stats?.totalFlings);
    const rate = stats?.flingRatePerMinute;
    applyUpdateEffect(flingRateEl, typeof rate === 'number' ? rate.toFixed(1) : '?');

    // Update footer timestamp and live indicator
    if (lastUpdatedEl) lastUpdatedEl.textContent = new Date().toLocaleTimeString();
    if (liveIndicator && !liveIndicator.classList.contains('pulsing')) {
        liveIndicator.classList.add('pulsing');
    }

    // Update regional distribution list
    updateRegionDistribution(stats?.botsPerRegion);

    // Compare fetched reservations with previous data to see if update is needed
    const currentDataString = JSON.stringify(reservations);
    const previousDataString = JSON.stringify(previousReservationsData);

    // Update JSON view if data changed or it's the first successful load
    if (currentDataString !== previousDataString || !initialLoadComplete) {
        previousReservationsData = reservations; // Store the new UNSORTED data
        scheduleJsonUpdate(reservations); // Schedule render (will sort inside)
    } else {
        // If data is the same, just ensure loading/empty states are correct
        // (e.g., if previous state was loading/error)
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
}

// --- UI Update Functions ---

function updateRegionDistribution(regionData) {
    if (!regionListEl) return;

    // Clear previous state
    regionListEl.classList.remove('loading', 'error');
    regionListEl.innerHTML = '';
    if (regionContainer) regionContainer.classList.remove('error'); // Clear container error

    // Validate data
    if (!regionData || typeof regionData !== 'object') {
        regionListEl.classList.add('error'); // Add error class to list itself
        regionListEl.innerHTML = '<li>Error loading regional data</li>';
        if (regionContainer) regionContainer.classList.add('error'); // Add error class to container
        return;
    }

    // Get and sort regions
    const regions = Object.keys(regionData).sort();

    // Display message if no regions
    if (regions.length === 0) {
        regionListEl.innerHTML = '<li>No bots active in any specific region.</li>';
        return;
    }

    // Populate list
    regions.forEach(region => {
        const count = regionData[region];
        const li = document.createElement('li');
        li.innerHTML = `<strong>${region}:</strong> ${count} ${count === 1 ? 'bot' : 'bots'}`;
        regionListEl.appendChild(li);
    });
}

function scheduleJsonUpdate(reservationsData) {
    // Prevents multiple updates queuing up
    if (updateScheduled || !reservationsContainerEl) return;
    updateScheduled = true;

    // Sort the data before rendering
    let sortedData = [];
    if (Array.isArray(reservationsData)) {
        sortedData = [...reservationsData]; // Create a copy
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
            sortedData.sort(sortFunctions.timestamp); // Fallback
        }
    } else {
        console.warn("Reservations data is not an array:", reservationsData);
        sortedData = reservationsData; // Attempt to render what was given
    }

    // Use requestAnimationFrame for smoother DOM updates
    requestAnimationFrame(() => {
        try {
            let finalHtml = '';
            let isEmpty = true;

            // Generate HTML based on sortedData
            if (sortedData === null || sortedData === undefined) {
                finalHtml = 'No reservation data received.';
                reservationsContainerEl.classList.add('loading');
                reservationsContainerEl.classList.remove('empty');
            } else if (Array.isArray(sortedData)) {
                if (sortedData.length === 0) {
                    finalHtml = 'No active reservations.';
                    isEmpty = true;
                    reservationsContainerEl.classList.remove('loading');
                } else {
                    isEmpty = false;
                    sortedData.forEach(item => {
                        const itemString = JSON.stringify(item, null, 2);
                        let highlightedCode = itemString;
                        // Apply syntax highlighting if hljs is available
                        if (typeof hljs !== 'undefined' && hljs.highlight) {
                            try {
                                highlightedCode = hljs.highlight(itemString, { language: 'json' }).value;
                            } catch (highlightError) {
                                console.error("Highlighting error for item:", item, highlightError);
                                highlightedCode = itemString.replace(/</g, "<").replace(/>/g, ">"); // Basic escaping
                            }
                        } else {
                             highlightedCode = itemString.replace(/</g, "<").replace(/>/g, ">"); // Basic escaping
                        }
                        finalHtml += `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                    });
                    reservationsContainerEl.classList.remove('loading');
                }
            } else if (typeof sortedData === 'object' && Object.keys(sortedData).length > 0) {
                // Handle potential single object return
                console.warn("Rendering single object for reservations:", sortedData);
                isEmpty = false;
                const itemString = JSON.stringify(sortedData, null, 2);
                let highlightedCode = itemString;
                 if (typeof hljs !== 'undefined' && hljs.highlight) { /* ... highlight ... */ }
                finalHtml = `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                reservationsContainerEl.classList.remove('loading');
            } else if (typeof sortedData === 'object' && Object.keys(sortedData).length === 0) {
                 finalHtml = 'No active reservations. (Empty object)';
                 isEmpty = true;
                 reservationsContainerEl.classList.remove('loading');
            } else {
                // Handle unexpected formats
                finalHtml = `Received unexpected data format.`;
                isEmpty = true;
                reservationsContainerEl.classList.add('loading');
                console.error("Unexpected data format received:", sortedData);
            }

            // Update the container's HTML
            reservationsContainerEl.innerHTML = finalHtml;

            if (isEmpty && !reservationsContainerEl.classList.contains('loading')) {
                 reservationsContainerEl.classList.add('empty');
            } else {
                 reservationsContainerEl.classList.remove('empty');
            }
        } catch (e) {
            console.error("Error during DOM update in scheduleJsonUpdate:", e);
            if (reservationsContainerEl) {
                 reservationsContainerEl.innerHTML = `Error displaying JSON view: ${e.message}`;
                 reservationsContainerEl.classList.add('loading');
                 reservationsContainerEl.classList.remove('empty');
            }
        } finally {
            updateScheduled = false;
        }
    });
}

function applyUpdateEffect(element, newValue) {
    if (!element) return;
    const isLoading = element.classList.contains('loading');
    const currentValue = isLoading ? null : element.textContent;
    const newValueStr = (newValue === null || newValue === undefined) ? '?' : String(newValue);

    if (isLoading) {
        element.classList.remove('loading');
    }

    if (newValueStr === 'Error') {
        element.textContent = 'Error';
        return;
    }
     if (newValueStr === '?') {
         element.textContent = '?';
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

function setInitialLoadingState() {
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
        reservationsContainerEl.classList.remove('empty');
        reservationsContainerEl.textContent = 'Loading reservation data...';
    }
    if (regionListEl) {
         regionListEl.classList.add('loading');
         regionListEl.classList.remove('error');
         if (regionContainer) regionContainer.classList.remove('error');
         regionListEl.innerHTML = '<li>Loading regional data...</li>';
    }
    if (liveIndicator) liveIndicator.classList.remove('pulsing');
    if (lastUpdatedEl) lastUpdatedEl.textContent = 'Never';
}

function setErrorState(errorMessage) {
    const isError = errorMessage !== null;

    Object.values(statItems).forEach(itemContainer => {
        if (itemContainer) itemContainer.classList.toggle('error', isError);
    });
    if (regionContainer) regionContainer.classList.toggle('error', isError);

    // const jsonViewContainer = document.querySelector('.json-view');
    // if(jsonViewContainer) jsonViewContainer.classList.toggle('error', isError);

    if (isError) {
        applyUpdateEffect(botCountEl, 'Error');
        applyUpdateEffect(serverCountEl, 'Error');
        applyUpdateEffect(totalFlingsEl, 'Error');
        applyUpdateEffect(flingRateEl, 'Error');

        if (regionListEl) {
            regionListEl.classList.remove('loading');
            regionListEl.innerHTML = `<li>Error: ${errorMessage}</li>`;
        }

        if (reservationsContainerEl) {
            reservationsContainerEl.classList.add('loading');
            reservationsContainerEl.classList.remove('empty');
            reservationsContainerEl.textContent = `Failed to load data: ${errorMessage}`;
        }

        if (lastUpdatedEl) lastUpdatedEl.textContent = 'Update Failed';
        if (liveIndicator) liveIndicator.classList.remove('pulsing');

    } else {
        if (lastUpdatedEl) {
            if (lastUpdatedEl.textContent === 'Update Failed' || lastUpdatedEl.textContent === 'Never') {
                lastUpdatedEl.textContent = 'Updating...';
            }
        }
        if (liveIndicator && !liveIndicator.classList.contains('pulsing')) {
             liveIndicator.classList.add('pulsing');
        }
    }
}

function applyTheme(themeValue) {
    if (!themeLinkEl || !themeValue) return;
    const newThemeUrl = `${HLJS_CDN_BASE}${themeValue}.min.css`;
    const currentHref = themeLinkEl.getAttribute('href');

    if (currentHref !== newThemeUrl) {
        console.log("Applying theme:", themeValue);
        themeLinkEl.setAttribute('href', newThemeUrl);

        setTimeout(() => {
            if (typeof hljs !== 'undefined' && hljs.highlightElement && reservationsContainerEl &&
                !reservationsContainerEl.classList.contains('loading') &&
                !reservationsContainerEl.classList.contains('empty'))
            {
                const codeBlocks = reservationsContainerEl.querySelectorAll('code.language-json');
                if (codeBlocks.length > 0) {
                    console.log(`Re-highlighting ${codeBlocks.length} code blocks for theme: ${themeValue}`);
                    codeBlocks.forEach(block => {
                        try {
                            hljs.highlightElement(block);
                        } catch(e) {
                            console.error("Error re-highlighting block:", e, block);
                        }
                    });
                }
            }
        }, 100);
    }

    if (themeSelectorEl.value !== themeValue) {
        themeSelectorEl.value = themeValue;
    }
}

function loadThemePreference() {
    const savedTheme = localStorage.getItem(LOCALSTORAGE_THEME_KEY);
    const initialTheme = savedTheme || 'atom-one-dark';
    applyTheme(initialTheme);
}

toggleJsonBtn.addEventListener('click', () => {
    if (jsonPreContainer) {
        const isHidden = jsonPreContainer.classList.toggle('hidden');
        toggleJsonBtn.textContent = isHidden ? 'Show' : 'Hide';
        toggleJsonBtn.setAttribute('aria-expanded', String(!isHidden));
    }
});

copyJsonBtn.addEventListener('click', () => {
    if (previousReservationsData === null || previousReservationsData === undefined) {
        console.warn("No valid data to copy.");
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
                timestamp: (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
                players: (a, b) => (b.currentPlayerCount ?? -1) - (a.currentPlayerCount ?? -1),
                region: (a, b) => (a.region || '').localeCompare(b.region || ''),
                id: (a, b) => (a.serverId || '').localeCompare(b.serverId || '')
             };
             if (sortFunctions[currentSortKey]) {
                 dataToCopy.sort(sortFunctions[currentSortKey]);
             } else {
                 dataToCopy.sort(sortFunctions.timestamp);
             }
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

sortButtons.forEach(button => {
    button.addEventListener('click', () => {
        const newSortKey = button.id.replace('sort-', '');
        if (newSortKey === currentSortKey) return;

        currentSortKey = newSortKey;

        sortButtons.forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        if (previousReservationsData !== null) {
            scheduleJsonUpdate(previousReservationsData);
        } else {
            console.log("Sort changed to:", currentSortKey, "but no data to re-render yet.");
        }
    });
});

themeSelectorEl.addEventListener('change', () => {
    const selectedTheme = themeSelectorEl.value;
    applyTheme(selectedTheme);
    localStorage.setItem(LOCALSTORAGE_THEME_KEY, selectedTheme);
});

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded. Initializing.");
    loadThemePreference();
    setInitialLoadingState();
    updateData();
    setInterval(updateData, UPDATE_INTERVAL);
});