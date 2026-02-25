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
                    taskId: storedTaskId,
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
    // Trigger on full page loads ('complete') OR when the URL changes in an SPA.
    if ((changeInfo.status === 'complete' || changeInfo.url) && tab.url && tab.url.startsWith('http')) {
        console.log("VeraAura Background: onUpdated triggered due to change:", changeInfo);
        setupTaskOnTab(tabId, tab.url);
    }
});

// Listen for client-side navigations (common in SPAs like Teachable Machine)
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    // We only care about the main frame navigations.
    if (details.frameId === 0) {
        console.log("VeraAura Background: onHistoryStateUpdated triggered for URL:", details.url);
        // The URL in the details object is the new URL.
        setupTaskOnTab(details.tabId, details.url);
    }
});

/**
 * Logs progress to a Google Sheet via a Google Apps Script endpoint.
 * @param {string} taskId The unique ID of the task from tasks.json.
 * @param {number} stepIndex The index of the completed step.
 * @param {number} totalSteps The total number of steps in the task.
 */
async function logProgressToSheet(taskId, stepIndex, totalSteps) {
    // Get the Apps Script URL and the studentKey from sync storage.
    const { appsScriptUrl, moodleEmail } = await chrome.storage.sync.get(["appsScriptUrl", "moodleEmail"]);

    if (!appsScriptUrl) {
        console.log("VeraAura: Google Apps Script URL not configured. Skipping progress logging.");
        return;
    }
    if (!moodleEmail) {
        console.warn("VeraAura: Moodle Email not configured in options. Skipping progress logging.");
        return;
    }

    const progress = ((stepIndex + 1) / totalSteps) * 100;
    const grade = Math.round(progress);

    const payload = {
        email: moodleEmail, // We now send the user-provided Moodle email.
        taskId: taskId,
        progress: grade,
        timestamp: new Date().toISOString(),
        source: 'vera-aura-extension' // This is the new "tag"
    };

    try {
        console.log(`VeraAura Google Sheets: Logging progress for email: ${moodleEmail}.`);
        // Apps Script web apps can have issues with CORS and redirects when using fetch.
        // A simple POST with text/plain content type is the most reliable method.
        const response = await fetch(appsScriptUrl, {
            method: 'POST',
            mode: 'cors',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'text/plain;charset=utf-8' }
        });

        const responseData = await response.json();
        if (responseData.status === "success") {
            console.log("VeraAura Google Sheets: Progress logged successfully.");
        } else {
            console.error("VeraAura Google Sheets Error:", responseData.message);
        }
    } catch (error) {
        console.error("VeraAura Google Sheets: Failed to send request.", error);
    }
}

// Listen for messages from content scripts to log progress.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Handle messages from content scripts (they will have a sender.tab property)
    if (request.action === "LOG_PROGRESS") {
        logProgressToSheet(request.taskId, request.stepIndex, request.totalSteps);
        return true; // Indicate async response.
    }

    // Handle messages from the popup (they will NOT have a sender.tab property)
    if (request.action === "INITIATE_TASK") {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (tab && tab.url) {
                // Use the centralized setup function to start/restart the task
                setupTaskOnTab(tab.id, tab.url);
            }
        });
    } else if (request.action === "STOP_TASK_ON_TAB") {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (tab) {
                // Use a try-catch in case the content script isn't injected
                try {
                    chrome.tabs.sendMessage(tab.id, { action: "STOP_TASK" });
                } catch(e) { /* Silently fail if content script isn't there */ }
            }
        });
    }
});