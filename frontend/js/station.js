/**
 * station.js - Station side panel and sequential council runner.
 */

const Station = {
    isRunning: false,
    restoreModelPath: null,
    logCounter: 0,
    models: [],
    councilModels: [],
    modelCardMap: {},
    idleTimer: null,

    AVATAR_COLORS: [
        '#7c6aef', '#60a5fa', '#34d399', '#f472b6',
        '#fbbf24', '#a78bfa', '#fb923c', '#38bdf8',
        '#4ade80', '#e879f9', '#f87171', '#2dd4bf',
    ],

    init() {
        const btn = document.getElementById('btnToggleStation');
        if (btn) {
            btn.addEventListener('click', () => window.setView('station'));
        }
    },

    async onActivate() {
        await this.loadModelCards();
        const conversationId = window.getCurrentConversationId ? window.getCurrentConversationId() : null;
        if (conversationId) await this.loadSession(conversationId);
        this._showGreeting();
        this._scheduleIdleOffline();
    },

    _showGreeting() {
        const log = document.getElementById('stationLog');
        if (!log || log.querySelector('.station-log-entry')) return;
        const welcome = log.querySelector('.station-welcome');
        if (welcome) {
            const p = welcome.querySelector('p');
            if (p) p.textContent = 'Send from the normal chat box to wake each downloaded text model one by one.';
        }
    },

    async loadModelCards() {
        const list = document.getElementById('stationModelsList');
        if (!list) return;

        try {
            const data = await NanaAPI.getModels();
            this.models = (data.models || []).filter((m) => this._isPanelModel(m));
            this.councilModels = this.models.filter((m) => this._isCouncilModel(m));
            this.modelCardMap = {};
            list.innerHTML = '';

            if (this.models.length === 0) {
                list.innerHTML = '<p class="station-no-models">No downloaded models found.</p>';
                return;
            }

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.classList.add('station-avatar-lines');
            svg.setAttribute('viewBox', '0 0 100 100');
            svg.setAttribute('preserveAspectRatio', 'none');
            const cols = Math.min(6, Math.max(1, this.models.length));
            for (let i = 0; i < Math.max(0, this.models.length - 1); i++) {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', 10 + (i % cols) * (80 / Math.max(1, cols - 1)));
                line.setAttribute('y1', 28 + Math.floor(i / cols) * 32);
                line.setAttribute('x2', 10 + ((i + 1) % cols) * (80 / Math.max(1, cols - 1)));
                line.setAttribute('y2', 28 + Math.floor((i + 1) / cols) * 32);
                svg.appendChild(line);
            }
            list.appendChild(svg);

            this.models.forEach((model, index) => {
                const card = this._renderModelCard(model, index);
                list.appendChild(card);
                this.modelCardMap[model.relativePath] = card;
            });
        } catch (e) {
            list.innerHTML = '<p class="station-no-models">Error loading models.</p>';
        }
    },

    _isPanelModel(model) {
        const type = (model.modelType || 'chat').toLowerCase();
        return model.available !== false && ['chat', 'text', 'reasoning', 'code'].includes(type);
    },

    _isCouncilModel(model) {
        const type = (model.modelType || 'chat').toLowerCase();
        const label = `${model.relativePath || ''} ${model.fileName || ''} ${model.displayName || ''}`.toLowerCase();
        return model.available !== false
            && ['chat', 'text', 'reasoning', 'code'].includes(type)
            && !label.includes('minicpm');
    },

    _renderModelCard(model, index) {
        const card = document.createElement('div');
        const isVision = (model.modelType || '').toLowerCase() === 'vision';
        const fullName = model.displayName || model.fileName || model.relativePath || 'Model';
        const shortName = this._shortModelTitle(model);
        card.className = `station-model-card ${isVision ? 'station-model-vision' : ''}`;
        card.setAttribute('data-path', model.relativePath);
        card.setAttribute('data-status', 'offline');
        card.title = fullName;

        const avatar = document.createElement('div');
        avatar.className = 'station-avatar';
        avatar.style.background = this.AVATAR_COLORS[index % this.AVATAR_COLORS.length];
        avatar.textContent = isVision ? 'V' : this._getInitials(shortName);

        const dot = document.createElement('span');
        dot.className = 'station-avatar-status offline';
        avatar.appendChild(dot);

        const info = document.createElement('div');
        info.className = 'station-model-info';

        const name = document.createElement('span');
        name.className = 'station-model-name';
        name.textContent = shortName;
        info.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'station-model-meta';

        const badge = document.createElement('span');
        badge.className = isVision
            ? 'station-badge station-badge-vision'
            : model.modelType === 'reasoning'
            ? 'station-badge station-badge-reasoning'
            : model.modelType === 'code'
            ? 'station-badge station-badge-code'
            : 'station-badge station-badge-text';
        badge.textContent = isVision ? 'VISION' : (model.modelType === 'reasoning' ? 'REASONING' : model.modelType === 'code' ? 'CODE' : 'TEXT');
        meta.appendChild(badge);

        const status = document.createElement('span');
        status.className = 'station-model-status-text';
        status.textContent = 'offline';
        meta.appendChild(status);

        info.appendChild(meta);
        card.appendChild(avatar);
        card.appendChild(info);
        return card;
    },

    async handleChatSend({ prompt, imageBase64 }) {
        if (this.isRunning) throw new Error('Station is already running.');
        this.isRunning = true;

        try {
            await this.loadModelCards();
            if (this.councilModels.length === 0) {
                throw new Error('No downloaded text, reasoning, or code models found.');
            }

            this.logCounter = 0;
            const log = document.getElementById('stationLog');
            if (log) log.innerHTML = '';
            this._clearIdleTimer();
            Object.keys(this.modelCardMap).forEach((path) => this._setCardStatus(path, 'offline', 'offline'));

            await this._rememberRestoreModel();
            this.appendLogEntry('You', 'prompt', this._escapeHtml(prompt), 'user');

            let visionContext = '';
            if (imageBase64 || this._promptMentionsImage(prompt)) {
                const imageLog = imageBase64 ? this.appendLogEntry('Vision', 'thinking', 'analyzing image...', 'system') : null;
                try {
                    const url = imageBase64 ? '/api/station/analyze-image' : '/api/station/vision-context';
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(imageBase64 ? { prompt, image_base64: imageBase64 } : { prompt }),
                    });
                    if (!resp.ok) throw new Error(await this._readError(resp));
                    const data = await resp.json();
                    visionContext = data.vision_context || '';
                    if (imageLog) {
                        document.getElementById(imageLog)?.remove();
                    }
                } catch (e) {
                    if (imageLog) {
                        this.updateLogEntry(imageLog, `Vision failed - ${this._escapeHtml(e.message)}`, 'error');
                    }
                }
            }

            const councilResponses = [];
            await this._runCouncilRound(prompt, visionContext, councilResponses, 1);
            if (councilResponses.length > 0) {
                await this._runCouncilRound(prompt, visionContext, councilResponses, 2);
            }

            if (councilResponses.length === 0) {
                throw new Error('No Station models replied.');
            }

            await this._restoreModel('Restoring Nana model for final vote...');
            this.councilModels.forEach((model) => {
                const card = this.modelCardMap[model.relativePath];
                if (card && card.classList.contains('done')) {
                    this._setCardStatus(model.relativePath, 'voting', 'voting');
                }
            });

            const voteId = this.appendLogEntry('Nana', 'voting', 'creating final summary...', 'vote');
            const voteResp = await fetch('/api/station/vote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, responses: councilResponses, vision_context: visionContext }),
            });
            if (!voteResp.ok) throw new Error(await this._readError(voteResp));

            const voteData = await voteResp.json();
            const summary = voteData.summary || '';
            this.updateLogEntry(voteId, this._escapeHtml(`Final decision: ${this._shortText(summary, 220)}`), 'speaking');
            this.councilModels.forEach((model) => {
                const card = this.modelCardMap[model.relativePath];
                if (card && card.classList.contains('voting')) {
                    this._setCardStatus(model.relativePath, 'done', 'done');
                }
            });
            await this._saveSession(prompt, imageBase64, visionContext, councilResponses, summary);
            return summary;
        } finally {
            await this._restoreModel();
            this.isRunning = false;
            this._scheduleIdleOffline();
        }
    },

    async _rememberRestoreModel() {
        this.restoreModelPath = null;
        try {
            const current = await NanaAPI.getCurrentModel();
            if (current && current.relativePath) {
                this.restoreModelPath = current.relativePath;
                return;
            }
        } catch (_) {}

        try {
            const settings = await NanaAPI.getSettings();
            this.restoreModelPath = settings.defaultModelPath || settings.lastLoadedModel || null;
        } catch (_) {}
    },

    async _restoreModel(message) {
        if (!this.restoreModelPath) return;
        try {
            const current = await NanaAPI.getCurrentModel();
            if (current && current.relativePath === this.restoreModelPath) return;
            if (message) this.appendLogEntry('Station', 'info', message, 'system');
            await NanaAPI.loadModel(this.restoreModelPath);
        } catch (e) {
            if (message) this.appendLogEntry('Station', 'error', `restore failed - ${this._escapeHtml(e.message)}`, 'system');
        }
    },

    _setCardStatus(modelPath, status, text) {
        const card = this.modelCardMap[modelPath];
        if (!card) return;

        card.classList.remove('offline', 'waking', 'thinking', 'speaking', 'done', 'replied', 'responded', 'voting', 'error');
        card.classList.add(status);
        card.setAttribute('data-status', status);

        const dot = card.querySelector('.station-avatar-status');
        if (dot) dot.className = 'station-avatar-status ' + status;

        const statusText = card.querySelector('.station-model-status-text');
        if (statusText) statusText.textContent = text || status;
    },

    _scheduleIdleOffline() {
        this._clearIdleTimer();
        this.idleTimer = setTimeout(async () => {
            if (this.isRunning) return;
            Object.keys(this.modelCardMap).forEach((path) => this._setCardStatus(path, 'offline', 'offline'));
            await this._restoreModel();
        }, 60000);
    },

    _clearIdleTimer() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    },

    async _sleepCouncilModel(modelPath) {
        try {
            const current = await NanaAPI.getCurrentModel();
            if (current && current.relativePath === modelPath) {
                await NanaAPI.unloadModel();
            }
        } catch (_) {}
    },

    async _runCouncilRound(prompt, visionContext, councilResponses, round) {
        for (let index = 0; index < this.councilModels.length; index++) {
            const model = this.councilModels[index];
            const modelPath = model.relativePath;
            const modelName = this._shortModelTitle(model);
            const entryId = this.appendLogEntry(modelName, 'waking', `round ${round}: waking model...`, 'model');
            this._setCardStatus(modelPath, 'waking', 'waking');

            try {
                const askPrompt = this._buildCouncilPrompt(prompt, councilResponses, index, round);
                const resp = await fetch('/api/station/ask', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: askPrompt, model_path: modelPath, vision_context: visionContext }),
                });

                if (!resp.ok) throw new Error(await this._readError(resp));
                this.updateLogEntry(entryId, 'thinking...', 'thinking');
                this._setCardStatus(modelPath, 'thinking', 'thinking');

                const data = await resp.json();
                data.model_name = modelName;
                data.round = round;
                councilResponses.push(data);
                this.updateLogEntry(entryId, this._escapeHtml(this._formatModelLine(model, data, index, round)), 'speaking');
                this._setCardStatus(modelPath, 'speaking', 'speaking');
                await this._sleep(350);
                this._setCardStatus(modelPath, 'done', `done (${data.confidence}/10)`);
                await this._sleepCouncilModel(modelPath);
            } catch (e) {
                this.updateLogEntry(entryId, `error - ${this._escapeHtml(e.message)}`, 'error');
                this._setCardStatus(modelPath, 'error', 'error');
                await this._sleepCouncilModel(modelPath);
            }
        }
    },

    async _saveSession(prompt, imageBase64, visionContext, councilResponses, summary) {
        try {
            const selectedModels = this.councilModels.map((model) => ({
                name: this._shortModelTitle(model),
                relativePath: model.relativePath,
                modelType: model.modelType || 'chat',
            }));
            let resp = await fetch('/api/conversations/station', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversation_id: window.getCurrentConversationId ? window.getCurrentConversationId() : null,
                    prompt,
                    has_image: Boolean(imageBase64),
                    vision_summary: visionContext || '',
                    responses: councilResponses,
                    final_summary: summary,
                    selected_models: selectedModels,
                }),
            });
            if (resp.status === 404) {
                resp = await fetch('/api/station/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversation_id: window.getCurrentConversationId ? window.getCurrentConversationId() : null,
                        prompt,
                        has_image: Boolean(imageBase64),
                        vision_summary: visionContext || '',
                        responses: councilResponses,
                        final_summary: summary,
                        selected_models: selectedModels,
                    }),
                });
            }
            if (!resp.ok) throw new Error(await this._readError(resp));
            const data = await resp.json();
            if (data.conversation_id && window.setCurrentConversationId) {
                window.setCurrentConversationId(data.conversation_id);
            }
            if (window.refreshConversations) window.refreshConversations();
        } catch (e) {
            this.appendLogEntry('Station', 'error', `save failed - ${this._escapeHtml(e.message)}`, 'system');
        }
    },

    async loadSession(conversationId) {
        if (!conversationId) return;
        try {
            let resp = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/station`);
            if (resp.status === 404) {
                resp = await fetch(`/api/station/session/${encodeURIComponent(conversationId)}`);
            }
            if (!resp.ok) return;
            const data = await resp.json();
            const sessions = data.sessions || [];
            if (sessions.length === 0) return;
            this.renderSavedSession(sessions[sessions.length - 1]);
        } catch (_) {}
    },

    renderSavedSession(session) {
        const log = document.getElementById('stationLog');
        if (!log || this.isRunning) return;
        log.innerHTML = '';
        this.logCounter = 0;
        this.appendLogEntry('You', 'prompt', this._escapeHtml(session.user_prompt || ''), 'user');
        if (session.vision_summary) {
            this.appendLogEntry('Vision', 'done', `Vision context: ${this._escapeHtml(this._shortText(session.vision_summary, 180))}`, 'system');
        }
        (session.responses || []).forEach((r) => {
            const round = r.round ? `R${r.round} ` : '';
            const line = `${round}${this._escapeHtml(this._shortText(r.opinion || r.raw || '', 180))}${r.confidence ? ` (${r.confidence}/10)` : ''}`;
            this.appendLogEntry(r.model_name || 'Model', 'done', line, 'model');
        });
        if (session.nana_final_summary) {
            this.appendLogEntry('Nana', 'speaking', `Final answer: ${this._escapeHtml(this._shortText(session.nana_final_summary, 240))}`, 'vote');
        }
    },

    clearLog() {
        const log = document.getElementById('stationLog');
        if (log) log.innerHTML = '';
        this.logCounter = 0;
    },

    _promptMentionsImage(prompt) {
        return /\b(image|picture|photo|screenshot|screen|visual|see|look at)\b/i.test(prompt || '');
    },

    _buildCouncilPrompt(prompt, responses, index, round) {
        if (round === 1 && (index === 0 || responses.length === 0)) {
            return (
                `${prompt}\n\n` +
                "You are the first council member. Briefly explain what the user is asking, then give your initial recommendation. Be blunt, honest, and useful. Keep it short."
            );
        }

        const previous = responses[responses.length - 1];
        const recent = responses
            .slice(-Math.min(4, responses.length))
            .map((r) => `- ${r.model_name}: ${this._shortText(r.opinion, 160)}`)
            .join('\n');
        if (round === 2) {
            return (
                `${prompt}\n\n` +
                `Round 1 and recent council notes:\n${recent}\n\n` +
                "This is round 2. Briefly respond again using previous opinions. Be direct. Call out weak reasoning if needed. Add only the strongest missing point or correction."
            );
        }

        return (
            `${prompt}\n\n` +
            `Previous council member (${previous.model_name}) said: ${this._shortText(previous.opinion, 180)}\n\n` +
            "Respond to the user request and the previous council member. Agree, refine, or disagree briefly. Be blunt and skip fake politeness."
        );
    },

    _formatModelLine(model, data, index, round) {
        const type = (model.modelType || '').toLowerCase();
        const prefix = round === 2
            ? 'Adding to the discussion,'
            : index === 0
            ? 'User seems to ask'
            : type === 'reasoning'
            ? 'I reason that'
            : (model.relativePath || '').toLowerCase().includes('coder')
            ? 'From code perspective,'
            : 'I think';
        return `${prefix} ${this._shortText(data.opinion || data.raw || '', 150)} (${data.confidence}/10)`;
    },

    _shortModelTitle(model) {
        const full = `${model.displayName || ''} ${model.fileName || ''} ${model.relativePath || ''}`.toLowerCase();
        if ((model.modelType || '').toLowerCase() === 'vision' || full.includes('minicpm')) return 'MiniCPM-V';
        if (full.includes('deepseek')) return 'DeepSeek R1';
        if (full.includes('gemma') && full.includes('9b')) return 'Gemma 9B';
        if (full.includes('llama') && full.includes('8b')) return 'Llama 8B';
        if (full.includes('qwen') && full.includes('coder') && full.includes('7b')) return 'Qwen Coder 7B';
        if (full.includes('qwen') && full.includes('3b')) return 'Qwen 3B';
        if (full.includes('qwen') && full.includes('7b')) return 'Qwen 7B';
        const name = (model.displayName || model.fileName || model.relativePath || 'Model').replace(/\.gguf$/i, '');
        return this._shortText(name.replace(/[-_/]+/g, ' '), 16);
    },

    _shortText(text, max) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (clean.length <= max) return clean;
        return clean.slice(0, max - 1).trimEnd() + '...';
    },

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    appendLogEntry(modelName, status, content, type) {
        const log = document.getElementById('stationLog');
        if (!log) return null;

        const id = 'station-entry-' + (++this.logCounter);
        const entry = document.createElement('div');
        entry.className = 'station-log-entry';
        entry.id = id;
        entry.setAttribute('data-status', status);
        entry.setAttribute('data-type', type);

        const nameEl = document.createElement('span');
        nameEl.className = 'station-entry-name';
        nameEl.textContent = `[${modelName}]`;

        const dot = document.createElement('span');
        dot.className = 'station-status-dot station-status-' + status;

        const contentEl = document.createElement('span');
        contentEl.className = 'station-entry-content';
        contentEl.innerHTML = content;

        entry.appendChild(nameEl);
        entry.appendChild(dot);
        entry.appendChild(contentEl);
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
        return id;
    },

    updateLogEntry(id, content, status) {
        const entry = document.getElementById(id);
        if (!entry) return;
        const contentEl = entry.querySelector('.station-entry-content');
        if (contentEl) contentEl.innerHTML = content;
        const dot = entry.querySelector('.station-status-dot');
        if (dot) dot.className = 'station-status-dot station-status-' + status;
        entry.setAttribute('data-status', status);

        const log = document.getElementById('stationLog');
        if (log) log.scrollTop = log.scrollHeight;
    },

    async _readError(resp) {
        const text = await resp.text();
        try {
            const data = JSON.parse(text);
            return data.detail || text || resp.statusText;
        } catch (_) {
            return text || resp.statusText;
        }
    },

    _getInitials(name) {
        const clean = name.replace(/\.gguf$/i, '').replace(/[-_/.]/g, ' ');
        const words = clean.split(/\s+/).filter(Boolean);
        if (words.length === 0) return 'M';
        if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
        return (words[0][0] + words[1][0]).toUpperCase();
    },

    _modelNameFromPath(path) {
        const parts = (path || '').replace(/\\/g, '/').split('/');
        return (parts[parts.length - 1] || path || 'Model').replace(/\.gguf$/i, '');
    },

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    },
};

document.addEventListener('DOMContentLoaded', () => {
    Station.init();
});

window.Station = Station;
