/**
 * app.js — Main application controller for Project Nana.
 * Wires together the API client, Chat UI, sidebar, and screenshot logic.
 */

// ─── State ───────────────────────────────────────────────────────────────────
let currentConversationId = null;
let pendingScreenshot = null;  // base64 string of attached screenshot

// ─── DOM References ──────────────────────────────────────────────────────────
const messageInput = document.getElementById('messageInput');
const btnSend = document.getElementById('btnSend');
const btnNewChat = document.getElementById('btnNewChat');
const btnToggleSidebar = document.getElementById('btnToggleSidebar');
const screenshotPreview = document.getElementById('screenshotPreview');
const screenshotImage = document.getElementById('screenshotImage');
const btnRemoveScreenshot = document.getElementById('btnRemoveScreenshot');
const conversationList = document.getElementById('conversationList');
const chatTitle = document.getElementById('chatTitle');
const sidebar = document.getElementById('sidebar');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const imageInput = document.getElementById('imageInput');
const ggufInput = document.getElementById('ggufInput');

// Model Picker DOM
const btnModelSelect = document.getElementById('btnModelSelect');
const selectedModelText = document.getElementById('selectedModelText');
const modelPickerPopover = document.getElementById('modelPickerPopover');
const modelSearchInput = document.getElementById('modelSearchInput');
const modelPickerList = document.getElementById('modelPickerList');
let availableModelsList = [];
let currentSelectedModel = null;

const noModelBanner = document.getElementById('noModelBanner');

function updateNoModelBanner(show) {
    if (!noModelBanner) return;
    if (show) noModelBanner.classList.remove('hidden');
    else noModelBanner.classList.add('hidden');
}

/**
 * Called when model list changes (from Model manager or initial load).
 */
window.onModelsListUpdated = function (models, settings) {
    const list = models || [];
    const chatModels = list.filter((m) => m.modelType !== 'vision');
    availableModelsList = chatModels.map((m) => ({
        id: m.relativePath,
        name: m.displayName || m.fileName,
        runtime: 'standalone',
        size: m.size,
        quantization: m.quantization,
        modelType: m.modelType || 'chat',
        pathLabel: m.packagePath || m.relativePath,
        available: m.available,
    }));

    updateNoModelBanner(chatModels.length === 0);

    const saved = localStorage.getItem('selectedModel');
    if (saved && chatModels.some((m) => m.relativePath === saved)) {
        selectModel(saved);
    } else if (settings && settings.defaultModelPath && chatModels.some((m) => m.relativePath === settings.defaultModelPath)) {
        selectModel(settings.defaultModelPath);
    } else if (chatModels.length === 1) {
        selectModel(chatModels[0].relativePath);
    } else if (chatModels.length > 0) {
        selectModel(chatModels[0].relativePath);
    } else {
        currentSelectedModel = null;
        localStorage.removeItem('selectedModel');
        if (selectedModelText) {
            selectedModelText.textContent = 'No model';
        }
    }
    renderModelList(modelSearchInput ? modelSearchInput.value : '');
};

window.onModelLoaded = function (rel) {
    selectModel(rel);
};

window.onModelUnloaded = function () {
    checkStatus();
};

// ─── Initialize ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    ChatUI.init();
    ChatUI.showWelcome();
    checkStatus();
    loadModels();
    loadConversations();
    setupEventListeners();

    // Poll status every 30 seconds
    setInterval(checkStatus, 30000);
    
    // Initial button state
    if (window.updateSendButtonState) window.updateSendButtonState();

    // Initialize view routing
    if (window.setView) window.setView("chat");
});

