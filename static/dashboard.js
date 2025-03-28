// --- Element Selectors ---
// (Keep all existing selectors)
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
const chatLogFeedList = document.getElementById('chat-log-feed'); // Chat feed list
const chatLogSection = document.getElementById('chat-log-section'); // Chat feed section wrapper
const chatSearchInput = document.getElementById('chat-search'); // Selector for the search input
const noResultsMessage = chatLogFeedList?.querySelector('.no-results-message'); // Selector for no results message

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

// --- Constants ---
const UPDATE_INTERVAL = 2000; // Interval for Stats, Reservations, Flings (e.g., 2 seconds)
const CHAT_UPDATE_INTERVAL = 750; // << NEW: Faster interval for Chat Logs (e.g., 750ms)
const HLJS_CDN_BASE = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/";
const MAX_FEED_ITEMS = 50; // Max fling feed items
const MAX_CHAT_ITEMS = 100; // Max chat messages to display in the feed
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

// --- State Variables ---
// (Keep all existing state variables)
let currentSortKey = 'timestamp'; // For JSON view sorting
let initialLoadComplete = false;
let previousReservationsData = null; // Cache reservations to avoid unnecessary re-renders
let updateScheduled = false; // Flag for requestAnimationFrame optimization
let latestDisplayedFlingTimestamp = 0; // Track newest displayed fling
let latestDisplayedChatTimestamp = 0; // Track newest displayed chat (using server timestamp)
let currentChatFilter = ''; // Store the current chat filter term
let globalErrorState = false; // Flag to track if there's a general connection error

// --- Core Data Fetching and Processing ---

// **MODIFIED: updateData now fetches only non-chat data**
async function updateNonChatData() {
    // Only fetch stats, reservations, flings
    try {
        const [statsResponse, reservationsResponse, flingsResponse] = await Promise.all([
            fetch('/'),
            fetch('/reservations'),
            fetch('/flings')
        ]);

        // Check responses
        if (!statsResponse.ok) throw new Error(`Stats fetch failed: ${statsResponse.status} ${statsResponse.statusText}`);
        if (!reservationsResponse.ok) throw new Error(`Reservations fetch failed: ${reservationsResponse.status} ${reservationsResponse.statusText}`);
        if (!flingsResponse.ok) throw new Error(`Flings fetch failed: ${flingsResponse.status} ${flingsResponse.statusText}`);

        // Parse JSON data
        const statsData = await statsResponse.json();
        const reservationsData = await reservationsResponse.json();
        const flingsData = await flingsResponse.json();

        // Process **ONLY** non-chat data
        processNonChatUpdate(statsData, reservationsData, flingsData);

        // If this succeeds, potentially clear the *global* error state
        if (globalErrorState) {
             console.log("Main data fetch successful, clearing global error state potentially.");
             setErrorState(null); // Attempt to clear global error
        }
        globalErrorState = false;


    } catch (error) {
        // This error likely affects all endpoints (network issue, server down)
        console.error("Error fetching non-chat data:", error);
        setErrorState(error.message || "Unknown error fetching main data");
        globalErrorState = true; // Set global error flag
    }
}

