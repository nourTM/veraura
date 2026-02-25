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

    if (taskId && tasksData[taskId]) {
        // If a different task is selected, stop the old one.
        if (currentTaskId && currentTaskId !== taskId) {
            chrome.runtime.sendMessage({ action: "STOP_TASK_ON_TAB" });
        }
        currentTaskId = taskId;
        activeTask = tasksData[taskId];
        currentStepIndex = 0; // Reset step index

        // Save state, then tell the background script to handle the rest.
        await chrome.storage.local.set({ storedTaskId: taskId, storedStepIndex: 0 });
        chrome.runtime.sendMessage({ action: "INITIATE_TASK" });

        // Update the popup UI immediately based on URL validity.
        const isUrlValid = await checkUrlForTask(activeTask);
        if (isUrlValid) {
            updateUI();
        } else {
            updateUIForInvalidUrl();
        }
    } else {
        // User selected "-- Choose your Lab --"
        chrome.runtime.sendMessage({ action: "STOP_TASK_ON_TAB" });
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

    // Mark this specific task as completed in sync storage to prevent re-logging.
    const completionKey = `completed_${currentTaskId}`;
    chrome.storage.sync.set({ [completionKey]: true });
    
    // Fun animation
    const statusEl = document.getElementById('status');
    statusEl.style.transition = 'transform 0.5s ease-in-out';
    statusEl.style.transform = 'scale(1.2)';
    setTimeout(() => {
        statusEl.style.transform = 'scale(1.0)';
    }, 500);

    // Stop monitoring on the page
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        // The background script will handle sending the stop message
        chrome.runtime.sendMessage({ action: "STOP_TASK_ON_TAB" });
    });
}

// Run the initialization function when the DOM is ready.
document.addEventListener('DOMContentLoaded', initializePopup);

// Reset button handler
document.getElementById('resetBtn').addEventListener('click', async () => {
    currentStepIndex = 0;
    await chrome.storage.local.set({ storedStepIndex: 0 });

    // Also clear the completion status for this task so it can be logged again if re-done.
    if (currentTaskId) {
        const completionKey = `completed_${currentTaskId}`;
        await chrome.storage.sync.remove(completionKey);
    }

    updateUI();
    // Tell the background script to restart the task on the current page
    chrome.runtime.sendMessage({ action: "INITIATE_TASK" });
    console.log("VeraAura: Step index reset to 0.");
});