function setupEventListeners() {
    // Send message
    btnSend.addEventListener('click', sendMessage);

    // Enter to send, Shift+Enter for newline
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Update send button state
    window.updateSendButtonState = function() {
        if (messageInput.value.trim() || pendingScreenshot) {
            btnSend.disabled = false;
        } else {
            btnSend.disabled = true;
        }
    };

    // Auto-resize textarea
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
        window.updateSendButtonState();
    });

    // New chat
    btnNewChat.addEventListener('click', startNewChat);

    // Toggle sidebar
    btnToggleSidebar.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
    });

    // Search chats
    const searchChatsInput = document.getElementById('searchChatsInput');
    if (searchChatsInput) {
        searchChatsInput.addEventListener('input', () => {
            renderConversationList(window.allConversations || []);
        });
    }

    // Remove screenshot
    btnRemoveScreenshot.addEventListener('click', removeScreenshot);

    // Keyboard shortcut: Ctrl+Shift+S for screenshot
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'S') {
            e.preventDefault();
            captureAndSend();
        }
    });

    // Model Picker Events
    if (btnModelSelect) {
        btnModelSelect.addEventListener('click', (e) => {
            e.stopPropagation();
            modelPickerPopover.classList.toggle('hidden');
            if (!modelPickerPopover.classList.contains('hidden')) {
                modelSearchInput.value = '';
                modelSearchInput.focus();
                renderModelList();
            }
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (!btnModelSelect.contains(e.target) && !modelPickerPopover.contains(e.target)) {
                modelPickerPopover.classList.add('hidden');
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modelPickerPopover.classList.contains('hidden')) {
                modelPickerPopover.classList.add('hidden');
                btnModelSelect.focus();
            }
        });

        // Search filter
        modelSearchInput.addEventListener('input', () => {
            renderModelList(modelSearchInput.value);
        });
    }

    // Image upload from file
    if (imageInput) {
        imageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleImageFile(file);
            imageInput.value = ''; // Reset
        });
    }

    // GGUF Import
    if (ggufInput) {
        ggufInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            // In electron, file.path contains absolute path
            const filePath = file.path || file.name; 
            
            try {
                // Show loading state
                const importBtn = ggufInput.parentElement;
                const oldContent = importBtn.innerHTML;
                importBtn.innerHTML = '⏳ Importing...';
                
                await NanaAPI.importModel(filePath);
                await loadModels();
                
                importBtn.innerHTML = oldContent;
                alert("Model imported successfully!");
            } catch (err) {
                alert("Failed to import model: " + err.message);
                const importBtn = ggufInput.parentElement;
                importBtn.innerHTML = `<input type="file" id="ggufInput" accept=".gguf" style="display:none;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Import .gguf Model`;
            }
            ggufInput.value = '';
        });
    }

    // Paste image support
    window.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) handleImageFile(file);
                break; // Handle first image only
            }
        }
    });
}

function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const base64 = e.target.result.split(',')[1]; // Remove data URL prefix
        pendingScreenshot = base64;
        screenshotImage.src = e.target.result;
        screenshotPreview.style.display = 'inline-block';
        messageInput.focus();
        if (!messageInput.value) {
            messageInput.placeholder = 'Ask about this image...';
        }
        if (window.updateSendButtonState) window.updateSendButtonState();
    };
    reader.readAsDataURL(file);
}

// ─── Send Message ────────────────────────────────────────────────────────────
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message && !pendingScreenshot) return;
    if (ChatUI.isStreaming) return;

    const displayMessage = message || '📸 Analyze this screenshot';

    if (window.activeView === 'station' && window.Station && typeof window.Station.handleChatSend === 'function') {
        await sendStationMessage(displayMessage);
        return;
    }

    // Show user message in chat
    ChatUI.addMessage('user', displayMessage, pendingScreenshot);

    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';
    if (window.updateSendButtonState) window.updateSendButtonState();

    // Start streaming assistant response
    const stream = ChatUI.startStream();

    // Build request
    const params = {
        message: displayMessage,
        conversation_id: currentConversationId,
        model: currentSelectedModel
    };
    
    if (window.Workspace) {
        const ctx = Workspace.getContextForAI();
        if (ctx) {
            params.workspace_context = ctx;
        }
    }

    if (pendingScreenshot) {
        params.image_base64 = pendingScreenshot;
        removeScreenshot();
    }

    // Call API with SSE streaming
    await NanaAPI.chat(
        params,
        // onToken
        (token) => {
            stream.append(token);
        },
        // onDone
        (convId) => {
            const rawContent = stream.finish();
            currentConversationId = convId;
            btnSend.disabled = false;
            messageInput.focus();
            loadConversations(); // Refresh sidebar
            
            // Intercept Agent Tags here
            if (window.AgentLoop) {
                window.AgentLoop.handleToolCalls(rawContent);
            }
        },
        // onError
        (error) => {
            stream.append(`\n\n⚠️ Error: ${error}`);
            stream.finish();
            btnSend.disabled = false;
        }
    );
}

