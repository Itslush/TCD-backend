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
const topLiveIndicator = document.querySelector('.top-live-indicator'); // Added top indicator
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
const gradientSelectorContainerEl = document.getElementById('gradient-selector-container'); // Preset container


const UPDATE_INTERVAL = 1500;
const HLJS_CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/";
const LOCALSTORAGE_THEME_KEY = 'tcdDashboardTheme';
const LOCALSTORAGE_GRADIENT_COLOR_1 = 'tcdGradientColor1';
const LOCALSTORAGE_GRADIENT_COLOR_2 = 'tcdGradientColor2';
const DEFAULT_GRADIENT_COLOR_1 = '#ee44b6';
const DEFAULT_GRADIENT_COLOR_2 = '#ed9344';

// Re-added preset definitions
const PREDEFINED_GRADIENTS = [
    { id: 'brand', color1: '#ee44b6', color2: '#ed9344', name: 'Brand Default' },
    { id: 'ocean', color1: '#1CB5E0', color2: '#000046', name: 'Ocean Blue' },
    { id: 'sunset', color1: '#FF512F', color2: '#DD2476', name: 'Sunset Red' },
    { id: 'forest', color1: '#138808', color2: '#2B5F2B', name: 'Forest Green' },
    { id: 'purple', color1: '#DA22FF', color2: '#9733EE', name: 'Deep Purple' }
];


let currentSortKey = 'timestamp';
let initialLoadComplete = false;
let previousReservationsData = null;
let updateScheduled = false;

async function updateData() {
    try {
        const [statsResponse, reservationsResponse] = await Promise.all([
            fetch('/'),
            fetch('/reservations')
        ]);

        if (!statsResponse.ok) throw new Error(`Stats fetch failed: ${statsResponse.status} ${statsResponse.statusText}`);
        if (!reservationsResponse.ok) throw new Error(`Reservations fetch failed: ${reservationsResponse.status} ${reservationsResponse.statusText}`);

        const statsData = await statsResponse.json();
        const reservationsData = await reservationsResponse.json();

        processUpdate(statsData, reservationsData);

        setErrorState(null);
        initialLoadComplete = true;

    } catch (error) {
        console.error("Error fetching or processing data:", error);
        setErrorState(error.message || "Unknown error");
        initialLoadComplete = true;
    }
}