// **NEW: Function to fetch only chat data**
async function updateChatOnly() {
     // **** ADDED THIS LOG ****
     console.log(`updateChatOnly running at ${new Date().toISOString()}`);
     // Don't bother fetching chat if we know there's a global error
     if (globalErrorState) {
         console.warn("Skipping chat fetch due to global error state.");
         return;
     }

    try {
        const chatLogsResponse = await fetch('/get_chatlogs?limit=' + MAX_CHAT_ITEMS);
        // **** ADDED THIS LOG ****
        console.log(`Chat fetch status: ${chatLogsResponse.status}`);

        if (!chatLogsResponse.ok) {
             // **** ADDED THIS LOG ****
             console.error(`Chat fetch failed! Status: ${chatLogsResponse.status}`);
             throw new Error(`ChatLogs fetch failed: ${chatLogsResponse.status} ${chatLogsResponse.statusText}`);
        }

        const chatLogsData = await chatLogsResponse.json();
         // **** ADDED THIS LOG ****
         console.log("Chat data received:", chatLogsData.length, "items");

        // Process **ONLY** chat data
        updateChatLogFeed(chatLogsData); // Directly call the chat feed update function

        // Clear any chat-specific error message if successful
        const chatErrorMsg = chatLogFeedList?.querySelector('.error-feed-message');
        if(chatErrorMsg) {
            chatErrorMsg.remove();
            // Re-apply filter to show empty/no-results correctly after error clear
             filterChatLogs();
        }

    } catch(error) {
        // **** ADDED THIS LOG ****
        console.error("Error inside updateChatOnly catch:", error);
        // Display error specifically within the chat feed
        if (chatLogFeedList) {
            // Avoid wiping the whole list if messages were previously visible
            let errorMsgElement = chatLogFeedList.querySelector('.error-feed-message');
            if (!errorMsgElement) {
                // If no error message exists, prepend one
                 const li = document.createElement('li');
                 li.className = 'error-feed-message';
                 chatLogFeedList.prepend(li); // Add to top so it's visible
                 errorMsgElement = li;
            }
             errorMsgElement.textContent = `Chat Update Failed: ${escapeHtml(error.message)}`;
             errorMsgElement.style.display = 'flex'; // Make sure it's visible

             // Hide other placeholders
             const emptyMsg = chatLogFeedList.querySelector('.empty-feed-message');
             if (emptyMsg) emptyMsg.style.display = 'none';
             const noResults = chatLogFeedList.querySelector('.no-results-message');
             if (noResults) noResults.style.display = 'none';
        }
         // We don't set globalErrorState here, as only chat failed.
    }
}


// **MODIFIED: processUpdate renamed and simplified to exclude chat**
function processNonChatUpdate(stats, reservations, flings) {
    // Update Stats Cards
    applyUpdateEffect(botCountEl, stats?.botCount);
    applyUpdateEffect(serverCountEl, stats?.serverCount);
    applyUpdateEffect(totalFlingsEl, stats?.totalFlings);
    const rate = stats?.flingRatePerMinute;
    applyUpdateEffect(flingRateEl, typeof rate === 'number' ? rate.toFixed(1) : '?');

    // Update Timestamp and Live Indicator (only if main update succeeds)
    if (lastUpdatedEl) lastUpdatedEl.textContent = new Date().toLocaleTimeString();
    if (liveIndicator && !liveIndicator.classList.contains('pulsing')) liveIndicator.classList.add('pulsing');
    if (topLiveIndicator && !topLiveIndicator.classList.contains('pulsing')) topLiveIndicator.classList.add('pulsing');

    // Update Regions
    updateRegionDistribution(stats?.botsPerRegion);

    // Update Reservations JSON View
    const currentDataString = JSON.stringify(reservations);
    const previousDataString = JSON.stringify(previousReservationsData);
    if (currentDataString !== previousDataString || !initialLoadComplete) {
        previousReservationsData = reservations;
        scheduleJsonUpdate(reservations);
    } else {
        if (reservationsContainerEl && reservationsContainerEl.classList.contains('loading')) {
            // Ensure loading state removed even if data hasn't changed
            reservationsContainerEl.classList.remove('loading');
            reservationsContainerEl.classList.toggle('empty', !previousReservationsData || (Array.isArray(previousReservationsData) && previousReservationsData.length === 0));
             if(reservationsContainerEl.classList.contains('empty')) {
                 reservationsContainerEl.textContent = 'No active reservations.';
             }
        }
    }

    // Update Fling Feed (still part of the main update cycle)
    updateFlingFeed(flings);

    // Mark initial load as complete after the *first* successful non-chat update
    if (!initialLoadComplete) {
        initialLoadComplete = true;
        console.log("Initial non-chat data load complete.");
    }
}


// --- UI Update Functions ---
// applyUpdateEffect, updateRegionDistribution, scheduleJsonUpdate remain the same
function applyUpdateEffect(/*...*/) {/* definition as before */}
function updateRegionDistribution(/*...*/) {/* definition as before */}
function scheduleJsonUpdate(/*...*/) {/* definition as before */}

