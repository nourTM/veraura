if (window.veraAuraLoaded) {
    // The script is already on the page, likely due to multiple injection triggers
    // from SPA navigation events. The first instance of the script will handle
    // any messages, so this one can safely terminate.
    console.log("VeraAura: Script already loaded, stopping redundant execution.");
} else {
    window.veraAuraLoaded = true;
    console.log("VeraAura: Script Loaded on Page");

let currentTask = null;
let currentTaskId = null;
let currentStepIndex = -1;
let highlightDiv = null;
let instructionDiv = null;
let activeListeners = []; // To track event listeners for cleanup
let highlightedElement = null; // To track the element being highlighted for repositioning
let visualsUpdateLoopId = null; // ID for the requestAnimationFrame loop
 
/**
 * Finds an element, supporting shadow DOM piercing.
 * @param {string|string[]} selector - A CSS selector string or an array of selectors for shadow DOM traversal.
 * @returns {Element|null} The found element or null.
 */
function findElement(selector) {
    if (Array.isArray(selector)) {
        let root = document;
        let element = null;
        for (let i = 0; i < selector.length; i++) {
            const part = selector[i];
            if (i > 0) {
                if (!element || !element.shadowRoot) {
                    console.warn(`VeraAura: Could not find shadow root on element for previous selector part: ${selector[i-1]}`);
                    return null;
                }
                root = element.shadowRoot;
            }
            element = root.querySelector(part);
            if (!element) {
                // This is a common case when waiting for elements, so not logging as an error.
                console.log(`VeraAura: Element not found for selector part: ${part}`);
                return null;
            }
        }
        return element;
    } else {
        return document.querySelector(selector);
    }
}

function cleanupEventListeners() {
    console.log(`VeraAura: Cleaning up ${activeListeners.length} old listeners.`);
    activeListeners.forEach(({ element, type, listener }) => {
        if (type === 'mutation_observer') {
            element.disconnect();
        } else {
            element.removeEventListener(type, listener);
        }
    });
    activeListeners = []; // Reset the array
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_TASK") {
        // If we receive a START_TASK but we already have a task running for the same taskId,
        // it's likely a race condition from an SPA navigation. The currently running script
        // is the source of truth for its state, so we should ignore the background script's
        // attempt to restart us with potentially stale state from storage.
        if (currentTask && currentTaskId === request.taskId) {
            console.log("VeraAura: Ignoring redundant START_TASK message to prevent state overwrite.");
            sendResponse({ success: true, ignored: true });
            return;
        }

        cleanupEventListeners(); // Clean up any lingering listeners from previous states
        cleanupUI(); // Clean up any previous visual elements
        currentTask = request.task;
        currentTaskId = request.taskId;
        currentStepIndex = request.stepIndex;
        startMonitoringStep();
        sendResponse({ success: true });
    } else if (request.action === "STOP_TASK") {
        cleanupEventListeners();
        cleanupUI();
        currentTask = null;
        currentStepIndex = -1;
        sendResponse({ success: true });
    }
});

