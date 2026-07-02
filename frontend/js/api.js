/**
 * api.js — Backend API client for Project Nana.
 * Handles all HTTP requests and SSE streaming to the FastAPI backend.
 */

const API_BASE = '';  // Same origin, no prefix needed

// Intercept all fetches to automatically attach X-Nana-Token if available
(function() {
    const originalFetch = window.fetch;
    let cachedToken = null;
    
    async function getApiToken() {
        if (cachedToken) return cachedToken;
        if (window.nanaDesktop && typeof window.nanaDesktop.getToken === 'function') {
            try {
                cachedToken = await window.nanaDesktop.getToken();
            } catch (e) {
                console.error("Failed to fetch API token via preload:", e);
            }
        }
        return cachedToken;
    }

    window.fetch = async function(resource, options = {}) {
        const urlStr = typeof resource === 'string' ? resource : (resource && resource.url);
        if (urlStr && urlStr.includes('/api/')) {
            const token = await getApiToken();
            if (token) {
                options.headers = options.headers || {};
                if (options.headers instanceof Headers) {
                    options.headers.set('X-Nana-Token', token);
                } else if (Array.isArray(options.headers)) {
                    if (!options.headers.some(h => h[0].toLowerCase() === 'x-nana-token')) {
                        options.headers.push(['X-Nana-Token', token]);
                    }
                } else {
                    options.headers['X-Nana-Token'] = token;
                }
            }
        }
        return originalFetch(resource, options);
    };
})();