// ─── Screenshot ──────────────────────────────────────────────────────────────
async function sendStationMessage(displayMessage) {
    const imageBase64 = pendingScreenshot;

    ChatUI.addMessage('user', displayMessage, imageBase64);

    messageInput.value = '';
    messageInput.style.height = 'auto';
    if (imageBase64) removeScreenshot();
    if (window.updateSendButtonState) window.updateSendButtonState();

    const stream = ChatUI.startStream();
    btnSend.disabled = true;

    try {
        const summary = await window.Station.handleChatSend({
            prompt: displayMessage,
            imageBase64,
        });
        stream.append(summary || 'Station finished without a final answer.');
        stream.finish();
    } catch (e) {
        stream.append(`\n\nâš ï¸ Station error: ${e.message}`);
        stream.finish();
    } finally {
        btnSend.disabled = false;
        messageInput.focus();
        if (window.updateSendButtonState) window.updateSendButtonState();
        checkStatus();
    }
}

async function captureAndSend() {
    try {
        const result = await NanaAPI.captureScreenshot();

        if (result.error) {
            alert('Screenshot failed: ' + result.error);
            return;
        }

        pendingScreenshot = result.image_base64;
        screenshotImage.src = `data:image/png;base64,${result.image_base64}`;
        screenshotPreview.style.display = 'inline-block';

        // Focus input so user can add a message
        messageInput.focus();
        messageInput.placeholder = 'Ask about this screenshot...';
        if (window.updateSendButtonState) window.updateSendButtonState();
    } catch (e) {
        alert('Screenshot capture failed: ' + e.message);
    }
}

function removeScreenshot() {
    pendingScreenshot = null;
    screenshotPreview.style.display = 'none';
    screenshotImage.src = '';
    messageInput.placeholder = 'Ask Nana anything...';
    if (window.updateSendButtonState) window.updateSendButtonState();
}

// ─── Conversations ───────────────────────────────────────────────────────────
async function loadConversations() {
    try {
        const data = await NanaAPI.listConversations();
        window.allConversations = data.conversations || [];
        renderConversationList(window.allConversations);
    } catch (e) {
        console.error('Failed to load conversations:', e);
    }
}

function renderConversationList(conversations) {
    const query = (document.getElementById('searchChatsInput')?.value || '').toLowerCase();
    const filtered = conversations.filter(conv => (conv.title || '').toLowerCase().includes(query));

    conversationList.innerHTML = '';

    if (filtered.length === 0) {
        conversationList.innerHTML = '<p style="padding:16px;color:var(--text-muted);font-size:12px;text-align:center;">No conversations found</p>';
        return;
    }

    filtered.forEach(conv => {
        const el = document.createElement('div');
        el.className = `conv-item ${conv.id === currentConversationId ? 'active' : ''}`;
        el.innerHTML = `
            <span class="conv-title">${escapeHtml(conv.title)}</span>
            <button class="conv-delete" title="Delete" onclick="event.stopPropagation(); deleteConv('${conv.id}')">🗑</button>
        `;
        el.addEventListener('click', () => loadConversation(conv.id));
        conversationList.appendChild(el);
    });
}

async function loadConversation(id) {
    try {
        const data = await NanaAPI.getConversation(id);
        currentConversationId = id;
        ChatUI.loadMessages(data.messages || []);
        chatTitle.textContent = data.messages?.[0]?.content?.slice(0, 50) || 'Chat';
        loadConversations(); // Refresh active state
        if (window.setView) {
            window.setView("chat");
        }
        if (window.Station && typeof window.Station.loadSession === 'function') {
            window.Station.loadSession(id);
        }
    } catch (e) {
        console.error('Failed to load conversation:', e);
    }
}

async function deleteConv(id) {
    if (!confirm('Delete this conversation?')) return;
    await NanaAPI.deleteConversation(id);
    if (currentConversationId === id) {
        startNewChat();
    }
    loadConversations();
}

function startNewChat() {
    currentConversationId = null;
    chatTitle.textContent = 'New Chat';
    ChatUI.clear();
    ChatUI.showWelcome();
    removeScreenshot();
    if (window.Station && typeof window.Station.clearLog === 'function') {
        window.Station.clearLog();
    }
    messageInput.focus();
    loadConversations();
    if (window.setView) {
        window.setView("chat");
    }
}

// ─── Status ──────────────────────────────────────────────────────────────────
async function checkStatus() {
    try {
        const status = await NanaAPI.getStatus();
        if (!status.standalone_available) {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'Runtime unavailable';
        } else if (!status.model_count) {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'No GGUF models';
        } else if (status.standalone_loaded) {
            statusDot.className = 'status-dot online';
            statusText.textContent = 'Local model loaded';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'Ready (no model loaded)';
        }
    } catch {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Backend offline';
    }
}

