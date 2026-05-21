/**
 * models_manager.js — Model folder UI: scan, load/unload, open folder.
 */

const ModelsManager = {
    modelsDir: '',
    downloadSources: {},
    localModels: [],
    pollInterval: null,

    init() {
        const btn = document.getElementById('btnToggleModels');
        const panel = document.getElementById('modelsPanel');
        const close = document.getElementById('btnCloseModelsPanel');
        if (!btn || !panel) return;

        // Apply saved width or default
        const savedWidth = localStorage.getItem('modelsPanelWidth');
        if (savedWidth) {
            panel.style.width = savedWidth + 'px';
        } else {
            panel.style.width = '380px';
        }

        // Initialize resize handle
        const handle = document.getElementById('modelsPanelResizeHandle');
        if (handle) {
            let isResizing = false;
            let startX = 0;
            let startWidth = 0;

            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startWidth = panel.offsetWidth;
                handle.classList.add('resizing');
                document.body.style.cursor = 'ew-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                // Panel is on the right, dragging left (negative deltaX) increases width
                const deltaX = startX - e.clientX;
                let newWidth = startWidth + deltaX;
                if (newWidth < 320) newWidth = 320;
                if (newWidth > 650) newWidth = 650;
                panel.style.width = newWidth + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (!isResizing) return;
                isResizing = false;
                handle.classList.remove('resizing');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                localStorage.setItem('modelsPanelWidth', panel.offsetWidth);
            });
        }

        btn.addEventListener('click', () => {
            if (window.activeView === "models") {
                window.setView("chat");
            } else {
                window.setView("models");
            }
        });
        if (close) {
            close.addEventListener('click', () => {
                window.setView("chat");
            });
        }

        document.getElementById('btnModelsRescan')?.addEventListener('click', () => this.refresh());
        document.getElementById('btnModelsOpenFolder')?.addEventListener('click', () => this.openFolder());

        this.fetchSources();
    },

    async openFolder() {
        try {
            const dir = this.modelsDir || (await NanaAPI.getModels()).modelsDirectory;
            if (window.nanaDesktop && typeof window.nanaDesktop.openModelsFolder === 'function') {
                const err = await window.nanaDesktop.openModelsFolder(dir);
                if (err) console.warn('openModelsFolder:', err);
            } else {
                await NanaAPI.openModelsFolderBackend();
            }
        } catch (e) {
            alert('Could not open folder: ' + e.message);
        }
    },    async refresh() {
        const tbody = document.querySelector('#modelsTable tbody');
        if (!tbody) return;

        tbody.replaceChildren();
        const loading = document.createElement('tr');
        loading.innerHTML =
            '<td colspan="4" style="padding:12px;color:var(--text-muted);">Scanning…</td>';
        tbody.appendChild(loading);

        try {
            await NanaAPI.scanModels();
            const data = await NanaAPI.getModels();
            const current = await NanaAPI.getCurrentModel();
            this.modelsDir = data.modelsDirectory || '';
            const elDir = document.getElementById('modelsDirDisplay');
            if (elDir) elDir.textContent = this.modelsDir;

            const models = data.models || [];
            this.localModels = models;
            tbody.replaceChildren();

            if (models.length === 0) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 4;
                td.style.padding = '16px';
                td.style.color = 'var(--warning)';
                td.textContent =
                    'No local model found. Put a .gguf model file inside the models folder, then click Rescan Models.';
                tr.appendChild(td);
                tbody.appendChild(tr);
                if (typeof window.onModelsListUpdated === 'function') {
                    window.onModelsListUpdated([], data.settings);
                }
                return;
            }

            this._renderLocalSections(tbody, models, current);

            if (typeof window.onModelsListUpdated === 'function') {
                window.onModelsListUpdated(models, data.settings);
            }
            const pullStatus = await NanaAPI.getPullStatus();
            this.renderDownloaderList(pullStatus || {});
        } catch (e) {
            tbody.replaceChildren();
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 4;
            td.style.padding = '12px';
            td.style.color = 'var(--error)';
            td.textContent = String(e.message || e);
            tr.appendChild(td);
            tbody.appendChild(tr);
        }
    },

    _renderLocalSections(tbody, models, current) {
        const textModels = models.filter((m) => m.modelType !== 'vision');
        const visionModels = models.filter((m) => m.modelType === 'vision');
        this._appendSectionRows(tbody, 'Local Text Models', textModels, current);
        this._appendSectionRows(tbody, 'Local Vision Models', visionModels, current);
    },

    _appendSectionRows(tbody, title, models, current) {
        const header = document.createElement('tr');
        header.className = 'mm-section-row';
        const td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = title;
        header.appendChild(td);
        tbody.appendChild(header);

        if (models.length === 0) {
            const empty = document.createElement('tr');
            const emptyTd = document.createElement('td');
            emptyTd.colSpan = 4;
            emptyTd.style.padding = '12px';
            emptyTd.style.color = 'var(--text-muted)';
            emptyTd.textContent = 'None installed';
            empty.appendChild(emptyTd);
            tbody.appendChild(empty);
            return;
        }

        for (const m of models) {
            tbody.appendChild(this._buildRow(m, current));
        }
    },

    _buildRow(m, current) {
        const tr = document.createElement('tr');
        const isActive = current.loaded && current.relativePath === m.relativePath;

        const tdName = document.createElement('td');
        const nameEl = document.createElement('div');
        nameEl.className = 'mm-name';
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'mm-model-title';
        nameSpan.textContent = m.displayName || m.fileName;
        nameSpan.title = m.filePath || m.relativePath || ''; 
        nameEl.appendChild(nameSpan);

        const badge = document.createElement('span');
        badge.className = `mm-model-badge mm-model-badge-${m.modelType || 'text'}`;
        if (m.modelType === 'reasoning') {
            badge.textContent = 'REASONING';
        } else if (m.modelType === 'code') {
            badge.textContent = 'CODE';
        } else if (m.modelType === 'vision') {
            badge.textContent = 'VISION';
        } else {
            badge.textContent = 'TEXT';
        }
        nameEl.appendChild(badge);
        const metaEl = document.createElement('div');
        metaEl.className = 'mm-meta';
        metaEl.textContent = m.modelType === 'vision'
            ? 'Hidden image analyzer'
            : (m.relativePath || [m.quantization, m.modelType].filter(Boolean).join(' - '));
        metaEl.title = metaEl.textContent;
        tdName.appendChild(nameEl);
        tdName.appendChild(metaEl);

        const tdSize = document.createElement('td');
        tdSize.className = 'mm-mono';
        tdSize.textContent = (m.size / (1024 * 1024)).toFixed(1) + ' MB';

        const tdAvail = document.createElement('td');
        if (m.modelType === 'vision' && m.available) {
            tdAvail.innerHTML = '<span class="mm-ok">Installed</span>';
        } else if (m.available) {
            tdAvail.innerHTML = `<span class="mm-ok">${isActive ? 'Loaded' : 'Ready'}</span>`;
        } else if (m.visionSetupRequired) {
            tdAvail.innerHTML = '<span class="mm-bad" style="color: var(--warning); border-color: var(--warning);">Missing files</span>';
        } else {
            tdAvail.innerHTML = '<span class="mm-bad">Missing</span>';
        }

        const tdAct = document.createElement('td');
        tdAct.className = 'mm-actions';

        if (isActive) {
            const badge = document.createElement('span');
            badge.className = 'mm-active';
            badge.textContent = '● Active';
            tdAct.appendChild(badge);
        }

        if (m.modelType === 'vision') {
            const btnCheck = document.createElement('button');
            btnCheck.type = 'button';
            btnCheck.className = 'mm-btn mm-btn-muted';
            btnCheck.textContent = 'Check files';
            btnCheck.addEventListener('click', () => {
                const files = Array.isArray(m.files) ? m.files : [];
                const details = files.map((file) => `${file.role}: ${file.relativePath}`).join('\n');
                alert(details || 'Vision package files are not listed. Click Rescan models.');
            });
            tdAct.appendChild(btnCheck);

            tr.appendChild(tdName);
            tr.appendChild(tdSize);
            tr.appendChild(tdAvail);
            tr.appendChild(tdAct);
            return tr;
        }

        const btnLoad = document.createElement('button');
        btnLoad.type = 'button';
        btnLoad.className = 'mm-btn';
        btnLoad.textContent = 'Load';
        btnLoad.disabled = !m.available;
        btnLoad.addEventListener('click', async () => {
            try {
                await NanaAPI.loadModel(m.relativePath);
                await NanaAPI.setDefaultModel(m.relativePath);
                await this.refresh();
                if (window.onModelLoaded) window.onModelLoaded(m.relativePath);
            } catch (err) {
                alert('Load failed: ' + err.message);
            }
        });

        const btnUnload = document.createElement('button');
        btnUnload.type = 'button';
        btnUnload.className = 'mm-btn mm-btn-muted';
        btnUnload.textContent = 'Unload';
        btnUnload.addEventListener('click', async () => {
            try {
                await NanaAPI.unloadModel();
                await this.refresh();
                if (window.onModelUnloaded) window.onModelUnloaded();
            } catch (err) {
                alert('Unload failed: ' + err.message);
            }
        });

        const btnDef = document.createElement('button');
        btnDef.type = 'button';
        btnDef.className = 'mm-btn mm-btn-muted';
        btnDef.textContent = 'Set default';
        btnDef.addEventListener('click', async () => {
            try {
                await NanaAPI.setDefaultModel(m.relativePath);
                await this.refresh();
                if (window.onModelLoaded) window.onModelLoaded(m.relativePath);
            } catch (err) {
                alert(err.message);
            }
        });

        tdAct.appendChild(btnLoad);
        tdAct.appendChild(btnUnload);
        tdAct.appendChild(btnDef);

        tr.appendChild(tdName);
        tr.appendChild(tdSize);
        tr.appendChild(tdAvail);
        tr.appendChild(tdAct);
        return tr;
    },

    async fetchSources() {
        try {
            this.downloadSources = await NanaAPI.getModelSources() || {};
            this.renderDownloaderList({});
        } catch (e) {
            console.error('Failed to fetch model sources:', e);
        }
    },

    startStatusPolling() {
        if (this.pollInterval) return;
        this.pollInterval = setInterval(async () => {
            const panel = document.getElementById('modelsPanel');
            if (!panel || panel.classList.contains('hidden')) {
                this.stopStatusPolling();
                return;
            }
            try {
                const status = await NanaAPI.getPullStatus();
                this.renderDownloaderList(status || {});
                
                const activeDownloads = Object.values(status || {});
                const isStillDownloading = activeDownloads.some(d => d.status === 'downloading');

                // If any downloads completed or failed, trigger a model load scan
                const hasFinished = activeDownloads.some(d => d.status === 'completed' || d.status === 'failed');
                if (hasFinished) {
                    // Refresh local models list
                    const tbody = document.querySelector('#modelsTable tbody');
                    if (tbody) {
                        const current = await NanaAPI.getCurrentModel();
                        const data = await NanaAPI.getModels();
                        tbody.replaceChildren();
                        const models = data.models || [];
                        this.localModels = models;
                        if (models.length > 0) {
                            this._renderLocalSections(tbody, models, current);
                            if (typeof window.onModelsListUpdated === 'function') {
                                window.onModelsListUpdated(models, data.settings);
                            }
                        }
                    }
                }

                if (!isStillDownloading) {
                    this.stopStatusPolling();
                }
            } catch (e) {
                console.error('Failed polling download status:', e);
            }
        }, 2000);
    },

    stopStatusPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    renderDownloaderList(status) {
        const container = document.getElementById('downloaderModelsList');
        if (!container) return;

        const sources = this.downloadSources || {};
        const sourceKeys = Object.keys(sources);
        if (sourceKeys.length === 0) {
            container.innerHTML = '<p style="color:var(--text-muted); font-size:12px; text-align:center;">No downloadable models available</p>';
            return;
        }

        container.replaceChildren();
        const textKeys = sourceKeys.filter((modelId) => {
            const t = sources[modelId]?.type;
            return t !== 'vision' && t !== 'reasoning';
        });
        const reasoningKeys = sourceKeys.filter((modelId) => sources[modelId]?.type === 'reasoning');
        const visionKeys = sourceKeys.filter((modelId) => sources[modelId]?.type === 'vision');
        this._appendDownloadSection(container, 'Download Text Models', textKeys, status);
        this._appendDownloadSection(container, 'Download Reasoning Models', reasoningKeys, status);
        this._appendDownloadSection(container, 'Download Vision Models', visionKeys, status);
    },

    _appendDownloadSection(container, title, sourceKeys, status) {
        const header = document.createElement('div');
        header.className = 'downloader-section-title';
        header.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 4px 0 2px;';
        header.textContent = title;
        container.appendChild(header);

        if (sourceKeys.length === 0) {
            const empty = document.createElement('p');
            empty.style.cssText = 'color:var(--text-muted); font-size:12px; margin: 4px 0 8px;';
            empty.textContent = 'None available';
            container.appendChild(empty);
            return;
        }

        const sources = this.downloadSources || {};
        sourceKeys.forEach(modelId => {
            const source = sources[modelId];
            const dl = status[modelId];
            const isInstalled = this._isSourceInstalled(modelId, source);

            const item = document.createElement('div');
            item.className = 'downloader-item';
            item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--surface-glass); border: 1px solid var(--surface-border); border-radius: var(--radius-sm); font-size: 13px;';

            const info = document.createElement('div');
            info.style.cssText = 'display: flex; flex-direction: column; gap: 2px; flex: 1; margin-right: 12px;';
            
            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'font-weight: 500; color: var(--text-primary); display: flex; align-items: center; gap: 6px;';
            const nameText = document.createTextNode(source.type === 'vision' ? 'MiniCPM-V Vision' : source.name);
            nameSpan.appendChild(nameText);
            if (source.type === 'reasoning') {
                const badge = document.createElement('span');
                badge.style.cssText = 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); letter-spacing: 0.05em;';
                badge.textContent = 'REASONING';
                nameSpan.appendChild(badge);
            } else if (source.type === 'code' || (source.name && source.name.toLowerCase().includes('coder'))) {
                const badge = document.createElement('span');
                badge.style.cssText = 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(96, 165, 250, 0.15); color: #60a5fa; border: 1px solid rgba(96, 165, 250, 0.3); letter-spacing: 0.05em;';
                badge.textContent = 'CODE';
                nameSpan.appendChild(badge);
            }
            info.appendChild(nameSpan);
            if (source.description) {
                const descText = document.createElement('span');
                descText.style.cssText = 'font-size: 11px; color: var(--text-muted); line-height: 1.3;';
                descText.textContent = source.description;
                info.appendChild(descText);
            }

            if (source.disabled) {
                const descSpan = document.createElement('span');
                descSpan.style.cssText = 'font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);';
                descSpan.textContent = this._sourceFilesLabel(source);
                info.appendChild(descSpan);

                const statusLabel = document.createElement('span');
                statusLabel.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px; font-style: italic;';
                statusLabel.textContent = source.disabledMessage || 'Unavailable';
                info.appendChild(statusLabel);
                item.appendChild(info);

                const disabledLabel = document.createElement('span');
                disabledLabel.style.cssText = 'font-size: 12px; color: var(--text-muted); font-weight: 500; font-style: italic; white-space: nowrap;';
                disabledLabel.textContent = source.disabledMessage || 'Coming later';
                item.appendChild(disabledLabel);
            } else if (isInstalled) {
                const descSpan = document.createElement('span');
                descSpan.style.cssText = 'font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);';
                descSpan.textContent = this._sourceFilesLabel(source);
                info.appendChild(descSpan);

                const statusLabel = document.createElement('span');
                statusLabel.style.cssText = 'font-size: 11px; color: var(--success); margin-top: 4px;';
                statusLabel.textContent = source.type === 'vision'
                    ? 'Installed - automatically used when images are uploaded.'
                    : 'Installed';
                info.appendChild(statusLabel);
                item.appendChild(info);

                const installedBadge = document.createElement('span');
                installedBadge.style.cssText = 'font-size: 12px; color: var(--success); font-weight: 500; white-space: nowrap;';
                installedBadge.textContent = 'Installed';
                item.appendChild(installedBadge);
            } else if (dl && dl.status === 'downloading') {
                const progress = dl.progress ?? 0;
                
                const progressContainer = document.createElement('div');
                progressContainer.style.cssText = 'width: 100%; height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; margin-top: 6px;';
                
                const progressBar = document.createElement('div');
                progressBar.style.cssText = `width: ${progress >= 0 ? progress : 100}%; height: 100%; background: var(--accent); transition: width 0.3s;`;
                progressContainer.appendChild(progressBar);
                info.appendChild(progressContainer);

                const statusLabel = document.createElement('span');
                statusLabel.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px;';
                if (progress >= 0) {
                    statusLabel.textContent = `Downloading: ${progress}% (${(dl.bytes_downloaded / (1024 * 1024)).toFixed(1)} MB / ${(dl.total_bytes / (1024 * 1024)).toFixed(1)} MB)`;
                } else {
                    statusLabel.textContent = `Downloading... (${(dl.bytes_downloaded / (1024 * 1024)).toFixed(1)} MB)`;
                }
                info.appendChild(statusLabel);

                item.appendChild(info);

                const actionsContainer = document.createElement('div');
                actionsContainer.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                const dlBadge = document.createElement('span');
                dlBadge.style.cssText = 'font-size: 12px; color: var(--accent); font-weight: 500; white-space: nowrap;';
                dlBadge.textContent = '⏳ Downloading...';
                actionsContainer.appendChild(dlBadge);

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'mm-btn mm-btn-muted';
                cancelBtn.style.cssText = 'padding: 4px 10px; font-size: 12px; background: rgba(239, 68, 68, 0.15); color: #ef4444; border-color: rgba(239, 68, 68, 0.2);';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.addEventListener('click', async () => {
                    cancelBtn.disabled = true;
                    cancelBtn.textContent = 'Cancelling...';
                    try {
                        await NanaAPI.cancelPullModel(modelId);
                        // Refresh immediately after calling cancel
                        const nextStatus = await NanaAPI.getPullStatus();
                        this.renderDownloaderList(nextStatus || {});
                    } catch (e) {
                        alert('Cancel failed: ' + e.message);
                        cancelBtn.disabled = false;
                        cancelBtn.textContent = 'Cancel';
                    }
                });
                actionsContainer.appendChild(cancelBtn);
                item.appendChild(actionsContainer);
            } else {
                const descSpan = document.createElement('span');
                descSpan.style.cssText = 'font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);';
                descSpan.textContent = this._sourceFilesLabel(source);
                info.appendChild(descSpan);

                if (dl && dl.status === 'completed') {
                    const statusLabel = document.createElement('span');
                    statusLabel.style.cssText = 'font-size: 11px; color: var(--success); margin-top: 4px;';
                    statusLabel.textContent = 'Completed (model is now available)';
                    info.appendChild(statusLabel);
                    item.appendChild(info);

                    const completedBadge = document.createElement('span');
                    completedBadge.style.cssText = 'font-size: 12px; color: var(--success); font-weight: 500;';
                    completedBadge.textContent = '✓ Completed';
                    item.appendChild(completedBadge);
                } else if (dl && dl.status === 'failed') {
                    const statusLabel = document.createElement('span');
                    statusLabel.style.cssText = 'font-size: 11px; color: var(--error); margin-top: 4px;';
                    statusLabel.textContent = `Error: ${dl.error || 'Unknown error'}`;
                    info.appendChild(statusLabel);
                    item.appendChild(info);

                    const retryBtn = document.createElement('button');
                    retryBtn.className = 'mm-btn';
                    retryBtn.style.cssText = 'padding: 4px 10px; font-size: 12px;';
                    retryBtn.textContent = 'Retry';
                    retryBtn.addEventListener('click', () => this.startPull(modelId));
                    item.appendChild(retryBtn);
                } else if (dl && dl.status === 'cancelled') {
                    const statusLabel = document.createElement('span');
                    statusLabel.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px;';
                    statusLabel.textContent = 'Download cancelled';
                    info.appendChild(statusLabel);
                    item.appendChild(info);

                    const dlBtn = document.createElement('button');
                    dlBtn.className = 'mm-btn';
                    dlBtn.style.cssText = 'padding: 4px 10px; font-size: 12px;';
                    dlBtn.textContent = 'Download';
                    dlBtn.addEventListener('click', () => this.startPull(modelId));
                    item.appendChild(dlBtn);
                } else {
                    item.appendChild(info);

                    const dlBtn = document.createElement('button');
                    dlBtn.className = 'mm-btn';
                    dlBtn.style.cssText = 'padding: 4px 10px; font-size: 12px;';
                    dlBtn.textContent = 'Download';
                    dlBtn.addEventListener('click', () => this.startPull(modelId));
                    item.appendChild(dlBtn);
                }
            }

            container.appendChild(item);
        });
    },

    _sourceFilesLabel(source) {
        if (source?.type === 'vision') {
            return 'Requires: model.gguf + mmproj.gguf';
        }
        return source?.filename || '';
    },

    _isSourceInstalled(modelId, source) {
        const models = this.localModels || [];
        if (source?.type === 'vision') {
            return models.some((m) => (
                m.modelType === 'vision'
                && (m.packagePath || '').replace(/\/$/, '') === (source.folder || modelId)
                && m.available
            ));
        }
        const folder = source?.folder || modelId;
        const filename = source?.filename;
        return models.some((m) => m.modelType !== 'vision' && m.relativePath === `${folder}/${filename}` && m.available);
    },

    async startPull(modelId) {
        try {
            await NanaAPI.pullModel(modelId);
            this.startStatusPolling();
        } catch (e) {
            alert('Failed to start download: ' + e.message);
        }
    },
};

document.addEventListener('DOMContentLoaded', () => {
    window.ModelsManager = ModelsManager;
    ModelsManager.init();
});
