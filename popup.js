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
            updateUI();
            // If a task was restored, ensure the content script is synchronized.
            // This is crucial if the user reloads the page or the content script was reset.
            console.log("VeraAura: Restoring task on page.");
            startTaskOnPage();
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
        await chrome.storage.local.set({ storedTaskId: taskId, storedStepIndex: 0 });
        updateUI();
        startTaskOnPage();
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

// Listen for completion messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "STEP_COMPLETED") {
        // Guard against race conditions: If no task is active, do nothing.
        // This can happen if a step completes right as the user stops the task.
        console.log("***********************************", activeTask);
        if (!activeTask) {
            console.warn("VeraAura: Received STEP_COMPLETED when no task was active. Ignoring.");
            sendResponse({ success: false });
            return;
        }
        // The content script has already advanced the step and saved it to storage.
        // We just need to increment our local state and update the UI accordingly.
        currentStepIndex++;

        if (currentStepIndex >= activeTask.steps.length) {
            // The task is complete.
            markAsDone();
        } else {
            // The task has progressed to the next step.
            updateUI();
        }
        sendResponse({ success: true });
    }
});

async function startTaskOnPage() {
    if (!activeTask) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Skip if no tab is found (shouldn't happen but safe check)
    if (!tab) {
        console.warn("VeraAura: No active tab found");
        return;
    }
    
    const message = {
        action: "START_TASK",
        task: activeTask,
        stepIndex: currentStepIndex
    };
    
    chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
            console.warn("VeraAura: Could not start task on page:", chrome.runtime.lastError.message);
            // Could be a protected page or tab closed
        }
    });
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