function startMonitoringStep() {
    if (!currentTask || currentStepIndex >= currentTask.steps.length) {
        cleanupUI();
        return;
    }

    const step = currentTask.steps[currentStepIndex];
    const targetElement = findElement(step.selector);
    console.log(`VeraAura: Monitoring Step ${currentStepIndex + 1} - Action: ${step.action_type}, Selector: ${step.selector}, element found: ${!!targetElement}`);
    if (!targetElement) {
        // If element not present, wait for it to appear
        const observer = new MutationObserver((mutations, obs) => {
            if (findElement(step.selector)) {
                obs.disconnect(); // Stop observing
                console.log("VeraAura: Element found after mutation. Resuming step.");
                startMonitoringStep(); // Retry setting up the listener
            }
        });

        let nodeToObserve = document.body;
        // For shadow DOM selectors, we need to find the deepest shadow host that currently exists
        // and observe its shadow root for the next part of the selector to appear.
        if (Array.isArray(step.selector) && step.selector.length > 1) {
            let root = document;
            let lastFoundElement = null;
            // Traverse the selector parts to find the deepest existing element that has a shadow root.
            for (let i = 0; i < step.selector.length - 1; i++) {
                const part = step.selector[i];
                if (i > 0) {
                    if (!lastFoundElement || !lastFoundElement.shadowRoot) break; // Can't go deeper
                    root = lastFoundElement.shadowRoot;
                }
                const currentElement = root.querySelector(part);
                if (!currentElement) break; // This part of the selector doesn't exist yet
                lastFoundElement = currentElement;
            }

            // We should observe the shadow root of the last element we successfully found.
            if (lastFoundElement && lastFoundElement.shadowRoot) {
                nodeToObserve = lastFoundElement.shadowRoot;
            }
        }

        console.log(`VeraAura: Element not found. Observing for changes on:`, nodeToObserve);
        observer.observe(nodeToObserve, { childList: true, subtree: true, attributes: true });
        return;
    }

    // Create visual guides
    createVisualGuides(step);

    switch (step.action_type) {
        case 'click': {
            const clickListener = async (event) => {
                // Check if this click is likely to cause a page navigation.
                const isNavigationClick = targetElement.tagName === 'A' && targetElement.href;

                // If it's a navigation click, prevent the default action to ensure
                // our state-saving logic can complete before the page unloads.
                if (isNavigationClick) {
                    event.preventDefault();
                    event.stopPropagation();
                }

                await handleStepCompletion(isNavigationClick ? targetElement.href : null);
            };
            targetElement.addEventListener('click', clickListener);
            activeListeners.push({ element: targetElement, type: 'click', listener: clickListener });
            break;
        }
        case 'text_match': {
            const textMatchListener = (event) => {
                // Use optional chaining for safety in case targetElement is not an input
                const currentValue = targetElement.value?.trim().toLowerCase() || '';
                if (currentValue === step.expected.toLowerCase()) {
                    handleStepCompletion();
                }
            };
            targetElement.addEventListener('input', textMatchListener);
            targetElement.addEventListener('change', textMatchListener);
            activeListeners.push({ element: targetElement, type: 'input', listener: textMatchListener });
            activeListeners.push({ element: targetElement, type: 'change', listener: textMatchListener });
            break;
        }
        case 'text_change_match': {
            const checkCondition = () => {
                // Re-find the element in case the DOM has changed significantly
                const currentElement = findElement(step.selector);
                if (!currentElement) return false;
                const currentText = currentElement.textContent.trim();
                const regex = new RegExp(step.expected, 'i');
                return regex.test(currentText);
            };

            // Before starting, check if the condition is already met.
            if (checkCondition()) {
                console.log("VeraAura: text_change_match condition already met on start.");
                // Use a timeout to allow the user to see the instruction before it disappears.
                setTimeout(() => {
                    if (checkCondition()) handleStepCompletion();
                }, 1500);
                return; // Exit without setting up an observer
            }

            const observer = new MutationObserver((mutations) => {
                if (checkCondition()) {
                    // The observer's job is done. handleStepCompletion will clean it up.
                    handleStepCompletion();
                }
            });
            
            observer.observe(targetElement, { childList: true, characterData: true, subtree: true });
            activeListeners.push({
                element: { disconnect: () => observer.disconnect() },
                type: 'mutation_observer',
                listener: null
            });
            break;
        }
    }
}

async function handleStepCompletion(navigationUrl = null) {
    // First, check if there's even a task running. This prevents errors from stray events.
    if (!currentTask) {
        console.warn("VeraAura: handleStepCompletion called but no task is active. Cleaning up and stopping.");
        cleanupEventListeners();
        cleanupUI();
        return;
    }

    console.log(`VeraAura: Step ${currentStepIndex + 1} completed.`);
    cleanupEventListeners(); // Clean up listeners for the step that just completed.
    cleanupUI(); // Clean up visual guides.

    currentStepIndex++;

    // The content script is now the source of truth for state progression.
    // We await the storage operation to guarantee it completes before page navigation.
    await chrome.storage.local.set({ storedStepIndex: currentStepIndex });

    // Log progress to Google Sheets via the background script
    chrome.runtime.sendMessage({
        action: "LOG_PROGRESS",
        taskId: currentTaskId,
        stepIndex: currentStepIndex - 1, // Send the index of the step just completed
        totalSteps: currentTask.steps.length
    });

    // Notify the popup (if open) that it needs to refresh its UI, but don't wait for a response.
    chrome.runtime.sendMessage({ action: "REFRESH_STATE" });
    
    if (currentStepIndex >= currentTask.steps.length) {
        console.log("VeraAura: Task finished on page.");
        // The popup's `markAsDone` will handle clearing storage. We just stop.
        currentTask = null;
        currentStepIndex = -1;
    } else {
        // If we are NOT navigating away, start monitoring the next step.
        // If we ARE navigating, the content script on the new page will take over.
        if (!navigationUrl) {
            // Instead of immediately starting the next step, wait a short moment.
            // This gives SPAs (Single-Page Applications) time to navigate. If a
            // navigation happens, this script will be destroyed. If not, we
            // proceed to the next step on the same page.
            setTimeout(() => {
                // Before starting, double-check that a task is still active.
                if (currentTask) {
                    console.log(`VeraAura: Advancing to step ${currentStepIndex + 1} on the same page.`);
                    startMonitoringStep();
                }
            }, 250); // A 250ms delay is usually enough for an SPA to change the URL.
        } else {
            console.log(`VeraAura: State saved for step ${currentStepIndex + 1}. Navigating...`);
        }
    }

    // If a navigation URL was provided, navigate to it now, after all other logic is complete.
    if (navigationUrl) {
        window.location.href = navigationUrl;
    }
}