function processUpdate(stats, reservations) {
    applyUpdateEffect(botCountEl, stats?.botCount);
    applyUpdateEffect(serverCountEl, stats?.serverCount);
    applyUpdateEffect(totalFlingsEl, stats?.totalFlings);
    const rate = stats?.flingRatePerMinute;
    applyUpdateEffect(flingRateEl, typeof rate === 'number' ? rate.toFixed(1) : '?');

    if (lastUpdatedEl) lastUpdatedEl.textContent = new Date().toLocaleTimeString();
    if (liveIndicator && !liveIndicator.classList.contains('pulsing')) {
        liveIndicator.classList.add('pulsing');
    }
    // Update top live indicator
    if (topLiveIndicator && !topLiveIndicator.classList.contains('pulsing')) {
        topLiveIndicator.classList.add('pulsing');
    }

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
        li.innerHTML = `<strong>${region}:</strong> ${count} ${count === 1 ? 'bot' : 'bots'}`;
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
                        if (typeof hljs !== 'undefined' && hljs.highlight) {
                            try {
                                highlightedCode = hljs.highlight(itemString, { language: 'json' }).value;
                            } catch (highlightError) {
                                console.error("Highlighting error for item:", item, highlightError);
                                highlightedCode = itemString.replace(/</g, "<").replace(/>/g, ">");
                            }
                        } else {
                             highlightedCode = itemString.replace(/</g, "<").replace(/>/g, ">");
                        }
                        finalHtml += `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                    });
                    reservationsContainerEl.classList.remove('loading');
                }
            } else if (typeof sortedData === 'object' && Object.keys(sortedData).length > 0) {
                console.warn("Rendering single object for reservations:", sortedData);
                isEmpty = false;
                const itemString = JSON.stringify(sortedData, null, 2);
                let highlightedCode = itemString;
                 if (typeof hljs !== 'undefined' && hljs.highlight) {
                    try { highlightedCode = hljs.highlight(itemString, { language: 'json' }).value; } catch(e) {}
                 }
                finalHtml = `<div class="json-entry"><code class="language-json">${highlightedCode}</code></div>`;
                reservationsContainerEl.classList.remove('loading');
            } else if (typeof sortedData === 'object' && Object.keys(sortedData).length === 0) {
                 finalHtml = 'No active reservations. (Empty object)';
                 isEmpty = true;
                 reservationsContainerEl.classList.remove('loading');
            } else {
                finalHtml = `Received unexpected data format.`;
                isEmpty = true;
                reservationsContainerEl.classList.add('loading');
                console.error("Unexpected data format received:", sortedData);
            }

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
    if (topLiveIndicator) topLiveIndicator.classList.remove('pulsing'); // Stop top pulse
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
            regionListEl.innerHTML = `<li>Error: ${errorMessage}</li>`;
        }

        if (reservationsContainerEl) {
            reservationsContainerEl.classList.add('loading');
            reservationsContainerEl.classList.remove('empty');
            reservationsContainerEl.textContent = `Failed to load data: ${errorMessage}`;
        }

        if (lastUpdatedEl) lastUpdatedEl.textContent = 'Update Failed';
        if (liveIndicator) liveIndicator.classList.remove('pulsing');
        if (topLiveIndicator) topLiveIndicator.classList.remove('pulsing'); // Stop top pulse on error

    } else {
        if (lastUpdatedEl) {
            if (lastUpdatedEl.textContent === 'Update Failed' || lastUpdatedEl.textContent === 'Never') {
                lastUpdatedEl.textContent = 'Updating...';
            }
        }
        if (liveIndicator && !liveIndicator.classList.contains('pulsing')) {
             liveIndicator.classList.add('pulsing');
        }
        if (topLiveIndicator && !topLiveIndicator.classList.contains('pulsing')) {
             topLiveIndicator.classList.add('pulsing'); // Start top pulse on success
        }
    }
}

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

// Finds a PRESET gradient that matches the given colors
function findPresetByColors(color1, color2) {
     return PREDEFINED_GRADIENTS.find(g => g.color1 === color1 && g.color2 === color2);
}

// Updated applyGradient - applies colors and manages preset highlights
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

    // Check if the applied colors match a preset and highlight it
    const matchingPreset = findPresetByColors(color1, color2);
    const swatches = gradientSelectorContainerEl?.querySelectorAll('.gradient-swatch');
    swatches?.forEach(swatch => {
        const isActive = matchingPreset && swatch.dataset.gradientId === matchingPreset.id;
        swatch.classList.toggle('active', isActive);
        swatch.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
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

    applyGradient(initialColor1, initialColor2); // Applies colors and updates picker values & preset highlights
}


function handleGradientChange() {
    const color1 = gradientColorPicker1.value;
    const color2 = gradientColorPicker2.value;

    applyGradient(color1, color2); // This will now also deselect presets if colors don't match

    try {
       localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_1, color1);
       localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_2, color2);
    } catch (e) {
       console.warn("Could not save gradient colors to localStorage:", e.message);
    }
}

// Re-added setupGradientSelector for presets
function setupGradientSelector() {
    if (!gradientSelectorContainerEl) return;

    PREDEFINED_GRADIENTS.forEach(gradient => {
        const swatch = document.createElement('div');
        swatch.classList.add('gradient-swatch');
        swatch.dataset.gradientId = gradient.id;
        // Use the two colors to make the gradient background
        swatch.style.backgroundImage = `linear-gradient(90deg, ${gradient.color1} 0%, ${gradient.color2} 100%)`;
        swatch.title = gradient.name;
        swatch.setAttribute('role', 'button');
        swatch.setAttribute('aria-pressed', 'false');
        swatch.setAttribute('tabindex', '0');

        swatch.addEventListener('click', () => {
            // Apply the preset's colors
            applyGradient(gradient.color1, gradient.color2);
            // Save the chosen preset's colors
            try {
               localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_1, gradient.color1);
               localStorage.setItem(LOCALSTORAGE_GRADIENT_COLOR_2, gradient.color2);
            } catch (e) {
               console.warn("Could not save preset gradient to localStorage:", e.message);
            }
             // applyGradient already handles highlighting the correct swatch
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

// --- Event Listeners ---

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
    try {
        localStorage.setItem(LOCALSTORAGE_THEME_KEY, selectedTheme);
    } catch(e) { console.warn("Could not save theme to localStorage:", e.message); }


    setTimeout(() => {
        if (previousReservationsData !== null && reservationsContainerEl) {
            console.log("Forcing JSON re-render for new theme:", selectedTheme);

            reservationsContainerEl.innerHTML = '';
            reservationsContainerEl.classList.add('loading');
            reservationsContainerEl.classList.remove('empty');
            reservationsContainerEl.textContent = 'Applying theme...';

            scheduleJsonUpdate(previousReservationsData);
        } else {
             console.log("Theme changed, but no JSON data to re-render.");
        }
    }, 150);
});

if (gradientColorPicker1 && gradientColorPicker2) {
    gradientColorPicker1.addEventListener('input', handleGradientChange);
    gradientColorPicker2.addEventListener('input', handleGradientChange);
} else {
    console.error("Gradient color pickers not found!");
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded. Initializing.");
    setupGradientSelector(); // Setup preset swatches
    loadThemePreference();
    loadGradientPreference(); // Load custom/preset gradient colors
    setInitialLoadingState();
    updateData();
    setInterval(updateData, UPDATE_INTERVAL);
});