async function loadModels() {
    try {
        await NanaAPI.scanModels();
        const data = await NanaAPI.getModels();
        if (typeof window.onModelsListUpdated === 'function') {
            window.onModelsListUpdated(data.models || [], data.settings || {});
        }
    } catch (e) {
        console.error('Failed to load models:', e);
        updateNoModelBanner(true);
    }
}

function renderModelList(filter = '') {
    if (!modelPickerList) return;
    modelPickerList.innerHTML = '';
    
    const term = filter.toLowerCase();
    const filtered = availableModelsList.filter(
        (m) => m.name.toLowerCase().includes(term) || m.id.toLowerCase().includes(term)
    );

    if (filtered.length === 0) {
        modelPickerList.innerHTML =
            '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px;">No models found</div>';
        return;
    }

    filtered.forEach((modelObj) => {
        let displayName = modelObj.name;
        if (modelObj.modelType !== 'vision') {
            if (modelObj.id.toLowerCase().includes('3b')) displayName = '3B weight';
            else if (modelObj.id.toLowerCase().includes('7b')) displayName = '7B weight';
        }

        const runtimeTag = modelObj.modelType === 'vision'
            ? '<span style="background:var(--accent);color:#fff;padding:2px 4px;border-radius:4px;font-size:9px;margin-left:4px;">VISION</span>'
            : '<span style="background:var(--accent);color:#fff;padding:2px 4px;border-radius:4px;font-size:9px;margin-left:4px;">GGUF</span>';

        const el = document.createElement('div');
        el.className = `model-picker-item ${modelObj.id === currentSelectedModel ? 'active' : ''}`;
        el.innerHTML = `
            <div class="model-item-info">
                <span class="model-item-name">${escapeHtml(displayName)} ${runtimeTag}</span>
                <span class="model-item-tag">${escapeHtml(modelObj.pathLabel || modelObj.id)}${modelObj.available ? ' - ready' : ''}</span>
            </div>
            <svg class="model-item-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        `;

        el.addEventListener('click', () => {
            selectModel(modelObj.id);
            modelPickerPopover.classList.add('hidden');
        });

        modelPickerList.appendChild(el);
    });
}

