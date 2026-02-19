let currentStepIndex = 0;
let activeTask = null;
let tasksData = {};
let currentTaskId = null;

/**
 * Initializes the popup, loads tasks, and restores the last state.
 */
async function initializePopup() {
    console.log("VeraAura: 1. Popup Initializing...");
    try {
        const tasksURL = chrome.runtime.getURL('tasks.json');
        console.log("VeraAura: 2. Attempting to fetch tasks from:", tasksURL);
        const response = await fetch(tasksURL);
        console.log("VeraAura: 3. Fetch response received. Status:", response.status);
        if (!response.ok) {
            throw new Error(`Failed to load tasks.json: ${response.statusText}`);
        }
        tasksData = await response.json();
        console.log("VeraAura: 4. Tasks JSON parsed successfully:", tasksData);

        const taskSelector = document.getElementById('taskSelector');
        if (!taskSelector) throw new Error("taskSelector element not found in popup.html");
        // Clear any existing options except the first one
        taskSelector.length = 1; 

        for (const taskId in tasksData) {
            const option = document.createElement('option');
            option.value = taskId;
            option.innerText = tasksData[taskId].title;
            taskSelector.appendChild(option);
        }
        console.log("VeraAura: 5. Task dropdown populated.");

        // Restore state from storage
        const { storedTaskId, storedStepIndex } = await chrome.storage.local.get(["storedTaskId", "storedStepIndex"]);
        if (storedTaskId && tasksData[storedTaskId]) {
            currentTaskId = storedTaskId;
            activeTask = tasksData[currentTaskId];
            currentStepIndex = storedStepIndex || 0;
            taskSelector.value = currentTaskId;

            const isUrlValid = await checkUrlForTask(activeTask);
            if (isUrlValid) {
                updateUI();
                // The background script is now responsible for resuming the task on page load/navigation.
                // The popup just needs to reflect the current state.
            } else {
                // Don't start the task, just show the UI with a warning
                updateUIForInvalidUrl();
            }
        }
    } catch (error) {
        console.error("VeraAura: Error initializing popup:", error);
        document.getElementById('status').innerText = "Error: Could not load tasks.";
    }
}

/**
 * Wraps chrome.tabs.sendMessage in a Promise for async/await usage.
 * @param {number} tabId The ID of the tab to send the message to.
 * @param {any} message The message to send.
 * @returns {Promise<any>} A promise that resolves with the response.
 */
function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                // Content script might not be injected yet or tab is protected.
                console.warn("VeraAura: Could not send message:", chrome.runtime.lastError.message);
                // Resolve with a default value to avoid unhandled promise rejections.
                resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
                resolve(response);
            }
        });
    });
}

/**
 * Checks if the current tab's URL is valid for the given task.
 * @param {object} task The task object, which may have a start_url.
 * @returns {Promise<boolean>} True if the URL is valid or not specified.
 */
async function checkUrlForTask(task) {
    if (!task || !task.start_url) {
        return true; // If no URL is specified, it can run anywhere.
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
        return false; // Cannot determine URL.
    }
    return tab.url.startsWith(task.start_url);
}

document.getElementById('taskSelector').addEventListener('change', async (e) => {
    const taskId = e.target.value;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (taskId && tasksData[taskId]) {
        // If a different task is selected, stop the old one.
        if (currentTaskId && currentTaskId !== taskId) {
            await sendMessageToTab(tab.id, { action: "STOP_TASK" });
        }
        currentTaskId = taskId;
        activeTask = tasksData[taskId];
        currentStepIndex = 0; // Reset step index

        const isUrlValid = await checkUrlForTask(activeTask);
        if (isUrlValid) {
            await chrome.storage.local.set({ storedTaskId: taskId, storedStepIndex: 0 });
            updateUI();
            startTaskOnPage();
        } else {
            // URL is invalid. Stop any active task and show a message.
            await chrome.storage.local.set({ storedTaskId: taskId, storedStepIndex: 0 }); // Save selection
            updateUIForInvalidUrl();
            await sendMessageToTab(tab.id, { action: "STOP_TASK" });
        }
    } else {
        // User selected "-- Choose your Lab --"
        await sendMessageToTab(tab.id, { action: "STOP_TASK" });
        currentTaskId = null;
        activeTask = null;
        currentStepIndex = 0;
        await chrome.storage.local.remove(["storedTaskId", "storedStepIndex"]);
        updateUI(); // Clear the UI
    }
});

// Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "REFRESH_STATE") {
        // The content script has updated the state. Re-read from storage and update the UI.
        // This is for when the popup is already open and a step is completed on the page.
        (async () => {
            const { storedStepIndex } = await chrome.storage.local.get("storedStepIndex");
            // Check if activeTask is loaded and the step index is valid
            if (activeTask && typeof storedStepIndex !== 'undefined') {
                currentStepIndex = storedStepIndex;
                if (currentStepIndex >= activeTask.steps.length) {
                    markAsDone();
                } else {
                    updateUI();
                }
            }
        })();
    }
});

async function startTaskOnPage() {
    if (!activeTask) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });    
    if (!tab || !tab.id) {
        console.warn("VeraAura: No active tab found");
        return;
    }
    
    try {
        // 1. Ensure the content script is injected before sending a message.
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        });

        // 2. Send the message to start the task, using our helper function.
        await sendMessageToTab(tab.id, {
            action: "START_TASK",
            task: activeTask,
            stepIndex: currentStepIndex
        });
    } catch (e) {
        console.error("VeraAura: Failed to inject script or send message:", e);
        document.getElementById('status').innerText = "Error: Cannot run on this page.";
    }
}

function updateUI() {
    const guideBox = document.getElementById('guideBox');
    const status = document.getElementById('status');
    const resetBtn = document.getElementById('resetBtn');

    if (activeTask && currentStepIndex < activeTask.steps.length) {
        const step = activeTask.steps[currentStepIndex];
        document.getElementById('stepInstruction').innerText = `Step ${currentStepIndex + 1}: ${step.instruction}`;
        const percent = (currentStepIndex / activeTask.steps.length) * 100;
        document.getElementById('progressFill').style.width = `${percent}%`;
        guideBox.style.display = "block";
        status.innerText = "Task in progress...";
        resetBtn.style.display = "inline-block";
    } else {
        // Handles the case where no task is selected or a task is completed (but not yet marked as done)
        guideBox.style.display = "none";
        status.innerText = "Waiting for task selection...";
        resetBtn.style.display = "none";
    }
}

function updateUIForInvalidUrl() {
    const guideBox = document.getElementById('guideBox');
    const status = document.getElementById('status');
    const resetBtn = document.getElementById('resetBtn');

    guideBox.style.display = "none";
    resetBtn.style.display = "none";
    status.innerHTML = `Please navigate to the correct page to start this lab.<br><small>(Required URL starts with: <code>${activeTask.start_url}</code>)</small>`;
    document.getElementById('progressFill').style.width = `0%`;
}

function markAsDone() {
    document.getElementById('progressFill').style.width = "100%";
    document.getElementById('stepInstruction').innerText = "Task Complete!";
    document.getElementById('status').innerHTML = "🎉 Well Done! You finished the lab! 🎉";
    chrome.storage.local.remove(["storedTaskId", "storedStepIndex"]);
    
    // Fun animation
    const statusEl = document.getElementById('status');
    statusEl.style.transition = 'transform 0.5s ease-in-out';
    statusEl.style.transform = 'scale(1.2)';
    setTimeout(() => {
        statusEl.style.transform = 'scale(1.0)';
    }, 500);

    // Stop monitoring on the page
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        chrome.tabs.sendMessage(tab.id, { action: "STOP_TASK" });
    });
}

// Run the initialization function when the DOM is ready.
document.addEventListener('DOMContentLoaded', initializePopup);

// Reset button handler
document.getElementById('resetBtn').addEventListener('click', async () => {
    currentStepIndex = 0;
    await chrome.storage.local.set({ storedStepIndex: 0 });
    updateUI();
    // Restart the task on the page to reflect the reset state immediately
    startTaskOnPage();
    console.log("VeraAura: Step index reset to 0.");
});