function save_options() {
    const url = document.getElementById('appsScriptUrl').value;
    const moodleEmail = document.getElementById('moodleEmail').value;
    chrome.storage.sync.set({
        appsScriptUrl: url,
        moodleEmail: moodleEmail
    }, function() {
        const status = document.getElementById('status');
        status.textContent = 'Options saved.';
        setTimeout(() => { status.textContent = ''; }, 1500);
    });
}

function restore_options() {
    chrome.storage.sync.get({
        appsScriptUrl: '',
        moodleEmail: ''
    }, function(items) {
        document.getElementById('appsScriptUrl').value = items.appsScriptUrl;
        document.getElementById('moodleEmail').value = items.moodleEmail;
    });
}

document.addEventListener('DOMContentLoaded', restore_options);
document.getElementById('save').addEventListener('click', save_options);