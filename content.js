console.log("VeraAura: Script Loaded on Page");

let currentTask = null;
let currentStepIndex = -1;
let highlightDiv = null;
let instructionDiv = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_TASK") {
        currentTask = request.task;
        currentStepIndex = request.stepIndex;
        cleanupUI(); // Clean up any previous elements
        startMonitoringStep();
        sendResponse({ success: true });
    } else if (request.action === "STOP_TASK") {
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
    const targetElement = document.querySelector(step.selector);

    if (!targetElement) {
        // If element not present, wait for it to appear
        const observer = new MutationObserver((mutations, obs) => {
            if (document.querySelector(step.selector)) {
                obs.disconnect(); // Stop observing
                startMonitoringStep(); // Retry setting up the listener
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return;
    }

    // Create visual guides
    createVisualGuides(step);

    switch (step.action_type) {
        case 'click': {
            // The 'once' option automatically removes the listener after it fires.
            const clickListener = () => handleStepCompletion();
            targetElement.addEventListener('click', clickListener, { once: true });
            break;
        }
        case 'text_match': {
            // This listener will remove itself once the condition is met to prevent loops.
            const textMatchListener = (event) => {
                if (targetElement.value.trim().toLowerCase() === step.expected.toLowerCase()) {
                    targetElement.removeEventListener('input', textMatchListener);
                    targetElement.removeEventListener('change', textMatchListener);
                    handleStepCompletion();
                }
            };
            targetElement.addEventListener('input', textMatchListener);
            targetElement.addEventListener('change', textMatchListener);
            break;
        }
    }
}

function handleStepCompletion() {
    console.log(`VeraAura: Step ${currentStepIndex + 1} completed.`);
    cleanupUI(); // Clean up visual guides.

    currentStepIndex++;

    // The content script is the source of truth for step progression.
    // It always updates the storage.
    chrome.storage.local.set({ storedStepIndex: currentStepIndex });

    // Notify the popup that a step was completed so it can update its UI if open.
    chrome.runtime.sendMessage({ action: "STEP_COMPLETED" }, (response) => {
        if (chrome.runtime.lastError) {
            console.log("VeraAura: Popup not listening, but state was saved.");
        }
    });

    if (currentStepIndex >= currentTask.steps.length) {
        console.log("VeraAura: Task finished on page.");
        // The popup's `markAsDone` will handle clearing storage. We just stop.
        currentTask = null;
        currentStepIndex = -1;
    } else {
        // Start monitoring the new, current step immediately.
        console.log(`VeraAura: Advancing to step ${currentStepIndex + 1}`);
        startMonitoringStep();
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

    const highlightElement = document.querySelector(step.highlight_selector);
    if (!highlightElement) return;

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
    highlightDiv.style.zIndex = '9998';
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
    instructionDiv.style.zIndex = '9999';
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