// --- Feed Update Functions (Fling and Chat) ---
// updateFlingFeed, addFlingToFeed remain the same
function updateFlingFeed(/*...*/) {/* definition as before */}
function addFlingToFeed(/*...*/) {/* definition as before */}

// updateChatLogFeed, addChatToFeed - WITH LOGGING
function updateChatLogFeed(chatLogsData) {
    if (!chatLogFeedList || !Array.isArray(chatLogsData)) {
        console.warn("Invalid chat logs data received or feed element missing.");
        // Error handling as before
        return;
    }

    let newMessagesAdded = false;
    let highestTimestampInBatch = latestDisplayedChatTimestamp; // Track highest in this specific fetch

    // Iterate backwards (API returns newest first, process oldest new message first)
    for (let i = chatLogsData.length - 1; i >= 0; i--) {
        const log = chatLogsData[i];
        // Use received_at (server timestamp) for comparison
        const comparison = log.received_at > latestDisplayedChatTimestamp;
        // **** ADDED THIS LOG ****
        console.log(`  Checking log: P='${log.playerName}', T=${log.received_at}, Latest=${latestDisplayedChatTimestamp}, Add? ${comparison}`);

        if (comparison) {
            addChatToFeed(log); // AddChatToFeed now handles filtering visibility
            newMessagesAdded = true;
            // Update the highest timestamp found *in this batch*
            if (log.received_at > highestTimestampInBatch) {
                highestTimestampInBatch = log.received_at;
            }
        } else {
            // Optimization: if API guarantees newest-first sort, we can break
            // If unsure about API sort guarantee, remove the 'break'
            // break;
        }
    }

    // Update the global timestamp *after* processing the entire batch
    if (highestTimestampInBatch > latestDisplayedChatTimestamp) {
        // **** ADDED THIS LOG ****
        console.log(`Updating latestDisplayedChatTimestamp from ${latestDisplayedChatTimestamp} to ${highestTimestampInBatch}`);
        latestDisplayedChatTimestamp = highestTimestampInBatch;
    }


    // Remove error messages if data processed successfully
    if (newMessagesAdded || chatLogsData.length > 0) {
        const errorMessages = chatLogFeedList.querySelectorAll('.error-feed-message');
        errorMessages.forEach(msg => msg.remove());
    }

    // Trim excess items (remove oldest actual chat entries from the bottom)
    const allEntries = chatLogFeedList.querySelectorAll('li.chat-entry');
    let currentItemCount = allEntries.length;
    // Keep removing the oldest li.chat-entry until count is correct
    while (currentItemCount > MAX_CHAT_ITEMS) {
         let oldestEntry = null;
         // Find the last element that is a chat entry
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
             break; // No more chat entries found to remove
         }
    }

    // Re-apply filter AFTER adding new messages and trimming.
    // This ensures the 'no results' / 'empty' messages are correctly displayed.
    filterChatLogs();
}

