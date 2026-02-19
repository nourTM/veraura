console.log("VeraAura: Script Loaded on Page");

let currentTask = null;
let currentStepIndex = -1;
let highlightDiv = null;
let instructionDiv = null;
let activeListeners = []; // Array to track active listeners for cleanup

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
        element.removeEventListener(type, listener);
    });
    activeListeners = []; // Reset the array
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_TASK") {
        cleanupEventListeners(); // Clean up any lingering listeners from previous states
        cleanupUI(); // Clean up any previous visual elements
        currentTask = request.task;
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
                startMonitoringStep(); // Retry setting up the listener
            }
        });
        // Observe the entire document body for changes. This is robust enough to
        // catch elements appearing anywhere, including inside open shadow DOMs.
        observer.observe(document.body, { childList: true, subtree: true });
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
            console.log(`VeraAura: Advancing to step ${currentStepIndex + 1} on the same page.`);
            startMonitoringStep();
        } else {
            console.log(`VeraAura: State saved for step ${currentStepIndex + 1}. Navigating...`);
        }
    }

    // If a navigation URL was provided, navigate to it now, after all other logic is complete.
    if (navigationUrl) {
        window.location.href = navigationUrl;
    }
}

function createVisualGuides(step) {
    // Inject animation styles if not already present
    if (!document.getElementById('vera-aura-animation-styles')) {
        const styleSheet = document.createElement('style');
        styleSheet.id = 'vera-aura-animation-styles';
        styleSheet.innerText = `
            @keyframes veraAuraPulse {
                0% { box-shadow: 0 0 0 0 rgba(37, 117, 252, 0.7); }
                70% { box-shadow: 0 0 0 10px rgba(37, 117, 252, 0); }
                100% { box-shadow: 0 0 0 0 rgba(37, 117, 252, 0); }
            }
        `;
        document.head.appendChild(styleSheet);
    }

    const highlightElement = findElement(step.highlight_selector);
    if (!highlightElement) return;

    // Use a small timeout to ensure that any CSS animations have completed before
    // we get the element's position. This is crucial for elements that appear
    // in modals or other transitions.
    setTimeout(() => {
        // After the delay, check if the step is still the active one.
        // This prevents a guide for a previous step from appearing if the user advanced quickly.
        if (!currentTask || currentStepIndex >= currentTask.steps.length || currentTask.steps[currentStepIndex].id !== step.id) {
            return;
        }

        // Also ensure the element is still in the document.
        if (!highlightElement.isConnected) {
            return;
        }

        const rect = highlightElement.getBoundingClientRect();

        // Create and style the highlight box
        highlightDiv = document.createElement('div');
        highlightDiv.style.position = 'fixed';
        highlightDiv.style.border = '2px solid #2575fc'; // Solid border for a cleaner look
        highlightDiv.style.borderRadius = '5px';
        highlightDiv.style.boxSizing = 'border-box';
        highlightDiv.style.pointerEvents = 'none'; // Click through
        highlightDiv.style.left = `${rect.left + window.scrollX}px`;
        highlightDiv.style.top = `${rect.top + window.scrollY}px`;
        highlightDiv.style.width = `${rect.width}px`;
        highlightDiv.style.height = `${rect.height}px`;
        highlightDiv.style.zIndex = '2147483640'; // Use a very high z-index to appear above modals.
        highlightDiv.style.animation = 'veraAuraPulse 2s infinite'; // Apply animation
        document.body.appendChild(highlightDiv);

        // Create and style the instruction box
        instructionDiv = document.createElement('div');
        instructionDiv.innerText = step.instruction;
        instructionDiv.style.position = 'fixed';
        instructionDiv.style.backgroundColor = 'rgba(37, 117, 252, 0.9)';
        instructionDiv.style.color = 'white';
        instructionDiv.style.padding = '10px';
        instructionDiv.style.borderRadius = '5px';
        instructionDiv.style.pointerEvents = 'none';
        instructionDiv.style.zIndex = '2147483641'; // Ensure this is higher than the highlight.
        instructionDiv.style.maxWidth = '250px';
        document.body.appendChild(instructionDiv); // Append to get its dimensions

        // --- Smart Positioning Logic for Instruction Box ---
        const instructionRect = instructionDiv.getBoundingClientRect();
        const spaceRight = window.innerWidth - rect.right;
        const spaceLeft = rect.left;
        const spaceBelow = window.innerHeight - rect.bottom;

        let finalLeft, finalTop;

        // Prefer right side, then left, then below, then above
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
        if (finalTop + instructionRect.height > window.innerHeight - 10) {
            finalTop = window.innerHeight - instructionRect.height - 10;
        }
        if (finalLeft < 10) finalLeft = 10;
        if (finalLeft + instructionRect.width > window.innerWidth - 10) {
            finalLeft = window.innerWidth - instructionRect.width - 10;
        }

        instructionDiv.style.left = `${finalLeft + window.scrollX}px`;
        instructionDiv.style.top = `${finalTop + window.scrollY}px`;
    }, 500); // Increased timeout to 500ms to better handle slow-opening modals/animations.
}

function cleanupUI() {
    if (highlightDiv && highlightDiv.parentNode) {
        highlightDiv.parentNode.removeChild(highlightDiv);
        highlightDiv = null;
    }
    if (instructionDiv && instructionDiv.parentNode) {
        instructionDiv.parentNode.removeChild(instructionDiv);
        instructionDiv = null;
    }
}