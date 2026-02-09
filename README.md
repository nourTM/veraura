# VeraAura: Lab Guide

VeraAura is a Chrome browser extension designed to provide interactive, step-by-step guidance for completing online labs, particularly for AI and Cloud platforms. It overlays instructions and highlights directly onto the web page, guiding the user through a series of actions and automatically advancing as they complete each step.

## ✨ Features

- **Interactive Guides**: Overlays instructions directly on the target webpage, eliminating the need to switch between tabs.
- **Dynamic Highlighting**: Draws attention to the correct HTML element for each step with an animated, pulsing highlight.
- **Smart Instructions**: Displays a tooltip with instructions that intelligently repositions itself to stay visible on the screen.
- **Automatic Progression**: Automatically detects when a user completes an action (e.g., a click or text input) and moves to the next step.
- **State Persistence**: Remembers your progress on a task, even if you reload the page or close the extension popup.
- **Configurable Tasks**: New labs and guides can be easily created by defining them in a simple JSON format.

## 🚀 How It Works

The extension is built on three core components:

1.  **Popup (`popup.js`)**: The main user interface where a user can select which lab or task they want to start. It manages the overall state, such as the current task and step number.
2.  **Content Script (`content.js`)**: This script is injected into the webpage. It is responsible for displaying the visual guides (highlights and instructions) and listening for user actions to complete a step. It operates autonomously on the page to provide a seamless experience.
3.  **Task Definitions (`tasks.json`)**: A JSON file that contains the definitions for all available labs. Each task is a series of steps, and each step defines an instruction, a target element (`selector`), and the action required (`action_type`).

## 🛠️ Getting Started

To install and run the extension locally in developer mode:

1.  Clone or download this repository to your local machine.
2.  Open the Google Chrome browser and navigate to `chrome://extensions`.
3.  Enable the **Developer mode** toggle in the top-right corner.
4.  Click the **Load unpacked** button.
5.  Select the directory where you saved the project.
6.  The "VeraAura: Lab Guide" extension will now appear in your extensions list and be ready to use!

## 📝 Creating New Tasks

You can easily add new guided labs by editing the `tasks.json` file.

### Task Structure

Each task is an object with a unique ID (e.g., `"vertex_lab_01"`) and contains a `title` and an array of `steps`.

```json
{
  "your_task_id": {
    "title": "Title of Your New Lab",
    "steps": [
      // ... array of step objects
    ]
  }
}
```

### Step Structure

Each object in the `steps` array defines a single action for the user to take.

| Key                  | Description                                                                                           | Example                        |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| `id`                 | A unique number for the step.                                                                         | `1`                            |
| `instruction`        | The text displayed to the user in the instruction tooltip.                                            | `"Click the 'Submit' button."` |
| `action_type`        | The type of user interaction to listen for. Supported types: `"click"`, `"text_match"`.               | `"click"`                      |
| `selector`           | The CSS selector used to find the element the user must interact with (e.g., for attaching an event). | `"#submit-btn"`                |
| `highlight_selector` | The CSS selector for the element to draw the highlight around. Often the same as `selector`.          | `"#submit-btn"`                |
| `expected`           | **Required for `text_match`**. The exact string the user must type for the step to be complete.       | `"Artificial Intelligence"`    |

### Example Step

This step instructs the user to type 'Artificial Intelligence' into a text area.

```json
{
  "id": 2,
  "instruction": "Type 'Artificial Intelligence' in the prompt box.",
  "action_type": "text_match",
  "selector": "#prompt-input",
  "expected": "Artificial Intelligence",
  "highlight_selector": "#prompt-input"
}
```