function addChatToFeed(logData) { // Definition as before
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

// filterChatLogs remains the same
function filterChatLogs() {/* definition as before */}


// --- State Management Functions (Loading/Error) ---

// **MODIFIED: setInitialLoadingState fetches everything once for the first load**
async function performInitialLoad() {
    console.log("Performing initial data load..."); // LOG #2a
    setInitialLoadingStateVisuals(); // Set visual loading state immediately

    try {
         console.log("Initial Load: Starting fetch..."); // LOG #2b
         // Fetch everything in parallel for the initial load
         const [statsResponse, reservationsResponse, flingsResponse, chatLogsResponse] = await Promise.all([
            fetch('/'),
            fetch('/reservations'),
            fetch('/flings'),
            fetch('/get_chatlogs?limit=' + MAX_CHAT_ITEMS)
        ]);

        console.log("Initial Load: Fetches completed."); // LOG #2c

        // Check all responses
        if (!statsResponse.ok) throw new Error(`Stats fetch failed: ${statsResponse.status} ${statsResponse.statusText}`);
        if (!reservationsResponse.ok) throw new Error(`Reservations fetch failed: ${reservationsResponse.status} ${reservationsResponse.statusText}`);
        if (!flingsResponse.ok) throw new Error(`Flings fetch failed: ${flingsResponse.status} ${flingsResponse.statusText}`);
        if (!chatLogsResponse.ok) throw new Error(`ChatLogs fetch failed: ${chatLogsResponse.status} ${chatLogsResponse.statusText}`);

        console.log("Initial Load: Responses OK. Parsing JSON..."); // LOG #2d

        // Parse JSON data
        const statsData = await statsResponse.json();
        const reservationsData = await reservationsResponse.json();
        const flingsData = await flingsResponse.json();
        const chatLogsData = await chatLogsResponse.json();

        console.log("Initial Load: JSON parsed. Processing..."); // LOG #2e

        // Process non-chat data first
        processNonChatUpdate(statsData, reservationsData, flingsData);
        // Then process chat data
        updateChatLogFeed(chatLogsData);

        console.log("Initial Load: Processing complete."); // LOG #2f

        setErrorState(null); // Clear errors if initial load succeeds
        globalErrorState = false;
        initialLoadComplete = true; // Mark complete after full successful initial load
        console.log("Initial data load successful."); // LOG #2g

    } catch (error) {
        console.error("Error during initial data load:", error); // LOG #2h (Error)
        setErrorState(error.message || "Initial data load failed");
        globalErrorState = true;
        initialLoadComplete = true; // Still mark as complete to allow intervals to start trying
    } finally {
        // **** ADDED THIS LOG ****
        console.log("Initial Load: FINALLY block reached. Starting intervals."); // LOG #2i
        // Start the polling intervals AFTER the initial load attempt completes (success or fail)
        setInterval(updateNonChatData, UPDATE_INTERVAL);
        setInterval(updateChatOnly, CHAT_UPDATE_INTERVAL);
    }
}


// **NEW: Function to only set the visuals for loading state**
function setInitialLoadingStateVisuals() {/* definition as before */}

// **MODIFIED: setErrorState now focuses on global errors affecting non-chat elements**
function setErrorState(errorMessage) {/* definition as before, handles global errors */}


// --- UI Control Handlers (JSON View, Theme, Gradient) ---
// toggleJsonBtn, copyJsonBtn, sortButtons handlers remain the same
function toggleJsonBtn(/*...*/) {/* definition as before */}
function copyJsonBtn(/*...*/) {/* definition as before */}
// sortButtons?.forEach(...); // definition as before

// themeSelectorEl handler remains the same
// themeSelectorEl?.addEventListener('change', ...); // definition as before

// applyTheme, loadThemePreference remain the same
function applyTheme(/*...*/) {/* definition as before */}
function loadThemePreference(/*...*/) {/* definition as before */}

// --- Gradient Controls ---
// findPresetByColors, applyGradient, loadGradientPreference, handleGradientChange, setupGradientSelector remain the same
function findPresetByColors(/*...*/) {/* definition as before */}
function applyGradient(/*...*/) {/* definition as before */}
function loadGradientPreference(/*...*/) {/* definition as before */}
function handleGradientChange(/*...*/) {/* definition as before */}
function setupGradientSelector(/*...*/) {/* definition as before */}

// --- Utility Functions ---
// escapeHtml remains the same
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe; // Return non-strings as is
    return unsafe
         .replace(/&/g, "&")
         .replace(/</g, "<")
         .replace(/>/g, ">")
         .replace(/"/g, '"')
         .replace(/'/g, "'");
}

// --- Event Listeners & Initialization ---

// Listener for the chat search input
chatSearchInput?.addEventListener('input', filterChatLogs);

// Listener for custom gradient pickers
if (gradientColorPicker1 && gradientColorPicker2) {
    gradientColorPicker1.addEventListener('input', handleGradientChange);
    gradientColorPicker2.addEventListener('input', handleGradientChange);
} else {
    console.error("Gradient color pickers not found!");
}

// Initialize on DOM Load
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded. Initializing TCD Dashboard.");
    // Setup UI Controls
    setupGradientSelector();
    loadThemePreference();
    loadGradientPreference();

    // **MODIFIED: Start the initial load process**
    performInitialLoad(); // This function now also starts the intervals after completion

    // Initial filter application (in case browser restores input) - run after visuals are set
    filterChatLogs();

    // Note: Intervals are now started inside performInitialLoad's finally block
});