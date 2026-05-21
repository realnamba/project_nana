/**
 * settings_manager.js — Settings page UI and user profile/memory persistence.
 */

const SettingsManager = {
    defaults: {
        contextSize: 4096,
        maxNewTokens: 512,
        chatHistoryLimit: 6
    },

    init() {
        const btnToggle = document.getElementById('btnToggleSettings');
        const btnBack = document.getElementById('btnSettingsBack');
        const btnSave = document.getElementById('btnSaveSettings');
        const btnViewMemory = document.getElementById('btnViewMemory');
        const btnClearMemory = document.getElementById('btnClearMemory');

        this.initCustomSelects();

        if (btnToggle) {
            btnToggle.addEventListener('click', () => {
                if (window.activeView === "settings") {
                    window.setView("chat");
                } else {
                    window.setView("settings");
                }
            });
        }

        if (btnBack) {
            btnBack.addEventListener('click', () => {
                window.setView("chat");
            });
        }

        if (btnSave) {
            btnSave.addEventListener('click', () => this.saveAll());
        }

        if (btnViewMemory) {
            btnViewMemory.addEventListener('click', () => this.toggleMemoryPreview());
        }

        if (btnClearMemory) {
            btnClearMemory.addEventListener('click', () => this.clearMemory());
        }
    },

    initCustomSelects() {
        const selects = document.querySelectorAll('[data-settings-select]');
        selects.forEach((root) => {
            const trigger = root.querySelector('.settings-select-trigger');
            const options = root.querySelectorAll('.settings-select-option');

            if (trigger) {
                trigger.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.toggleSelect(root);
                });
            }

            options.forEach((option) => {
                option.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.setSelectValue(root.dataset.settingsSelect, option.dataset.value);
                    this.closeSelect(root);
                });
            });
        });

        document.addEventListener('click', () => this.closeAllSelects());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeAllSelects();
            }
        });
    },

    toggleSelect(root) {
        const isOpen = root.classList.contains('open');
        this.closeAllSelects(root);
        if (isOpen) {
            this.closeSelect(root);
            return;
        }

        root.classList.add('open');
        root.querySelector('.settings-select-menu')?.classList.remove('hidden');
        root.querySelector('.settings-select-trigger')?.setAttribute('aria-expanded', 'true');
    },

    closeSelect(root) {
        root.classList.remove('open');
        root.querySelector('.settings-select-menu')?.classList.add('hidden');
        root.querySelector('.settings-select-trigger')?.setAttribute('aria-expanded', 'false');
    },

    closeAllSelects(exceptRoot = null) {
        document.querySelectorAll('[data-settings-select]').forEach((root) => {
            if (root !== exceptRoot) this.closeSelect(root);
        });
    },

    setSelectValue(inputId, rawValue) {
        const input = document.getElementById(inputId);
        const root = document.querySelector(`[data-settings-select="${inputId}"]`);
        if (!input || !root) return;

        const value = String(rawValue);
        const options = Array.from(root.querySelectorAll('.settings-select-option'));
        const fallbackValue = inputId === 'settingsContextSize'
            ? this.defaults.contextSize
            : inputId === 'settingsMaxTokens'
                ? this.defaults.maxNewTokens
                : null;
        const selectedOption = options.find((option) => option.dataset.value === value)
            || options.find((option) => option.dataset.value === String(fallbackValue))
            || options[0];
        if (!selectedOption) return;

        input.value = selectedOption.dataset.value;
        const valueEl = root.querySelector('.settings-select-value');
        if (valueEl) {
            valueEl.textContent = selectedOption.dataset.label || selectedOption.textContent.trim();
        }

        options.forEach((option) => {
            const active = option === selectedOption;
            option.classList.toggle('active', active);
            option.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    },

    showSettingsPage() {
        if (window.setView) window.setView("settings");
    },

    hideSettingsPage() {
        if (window.setView) window.setView("chat");
    },

    async loadAll() {
        try {
            const settings = await NanaAPI.getSettings();
            
            this.setSelectValue(
                'settingsContextSize',
                settings.contextSize ?? this.defaults.contextSize
            );
            this.setSelectValue(
                'settingsMaxTokens',
                settings.maxNewTokens ?? this.defaults.maxNewTokens
            );

            const historyLimitInput = document.getElementById('settingsHistoryLimit');
            if (historyLimitInput) {
                historyLimitInput.value = settings.chatHistoryLimit ?? this.defaults.chatHistoryLimit;
            }

        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    },

    async saveAll() {
        const btnSave = document.getElementById('btnSaveSettings');
        if (!btnSave) return;
        const originalText = btnSave.textContent;
        btnSave.textContent = 'Saving...';
        btnSave.disabled = true;

        try {
            // Build settings payload
            const contextSizeSelect = document.getElementById('settingsContextSize');
            const maxTokensInput = document.getElementById('settingsMaxTokens');
            const historyLimitInput = document.getElementById('settingsHistoryLimit');

            const settingsPayload = {
                personaEnabled: true,
                memoryEnabled: true
            };
            if (contextSizeSelect) settingsPayload.contextSize = parseInt(contextSizeSelect.value, 10);
            if (maxTokensInput) settingsPayload.maxNewTokens = parseInt(maxTokensInput.value, 10);
            if (historyLimitInput) {
                const parsed = parseInt(historyLimitInput.value, 10);
                settingsPayload.chatHistoryLimit = Number.isFinite(parsed)
                    ? Math.min(Math.max(parsed, 1), 50)
                    : this.defaults.chatHistoryLimit;
                historyLimitInput.value = settingsPayload.chatHistoryLimit;
            }

            // Save settings
            await NanaAPI.updateSettings(settingsPayload);

            btnSave.textContent = 'Saved';
            btnSave.style.background = 'var(--success)';
            btnSave.style.color = '#000';

            setTimeout(() => {
                btnSave.textContent = originalText;
                btnSave.style.background = '';
                btnSave.style.color = '';
                btnSave.disabled = false;
            }, 1500);

            // Trigger status check/scan if context size or default model changed
            if (window.loadModels) {
                window.loadModels();
            }

        } catch (e) {
            console.error('Failed to save settings:', e);
            alert('Failed to save settings: ' + e.message);
            btnSave.textContent = originalText;
            btnSave.style.background = '';
            btnSave.style.color = '';
            btnSave.disabled = false;
        }
    },

    async toggleMemoryPreview() {
        const preview = document.getElementById('memoryPreview');
        if (!preview) return;

        if (!preview.classList.contains('hidden')) {
            preview.classList.add('hidden');
            return;
        }

        try {
            const memory = await NanaAPI.getUserMemory();
            this.renderMemoryPreview(memory);
        } catch (e) {
            console.error('Failed to load user memory:', e);
            preview.textContent = 'Could not load memory.';
            preview.classList.remove('hidden');
        }
    },

    renderMemoryPreview(memory) {
        const preview = document.getElementById('memoryPreview');
        if (!preview) return;

        const rows = [
            ['Preferred name', memory.preferredName],
            ['Hobbies', memory.hobbies],
            ['Projects', memory.currentProjects],
            ['Work / study', memory.workStudy],
            ['Model preferences', memory.modelPreferences],
            ['App preferences', memory.appPreferences],
            ['Repeated goals', memory.repeatedGoals]
        ].filter(([, value]) => value && String(value).trim());

        preview.innerHTML = '';

        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'memory-empty';
            empty.textContent = 'No saved memory yet.';
            preview.appendChild(empty);
        } else {
            rows.forEach(([label, value]) => {
                const item = document.createElement('div');
                item.className = 'memory-row';

                const keyEl = document.createElement('span');
                keyEl.className = 'memory-row-label';
                keyEl.textContent = label;

                const valueEl = document.createElement('span');
                valueEl.className = 'memory-row-value';
                valueEl.textContent = String(value);

                item.appendChild(keyEl);
                item.appendChild(valueEl);
                preview.appendChild(item);
            });
        }

        preview.classList.remove('hidden');
    },

    async clearMemory() {
        if (!confirm('Clear Nana memory? This keeps the file but removes saved facts.')) return;

        const emptyMemory = {
            preferredName: '',
            hobbies: '',
            currentProjects: '',
            workStudy: '',
            modelPreferences: '',
            appPreferences: '',
            repeatedGoals: ''
        };

        try {
            await NanaAPI.updateUserMemory(emptyMemory);
            this.renderMemoryPreview(emptyMemory);
        } catch (e) {
            console.error('Failed to clear user memory:', e);
            alert('Failed to clear memory: ' + e.message);
        }
    }
};

window.SettingsManager = SettingsManager;

document.addEventListener('DOMContentLoaded', () => {
    SettingsManager.init();
});