function updateVisualGuidesPosition() {
    // If the target element is gone from the DOM, hide the guides.
    if (!highlightedElement || !highlightedElement.isConnected) {
        if (highlightDiv) highlightDiv.style.display = 'none';
        if (instructionDiv) instructionDiv.style.display = 'none';
        return;
    }

    const rect = highlightedElement.getBoundingClientRect();
    // If the element has no dimensions (e.g., display: none), it's not visible. Hide the guides.
    if (rect.width === 0 && rect.height === 0) {
        if (highlightDiv) highlightDiv.style.display = 'none';
        if (instructionDiv) instructionDiv.style.display = 'none';
        return;
    }

    // Make sure guides are visible if they were hidden
    if (highlightDiv) highlightDiv.style.display = 'block';
    if (instructionDiv) instructionDiv.style.display = 'block';

    // Update highlight box position (relative to viewport)
    if (highlightDiv) {
        highlightDiv.style.left = `${rect.left}px`;
        highlightDiv.style.top = `${rect.top}px`;
        highlightDiv.style.width = `${rect.width}px`;
        highlightDiv.style.height = `${rect.height}px`;
    }

    // Update instruction box position using the smart positioning logic
    if (instructionDiv) {
        const instructionRect = instructionDiv.getBoundingClientRect();
        const spaceRight = window.innerWidth - rect.right;
        const spaceLeft = rect.left;
        const spaceBelow = window.innerHeight - rect.bottom;

        let finalLeft, finalTop;

        if (spaceRight > instructionRect.width + 20) {
            finalLeft = rect.right + 10;
            finalTop = rect.top;
        } else if (spaceLeft > instructionRect.width + 20) {
            finalLeft = rect.left - instructionRect.width - 10;
            finalTop = rect.top;
        } else if (spaceBelow > instructionRect.height + 20) {
            finalLeft = rect.left;
            finalTop = rect.bottom + 10;
        } else {
            finalLeft = rect.left;
            finalTop = rect.top - instructionRect.height - 10;
        }

        // Final boundary checks to keep it fully on screen
        if (finalTop < 10) finalTop = 10;
        if (finalTop + instructionRect.height > window.innerHeight - 10) finalTop = window.innerHeight - instructionRect.height - 10;
        if (finalLeft < 10) finalLeft = 10;
        if (finalLeft + instructionRect.width > window.innerWidth - 10) finalLeft = window.innerWidth - instructionRect.width - 10;

        instructionDiv.style.left = `${finalLeft}px`;
        instructionDiv.style.top = `${finalTop}px`;
    }
}

function visualsUpdateLoop() {
    updateVisualGuidesPosition();
    visualsUpdateLoopId = requestAnimationFrame(visualsUpdateLoop);
}

function createVisualGuides(step) {
    if (!document.getElementById('vera-aura-animation-styles')) {
        const styleSheet = document.createElement('style');
        styleSheet.id = 'vera-aura-animation-styles';
        styleSheet.innerText = `@keyframes veraAuraPulse { 0% { box-shadow: 0 0 0 0 rgba(37, 117, 252, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(37, 117, 252, 0); } 100% { box-shadow: 0 0 0 0 rgba(37, 117, 252, 0); } }`;
        document.head.appendChild(styleSheet);
    }

    highlightedElement = findElement(step.highlight_selector);
    if (!highlightedElement) return;

    if (!highlightDiv) {
        highlightDiv = document.createElement('div');
        highlightDiv.style.position = 'fixed';
        highlightDiv.style.border = '2px solid #2575fc';
        highlightDiv.style.borderRadius = '5px';
        highlightDiv.style.boxSizing = 'border-box';
        highlightDiv.style.pointerEvents = 'none';
        highlightDiv.style.zIndex = '2147483647';
        highlightDiv.style.animation = 'veraAuraPulse 2s infinite';
        document.body.appendChild(highlightDiv);
    }

    if (!instructionDiv) {
        instructionDiv = document.createElement('div');
        instructionDiv.style.position = 'fixed';
        instructionDiv.style.backgroundColor = 'rgba(37, 117, 252, 0.9)';
        instructionDiv.style.color = 'white';
        instructionDiv.style.padding = '10px';
        instructionDiv.style.borderRadius = '5px';
        instructionDiv.style.pointerEvents = 'none';
        instructionDiv.style.zIndex = '2147483647';
        instructionDiv.style.maxWidth = '250px';
        document.body.appendChild(instructionDiv);
    }

    instructionDiv.innerText = step.instruction;

    // Start the loop that keeps the guides in the right place
    if (visualsUpdateLoopId) cancelAnimationFrame(visualsUpdateLoopId);
    visualsUpdateLoopId = requestAnimationFrame(visualsUpdateLoop);
}

function cleanupUI() {
    if (visualsUpdateLoopId) {
        cancelAnimationFrame(visualsUpdateLoopId);
        visualsUpdateLoopId = null;
    }
    if (highlightDiv) {
        highlightDiv.remove();
        highlightDiv = null;
    }
    if (instructionDiv) {
        instructionDiv.remove();
        instructionDiv = null;
    }
    highlightedElement = null;
}
} // End of the main 'else' block to prevent re-execution.