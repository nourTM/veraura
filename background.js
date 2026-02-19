console.log("VeraAura: Background script loaded.");

/**
 * Injects the content script and sends a message to start/resume a task.
 * This is the central logic for automatically starting the guide on page loads.
 * @param {number} tabId The ID of the tab to set up.
 * @param {string} url The URL of the tab.
 */
async function setupTaskOnTab(tabId, url) {
    try {
        const { storedTaskId, storedStepIndex } = await chrome.storage.local.get(["storedTaskId", "storedStepIndex"]);

        if (storedTaskId && typeof storedStepIndex !== 'undefined') {
            const tasksURL = chrome.runtime.getURL('tasks.json');
            const response = await fetch(tasksURL);
            if (!response.ok) return; // Silently fail if tasks can't be loaded
            
            const tasksData = await response.json();
            const task = tasksData[storedTaskId];

            // If a task is active and the URL matches, inject the script and start the guide.
            if (task && (!task.start_url || url.startsWith(task.start_url))) {
                console.log(`VeraAura Background: Auto-starting task '${storedTaskId}' on tab ${tabId}`);
                
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js']
                });

                await chrome.tabs.sendMessage(tabId, {
                    action: "START_TASK",
                    task: task,
                    stepIndex: storedStepIndex
                });
            }
        }
    } catch (e) {
        console.warn(`VeraAura Background: Could not set up task on tab ${tabId}. This is expected for protected pages.`, e.message);
    }
}

// Listen for tab updates (e.g., navigations) and run our setup function.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
        setupTaskOnTab(tabId, tab.url);
    }
});