function selectModel(modelId) {
    if (!modelId) return;
    currentSelectedModel = modelId;
    localStorage.setItem('selectedModel', modelId);

    if (selectedModelText) {
        const modelObj = availableModelsList.find((m) => m.id === modelId);
        let displayName = modelObj ? modelObj.name : modelId;
        if (!modelObj || modelObj.modelType !== 'vision') {
            if (modelId.toLowerCase().includes('3b')) displayName = '3B weight';
            else if (modelId.toLowerCase().includes('7b')) displayName = '7B weight';
        }

        const title = modelObj && modelObj.modelType === 'vision' ? 'Local vision GGUF package' : 'Local GGUF';
        selectedModelText.innerHTML = `${escapeHtml(displayName)} <span title="${title}">⚡</span>`;
    }

    renderModelList(modelSearchInput ? modelSearchInput.value : '');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setPrompt(text) {
    messageInput.value = text;
    messageInput.focus();
    if (window.updateSendButtonState) window.updateSendButtonState();
}
window.setPrompt = setPrompt;
window.captureAndSend = captureAndSend;
window.getCurrentConversationId = () => currentConversationId;
window.setCurrentConversationId = (id) => {
    currentConversationId = id || null;
};
window.refreshConversations = loadConversations;

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Terminal Execution ──────────────────────────────────────────────────────
window.confirmRunCommand = function(btn, cmd) {
    // Prevent multiple clicks
    if (btn.disabled) return;
    
    // Check if already showing
    if (btn.nextElementSibling && btn.nextElementSibling.classList.contains('cmd-confirm')) {
        return;
    }
    
    const escapedCmd = cmd.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const confirmHtml = `
        <div class="cmd-confirm" style="margin-top: 8px; padding: 12px; background: rgba(255,0,0,0.1); border: 1px solid rgba(255,0,0,0.3); border-radius: 4px;">
            <p style="margin: 0 0 8px 0; font-size: 13px; color: #ff8888;">⚠️ Warning: This command will run on your local machine.</p>
            <div style="display: flex; gap: 8px;">
                <button onclick="window.executeCommand(this, '${escapedCmd}')" style="background: #e74c3c; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer;">Run command</button>
                <button onclick="this.parentElement.parentElement.remove()" style="background: transparent; color: inherit; border: 1px solid rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 4px; cursor: pointer;">Cancel</button>
            </div>
        </div>
    `;
    
    btn.insertAdjacentHTML('afterend', confirmHtml);
};

window.executeCommand = async function(btn, cmd) {
    const confirmBox = btn.parentElement.parentElement;
    confirmBox.innerHTML = '<p style="margin:0; font-size: 13px; color: var(--text-muted);">Executing command...</p>';
    
    try {
        const result = await NanaAPI.runCommand(cmd);
        const output = result.stdout || result.stderr || 'Command completed with no output.';
        confirmBox.innerHTML = `
            <div style="margin-top: 8px; background: #0f0f13; padding: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: pre-wrap; overflow-x: auto; color: #e2e8f0;">
                <div style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); color: ${result.exit_code === 0 ? '#4ade80' : '#f87171'}; font-weight: bold;">
                    Exit code: ${result.exit_code}
                </div>
                ${escapeHtml(output)}
            </div>
        `;
    } catch (e) {
        confirmBox.innerHTML = `<p style="margin:0; color: #f87171; font-size: 13px;">❌ Failed: ${escapeHtml(e.message)}</p>`;
    }
};

// ─── Routing / View State ───────────────────────────────────────────────────
window.activeView = "chat";

window.setView = function(view) {
    window.activeView = view;

    const chatArea = document.querySelector('.chat-area');
    const settingsPage = document.getElementById('settingsPage');
    const modelsPanel = document.getElementById('modelsPanel');
    const workspacePanel = document.getElementById('workspacePanel');
    const stationPage = document.getElementById('stationPage');

    // Default: hide everything
    if (chatArea) chatArea.classList.add('hidden');
    if (chatArea) chatArea.classList.remove('station-mode');
    if (settingsPage) settingsPage.classList.add('hidden');
    if (modelsPanel) {
        modelsPanel.classList.add('hidden');
        if (window.ModelsManager && typeof window.ModelsManager.stopStatusPolling === 'function') {
            window.ModelsManager.stopStatusPolling();
        }
    }
    if (workspacePanel) workspacePanel.classList.add('hidden');
    if (stationPage) stationPage.classList.add('hidden');

    // Remove active styles from sidebar buttons
    document.getElementById('btnToggleSettings')?.classList.remove('active');
    document.getElementById('btnToggleModels')?.classList.remove('active');
    document.getElementById('btnToggleWorkspace')?.classList.remove('active');
    document.getElementById('btnToggleStation')?.classList.remove('active');

    if (view === "chat") {
        if (chatArea) chatArea.classList.remove('hidden');
    } else if (view === "settings") {
        if (settingsPage) settingsPage.classList.remove('hidden');
        document.getElementById('btnToggleSettings')?.classList.add('active');
        if (window.SettingsManager && typeof window.SettingsManager.loadAll === 'function') {
            window.SettingsManager.loadAll();
        }
    } else if (view === "models") {
        if (chatArea) chatArea.classList.remove('hidden');
        if (modelsPanel) {
            modelsPanel.classList.remove('hidden');
            if (window.ModelsManager) {
                if (typeof window.ModelsManager.refresh === 'function') window.ModelsManager.refresh();
                if (typeof window.ModelsManager.startStatusPolling === 'function') window.ModelsManager.startStatusPolling();
            }
        }
        document.getElementById('btnToggleModels')?.classList.add('active');
    } else if (view === "workspace") {
        if (chatArea) chatArea.classList.remove('hidden');
        if (workspacePanel) {
            workspacePanel.classList.remove('hidden');
            if (window.Workspace && typeof window.Workspace.refreshStatus === 'function') {
                window.Workspace.refreshStatus();
            }
        }
        document.getElementById('btnToggleWorkspace')?.classList.add('active');
    } else if (view === "station") {
        if (chatArea) {
            chatArea.classList.remove('hidden');
            chatArea.classList.add('station-mode');
        }
        if (stationPage) {
            stationPage.classList.remove('hidden');
            if (window.Station && typeof window.Station.onActivate === 'function') {
                window.Station.onActivate();
            }
        }
        document.getElementById('btnToggleStation')?.classList.add('active');
    }
};