const NanaAPI = {
    /**
     * Send a chat message and stream the response via SSE.
     * @param {Object} params - { message, conversation_id?, image_base64? }
     * @param {Function} onToken - Called with each token string
     * @param {Function} onDone - Called when generation completes, with conversation_id
     * @param {Function} onError - Called on error
     */
    async chat(params, onToken, onDone, onError) {
        try {
            const response = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.done) {
                                onDone(data.conversation_id);
                            } else if (data.token) {
                                onToken(data.token, data.model);
                            }
                        } catch (e) {
                            // Skip malformed JSON
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Chat API error:', error);
            onError(error.message);
        }
    },

    /**
     * Capture a screenshot from the backend (using mss).
     * @returns {Object} { image_base64, width, height } or { error }
     */
    async captureScreenshot() {
        const resp = await fetch(`${API_BASE}/api/screenshot/capture`, { method: 'POST' });
        return resp.json();
    },

    /**
     * Backend + local runtime status.
     */
    async getStatus() {
        const resp = await fetch(`${API_BASE}/api/status`);
        return resp.json();
    },

    /**
     * Get available models (uses last server scan).
     */
    async getModels() {
        const resp = await fetch(`${API_BASE}/api/models`);
        return resp.json();
    },

    /** Rescan models directory recursively. */
    async scanModels() {
        const resp = await fetch(`${API_BASE}/api/models/scan`, { method: 'POST' });
        if (!resp.ok) {
            const t = await resp.text();
            throw new Error(t || 'Scan failed');
        }
        return resp.json();
    },

    /** Load a GGUF into RAM (relative path under models/, e.g. qwen/model.gguf). */
    async loadModel(modelPath) {
        const resp = await fetch(`${API_BASE}/api/models/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_path: modelPath }),
        });
        if (!resp.ok) {
            let detail = await resp.text();
            try {
                const j = JSON.parse(detail);
                detail = j.detail || detail;
            } catch (_) { /* ignore */ }
            throw new Error(detail || 'Load failed');
        }
        return resp.json();
    },

    async unloadModel() {
        const resp = await fetch(`${API_BASE}/api/models/unload`, { method: 'POST' });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async getCurrentModel() {
        const resp = await fetch(`${API_BASE}/api/models/current`);
        return resp.json();
    },

    /** Open models folder in OS file manager (backend). */
    async openModelsFolderBackend() {
        const resp = await fetch(`${API_BASE}/api/models/open-folder`, { method: 'POST' });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async setDefaultModel(modelPath) {
        const resp = await fetch(`${API_BASE}/api/models/default`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_path: modelPath }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    /**
     * Import a .gguf model
     */
    async importModel(filePath) {
        const resp = await fetch(`${API_BASE}/api/models/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: filePath }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Import failed');
        }
        return resp.json();
    },

    /**
     * Execute a command safely.
     */
    async runCommand(command) {
        const resp = await fetch(`${API_BASE}/api/run-command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Command execution failed');
        }
        return resp.json();
    },

    /**
     * List all conversations.
     * @returns {Object} { conversations: [...] }
     */
    async listConversations() {
        const resp = await fetch(`${API_BASE}/api/conversations`);
        return resp.json();
    },

    /**
     * Get messages for a specific conversation.
     * @param {string} id - Conversation ID
     * @returns {Object} { conversation_id, messages: [...] }
     */
    async getConversation(id) {
        const resp = await fetch(`${API_BASE}/api/conversations/${id}`);
        return resp.json();
    },

    /**
     * Delete a conversation.
     * @param {string} id - Conversation ID
     */
    async deleteConversation(id) {
        await fetch(`${API_BASE}/api/conversations/${id}`, { method: 'DELETE' });
    },

    // ─── Workspace ───────────────────────────────────────────────────────────
    async openWorkspace(path) {
        const resp = await fetch(`${API_BASE}/api/workspace/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async getWorkspaceStatus() {
        const resp = await fetch(`${API_BASE}/api/workspace/status`);
        return resp.json();
    },

    async getWorkspaceTree() {
        const resp = await fetch(`${API_BASE}/api/workspace/tree`);
        return resp.json();
    },

    async getFile(path) {
        const resp = await fetch(`${API_BASE}/api/workspace/file?path=${encodeURIComponent(path)}`);
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async updateFile(path, content) {
        const resp = await fetch(`${API_BASE}/api/workspace/file/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content })
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async createFile(path, content = "", isDir = false) {
        const resp = await fetch(`${API_BASE}/api/workspace/file/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content, is_dir: isDir })
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async openVsCode() {
        const resp = await fetch(`${API_BASE}/api/workspace/open-editor`, { method: 'POST' });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async searchFiles(query) {
        const resp = await fetch(`${API_BASE}/api/workspace/file/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async runTerminalCommand(command) {
        const resp = await fetch(`${API_BASE}/api/terminal/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async stopTerminalCommand(taskId) {
        const resp = await fetch(`${API_BASE}/api/terminal/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_id: taskId })
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async getTerminalStatus(taskId) {
        const resp = await fetch(`${API_BASE}/api/terminal/status/${taskId}`);
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async getModelSources() {
        const resp = await fetch(`${API_BASE}/api/models/sources`);
        return resp.json();
    },

    async pullModel(modelId) {
        const resp = await fetch(`${API_BASE}/api/models/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_id: modelId }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Pull failed');
        }
        return resp.json();
    },

    async getPullStatus() {
        const resp = await fetch(`${API_BASE}/api/models/pull/status`);
        return resp.json();
    },

    async cancelPullModel(modelId) {
        const resp = await fetch(`${API_BASE}/api/models/pull/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_id: modelId }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Cancel failed');
        }
        return resp.json();
    },

    async getSettings() {
        const resp = await fetch(`${API_BASE}/api/models/settings`);
        return resp.json();
    },

    async updateSettings(settings) {
        const resp = await fetch(`${API_BASE}/api/models/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async getUserMemory() {
        const resp = await fetch(`${API_BASE}/api/memory/user`);
        return resp.json();
    },

    async updateUserMemory(memory) {
        const resp = await fetch(`${API_BASE}/api/memory/user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(memory),
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async clearUserMemory() {
        const resp = await fetch(`${API_BASE}/api/memory/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    // ─── Native / Recent Workspaces ──────────────────────────────────────────
    async selectFolder() {
        const resp = await fetch(`${API_BASE}/api/workspace/select-folder`, { method: 'POST' });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async getRecentProjects() {
        const resp = await fetch(`${API_BASE}/api/workspace/recent`);
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },

    async closeWorkspace() {
        const resp = await fetch(`${API_BASE}/api/workspace/close`, { method: 'POST' });
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json();
    },
};
