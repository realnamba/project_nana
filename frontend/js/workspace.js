/**
 * workspace.js — Logic for the project workspace side panel and file viewer.
 */

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

const Workspace = {
    panel: document.getElementById('workspacePanel'),
    treeEl: document.getElementById('fileTree'),
    editorEl: document.getElementById('codeEditor'),
    fileNameEl: document.getElementById('viewerFileName'),
    btnOpenVsCode: document.getElementById('btnOpenVsCode'),
    workspaceNameEl: document.getElementById('workspaceName'),
    btnSaveFile: document.getElementById('btnSaveFile'),
    btnCloseFile: document.getElementById('btnCloseFile'),
    
    activePath: null,
    activeFile: null,

    init() {
        // Toggle workspace
        document.getElementById('btnToggleWorkspace').addEventListener('click', () => {
            if (window.activeView === "workspace") {
                window.setView("chat");
            } else {
                window.setView("workspace");
            }
        });

        document.getElementById('btnCloseWorkspace').addEventListener('click', () => {
            window.setView("chat");
        });

        // Toggle Terminal panel
        const btnToggleTerminal = document.getElementById('btnToggleTerminal');
        const terminalPanel = document.getElementById('workspaceTerminalPanel');
        const btnCloseTerminal = document.getElementById('btnCloseTerminal');

        if (btnToggleTerminal && terminalPanel) {
            btnToggleTerminal.addEventListener('click', () => {
                terminalPanel.classList.toggle('hidden');
            });
        }
        if (btnCloseTerminal && terminalPanel) {
            btnCloseTerminal.addEventListener('click', () => {
                terminalPanel.classList.add('hidden');
            });
        }

        // Open folder action
        const triggerOpenFolder = async () => {
            try {
                let path = null;

                // 1. Electron native dialog (best)
                if (window.nanaDesktop && typeof window.nanaDesktop.selectFolder === 'function') {
                    console.log('[Workspace] Using Electron native folder picker');
                    path = await window.nanaDesktop.selectFolder();
                    // selectFolder returns null if user cancelled
                    if (!path) {
                        console.log('[Workspace] Folder selection cancelled');
                        return;
                    }
                }
                // 2. Backend tkinter dialog fallback
                else {
                    console.log('[Workspace] Electron not available, trying backend dialog');
                    try {
                        const res = await NanaAPI.selectFolder();
                        if (res.status === 'success' && res.path) {
                            path = res.path;
                        } else if (res.status === 'cancelled') {
                            return; // User cancelled, do nothing
                        } else if (res.status === 'error') {
                            // 3. Last resort: manual input
                            path = prompt("Could not open native folder picker.\nEnter the absolute folder path:");
                        }
                    } catch (apiErr) {
                        console.warn("selectFolder API failed:", apiErr);
                        path = prompt("Could not open native folder picker.\nEnter the absolute folder path:");
                    }
                }

                if (path) {
                    await this.openWorkspacePath(path);
                }
            } catch (e) {
                console.error("Failed to select folder", e);
            }
        };

        const btnOpenFolder = document.getElementById('btnOpenFolder');
        const btnEmptyOpenFolder = document.getElementById('btnEmptyOpenFolder');
        if (btnOpenFolder) btnOpenFolder.addEventListener('click', triggerOpenFolder);
        if (btnEmptyOpenFolder) btnEmptyOpenFolder.addEventListener('click', triggerOpenFolder);

        // Workspace header title section popover toggle
        const titleSection = document.getElementById('workspaceTitleSection');
        const popover = document.getElementById('recentProjectsPopover');
        
        if (titleSection && popover) {
            titleSection.addEventListener('click', (e) => {
                e.stopPropagation();
                popover.classList.toggle('hidden');
                if (!popover.classList.contains('hidden')) {
                    this.loadRecents();
                }
            });
            
            document.addEventListener('click', (e) => {
                if (!titleSection.contains(e.target)) {
                    popover.classList.add('hidden');
                }
            });
        }

        // Close workspace button
        const btnPopoverCloseWorkspace = document.getElementById('btnPopoverCloseWorkspace');
        if (btnPopoverCloseWorkspace) {
            btnPopoverCloseWorkspace.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (popover) popover.classList.add('hidden');
                try {
                    await NanaAPI.closeWorkspace();
                    this.activePath = null;
                    this.workspaceNameEl.textContent = 'No Project';
                    this.btnOpenVsCode.style.display = 'none';
                    this.panel.classList.add('no-project');
                    this.closeFile();
                    this.loadRecents();
                } catch(e) {
                    alert("Failed to close workspace: " + e.message);
                }
            });
        }

        // VS Code
        this.btnOpenVsCode.addEventListener('click', async () => {
            try {
                await NanaAPI.openVsCode();
            } catch (e) {
                alert(e.message);
            }
        });

        // Close file
        if (this.btnCloseFile) {
            this.btnCloseFile.addEventListener('click', () => {
                this.closeFile();
            });
        }
        
        // Save file
        this.btnSaveFile.addEventListener('click', async () => {
            if (!this.activeFile) return;
            try {
                await NanaAPI.updateFile(this.activeFile, this.editorEl.value);
                this.btnSaveFile.style.display = 'none';
                this.editorEl.dataset.original = this.editorEl.value;
            } catch(e) {
                alert("Failed to save: " + e.message);
            }
        });
        
        // Editor change detection
        this.editorEl.addEventListener('input', () => {
            if (this.editorEl.value !== this.editorEl.dataset.original) {
                this.btnSaveFile.style.display = 'block';
            } else {
                this.btnSaveFile.style.display = 'none';
            }
        });
        
        this.refreshStatus();
    },

    updatePromptPath() {
        const terminalPromptPrefix = document.getElementById('terminalPromptPrefix');
        const terminalPromptInput = document.getElementById('terminalPromptInput');
        if (!terminalPromptPrefix || !terminalPromptInput) return;

        if (this.activePath) {
            const parts = this.activePath.split(/[/\\]/);
            const folderName = parts.pop() || parts.pop() || 'project';
            terminalPromptPrefix.textContent = `nana-assistant@local:~/${folderName}$`;
            terminalPromptInput.disabled = false;
            terminalPromptInput.placeholder = '';
        } else {
            terminalPromptPrefix.textContent = `nana-assistant@local:~$`;
            terminalPromptInput.disabled = true;
            terminalPromptInput.placeholder = 'Open a project folder before using terminal.';
            terminalPromptInput.value = '';
        }
    },

    async refreshStatus() {
        try {
            const status = await NanaAPI.getWorkspaceStatus();
            if (status.connected) {
                this.activePath = status.workspace;
                this.workspaceNameEl.textContent = status.name;
                this.btnOpenVsCode.style.display = 'block';
                this.panel.classList.remove('no-project');
                this.loadTree();
                this.loadRecents();
            } else {
                this.activePath = null;
                this.workspaceNameEl.textContent = 'No Project';
                this.btnOpenVsCode.style.display = 'none';
                this.panel.classList.add('no-project');
                this.loadRecents();
            }
            this.updatePromptPath();
        } catch(e) {
            console.error("Workspace status error", e);
        }
    },

    async openWorkspacePath(path) {
        try {
            const res = await NanaAPI.openWorkspace(path);
            this.activePath = res.workspace;
            this.workspaceNameEl.textContent = res.name;
            this.btnOpenVsCode.style.display = 'block';
            this.panel.classList.remove('no-project');
            this.loadTree();
            this.loadRecents();
            this.updatePromptPath();
        } catch (e) {
            alert("Failed to open workspace: " + e.message);
        }
    },

    async loadRecents() {
        try {
            const data = await NanaAPI.getRecentProjects();
            const recents = data.projects || [];
            
            // 1. Popover list
            const popoverList = document.getElementById('popoverRecentProjectsList');
            if (popoverList) {
                popoverList.innerHTML = '';
                if (recents.length === 0) {
                    popoverList.innerHTML = '<div style="padding: 8px; font-size: 11px; color: var(--text-muted); text-align: center;">No recent projects</div>';
                } else {
                    recents.forEach(p => {
                        const item = document.createElement('div');
                        item.className = 'recent-project-item';
                        item.style.cssText = "padding: 6px 8px; border-radius: 4px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; transition: background 0.2s;";
                        item.innerHTML = `
                            <span style="font-weight: 500; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(p.name)}</span>
                            <span style="font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(p.path)}</span>
                        `;
                        item.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            const popover = document.getElementById('recentProjectsPopover');
                            if (popover) popover.classList.add('hidden');
                            await this.openWorkspacePath(p.path);
                        });
                        popoverList.appendChild(item);
                    });
                }
            }
            
            // 2. Empty state list
            const recentContainer = document.getElementById('recentProjectsContainer');
            const recentList = document.getElementById('recentProjectsList');
            if (recentContainer && recentList) {
                recentList.innerHTML = '';
                if (recents.length === 0) {
                    recentContainer.style.display = 'none';
                } else {
                    recentContainer.style.display = 'block';
                    recents.forEach(p => {
                        const item = document.createElement('div');
                        item.className = 'recent-project-item';
                        item.style.cssText = "padding: 8px 12px; border-radius: var(--radius-sm); cursor: pointer; display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(255,255,255,0.05); background: rgba(255,255,255,0.02); transition: all 0.2s;";
                        item.innerHTML = `
                            <span style="font-weight: 600; font-size: 13px; color: var(--text-primary); text-align: left;">${escapeHtml(p.name)}</span>
                            <span style="font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;">${escapeHtml(p.path)}</span>
                        `;
                        item.addEventListener('click', async () => {
                            await this.openWorkspacePath(p.path);
                        });
                        recentList.appendChild(item);
                    });
                }
            }
            
            // 3. Left sidebar fallback tree list when no project
            if (!this.activePath) {
                this.treeEl.innerHTML = '';
                
                const recHeader = document.createElement('div');
                recHeader.style.cssText = "padding: 8px 12px 4px; font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;";
                recHeader.textContent = "Recent projects";
                this.treeEl.appendChild(recHeader);
                
                if (recents.length === 0) {
                    const noRec = document.createElement('p');
                    noRec.style.cssText = "padding: 16px; color: var(--text-muted); font-size: 11px; text-align: center;";
                    noRec.textContent = "Open a folder to see the file tree.";
                    this.treeEl.appendChild(noRec);
                } else {
                    recents.forEach(p => {
                        const el = document.createElement('div');
                        el.className = 'tree-item file';
                        el.style.cssText = "display: flex; flex-direction: column; align-items: flex-start; padding: 6px 12px; border-radius: 4px; cursor: pointer; transition: background 0.2s;";
                        el.innerHTML = `
                            <span style="font-weight: 500; font-size: 12px; color: var(--text-primary); text-align: left;">📁 ${escapeHtml(p.name)}</span>
                            <span style="font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 18px; width: 100%; text-align: left;">${escapeHtml(p.path)}</span>
                        `;
                        el.addEventListener('click', async () => {
                            await this.openWorkspacePath(p.path);
                        });
                        this.treeEl.appendChild(el);
                    });
                }
            }
        } catch(e) {
            console.error("Failed to load recents: ", e);
        }
    },

    async loadTree() {
        try {
            const data = await NanaAPI.getWorkspaceTree();
            this.renderTree(data.tree, this.treeEl);
        } catch (e) {
            this.treeEl.innerHTML = `<p style="color:var(--error); padding:16px;">Failed to load tree: ${e.message}</p>`;
        }
    },

    renderTree(nodes, container) {
        container.innerHTML = '';
        nodes.forEach(node => {
            const el = document.createElement('div');
            el.className = 'tree-item ' + (node.is_dir ? 'dir' : 'file');
            
            const icon = node.is_dir ? '📁' : '📄';
            el.innerHTML = `<span style="margin-right:6px;">${icon}</span> ${node.name}`;
            
            if (node.is_dir) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'tree-children';
                this.renderTree(node.children || [], childrenContainer);
                
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    childrenContainer.classList.toggle('open');
                });
                
                container.appendChild(el);
                container.appendChild(childrenContainer);
            } else {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openFile(node.path, node.name);
                });
                container.appendChild(el);
            }
        });
    },

    async openFile(path, name) {
        try {
            const data = await NanaAPI.getFile(path);
            this.activeFile = path;
            this.fileNameEl.textContent = name;
            this.editorEl.value = data.content;
            this.editorEl.dataset.original = data.content;
            this.editorEl.removeAttribute('readonly');
            this.btnSaveFile.style.display = 'none';
            if (this.btnCloseFile) this.btnCloseFile.style.display = 'block';
        } catch (e) {
            alert("Could not open file: " + e.message);
        }
    },

    closeFile() {
        this.activeFile = null;
        this.fileNameEl.textContent = 'No file selected';
        this.editorEl.value = '';
        this.editorEl.setAttribute('readonly', 'true');
        this.btnSaveFile.style.display = 'none';
        if (this.btnCloseFile) this.btnCloseFile.style.display = 'none';
    },
    
    getContextForAI() {
        if (!this.activeFile) return null;
        return {
            path: this.activeFile,
            content: this.editorEl.value
        };
    },

    // Review Panel Logic
    openReviewPanel(path, b64Code) {
        try {
            const decoded = decodeURIComponent(escape(atob(b64Code)));
            this.pendingChange = { path: path, content: decoded };
            
            document.getElementById('workspaceReviewSidebar').classList.remove('hidden');
            document.getElementById('reviewFilePath').textContent = path;
            
            // Simple text view for diff for now
            const diffContainer = document.getElementById('reviewDiffContainer');
            diffContainer.innerHTML = '<pre style="margin:0; white-space: pre-wrap;">' + escapeHtml(decoded) + '</pre>';
            
            document.getElementById('btnApplyChange').disabled = false;
            document.getElementById('btnRejectChange').disabled = false;
            
            // Ensure workspace is open
            if (window.activeView !== "workspace") {
                window.setView("workspace");
            }
        } catch (e) {
            alert("Failed to parse proposed change.");
        }
    },

    closeReviewPanel() {
        document.getElementById('workspaceReviewSidebar').classList.add('hidden');
        document.getElementById('btnApplyChange').disabled = true;
        document.getElementById('btnRejectChange').disabled = true;
        this.pendingChange = null;
    }
};

window.previewCodeInEditor = function(b64Code) {
    if (!Workspace.activeFile) {
        alert("Please open a file in the workspace first to preview/apply changes.");
        return;
    }
    try {
        const decoded = decodeURIComponent(escape(atob(b64Code)));
        Workspace.editorEl.value = decoded;
        Workspace.btnSaveFile.style.display = 'block';
        if (window.activeView !== "workspace") window.setView("workspace");
    } catch (e) {
        alert("Failed to decode code block.");
    }
};

// Agent Tool Loop Interceptor
window.AgentLoop = {
    async handleToolCalls(rawContent) {
        if (!window.activeView) return;
        
        let toolExecuted = false;
        
        // Match <searchFiles>
        const searchMatch = rawContent.match(/<searchFiles>([\s\S]*?)<\/searchFiles>/);
        if (searchMatch) {
            const query = searchMatch[1].trim();
            ChatUI.addMessage('system', `🔍 Searching files for: \`${query}\`...`);
            try {
                const res = await NanaAPI.searchFiles(query);
                const resultsStr = JSON.stringify(res.results, null, 2);
                const msg = `Search results for "${query}":\n\`\`\`json\n${resultsStr}\n\`\`\``;
                this.autoReply(msg);
                toolExecuted = true;
            } catch (e) {
                this.autoReply(`Search failed: ${e.message}`);
                toolExecuted = true;
            }
        }
        
        // Match <readFile>
        if (!toolExecuted) {
            const readMatch = rawContent.match(/<readFile>([\s\S]*?)<\/readFile>/);
            if (readMatch) {
                const path = readMatch[1].trim();
                ChatUI.addMessage('system', `📄 Reading file: \`${path}\`...`);
                try {
                    const res = await NanaAPI.getFile(path);
                    const msg = `Content of ${path}:\n\`\`\`\n${res.content}\n\`\`\``;
                    this.autoReply(msg);
                    toolExecuted = true;
                } catch (e) {
                    this.autoReply(`Failed to read file ${path}: ${e.message}`);
                    toolExecuted = true;
                }
            }
        }
        
        // Match <runTerminal>
        if (!toolExecuted) {
            const termMatch = rawContent.match(/<runTerminal>([\s\S]*?)<\/runTerminal>/);
            if (termMatch) {
                const cmd = termMatch[1].trim();
                ChatUI.addMessage('system', `💻 Running command: \`${cmd}\`...`);
                try {
                    const res = await NanaAPI.runTerminalCommand(cmd);
                    // Wait a bit for output
                    setTimeout(async () => {
                        try {
                            const status = await NanaAPI.getTerminalStatus(res.task_id);
                            this.autoReply(`Command output:\n\`\`\`\n${status.output || '(no output)'}\n\`\`\``);
                        } catch (e) {
                            this.autoReply(`Error getting terminal output: ${e.message}`);
                        }
                    }, 2000);
                    toolExecuted = true;
                } catch (e) {
                    this.autoReply(`Failed to run command: ${e.message}`);
                    toolExecuted = true;
                }
            }
        }
    },
    
    autoReply(content) {
        // Find the chat input and auto-send a system response
        setTimeout(() => {
            document.getElementById('messageInput').value = content;
            window.updateSendButtonState();
            document.getElementById('btnSend').click();
        }, 500);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    Workspace.init();
    
    // Explorer Toolbar
    document.getElementById('btnRefreshTree')?.addEventListener('click', () => Workspace.loadTree());
    
    document.getElementById('btnNewFile')?.addEventListener('click', async () => {
        if (!Workspace.activePath) {
            alert("Please open a project folder first.");
            return;
        }
        const name = prompt("Enter relative file path (e.g. index.js or src/utils.js):");
        if (name) {
            try {
                await NanaAPI.createFile(name, '', false);
                Workspace.loadTree();
            } catch (e) {
                alert("Failed to create file: " + e.message);
            }
        }
    });

    document.getElementById('btnNewFolder')?.addEventListener('click', async () => {
        if (!Workspace.activePath) {
            alert("Please open a project folder first.");
            return;
        }
        const name = prompt("Enter relative folder path (e.g. components or src/styles):");
        if (name) {
            try {
                await NanaAPI.createFile(name, '', true);
                Workspace.loadTree();
            } catch (e) {
                alert("Failed to create folder: " + e.message);
            }
        }
    });
    
    // Bind Review Panel Buttons
    document.getElementById('btnCloseReview')?.addEventListener('click', () => Workspace.closeReviewPanel());
    
    document.getElementById('btnApplyChange')?.addEventListener('click', async () => {
        if (!Workspace.pendingChange) return;
        try {
            await NanaAPI.updateFile(Workspace.pendingChange.path, Workspace.pendingChange.content);
            Workspace.closeReviewPanel();
            ChatUI.addMessage('system', `✅ Applied changes to \`${Workspace.pendingChange.path}\``);
            Workspace.openFile(Workspace.pendingChange.path, Workspace.pendingChange.path.split('/').pop());
        } catch (e) {
            alert("Failed to apply change: " + e.message);
        }
    });
    
    document.getElementById('btnRejectChange')?.addEventListener('click', () => {
        Workspace.closeReviewPanel();
        ChatUI.addMessage('system', `❌ Rejected changes.`);
    });
    
    // Bind Terminal Panel Actions
    const terminalBody = document.getElementById('workspaceTerminalBody');
    const terminalHistory = document.getElementById('terminalHistory');
    const terminalPromptInput = document.getElementById('terminalPromptInput');
    const terminalPromptPrefix = document.getElementById('terminalPromptPrefix');
    const terminalInputLine = document.getElementById('terminalInputLine');
    const btnKillTerminal = document.getElementById('btnKillTerminal');
    const terminalStatusText = document.getElementById('terminalStatusText');
    
    let currentTaskId = null;
    let terminalInterval = null;
    const cmdHistory = [];
    let cmdHistoryIndex = -1;
    
    // Focus input on body click
    terminalBody?.addEventListener('click', () => {
        if (terminalPromptInput && !terminalPromptInput.disabled) {
            terminalPromptInput.focus();
        }
    });
    
    const killActiveTask = async () => {
        if (!currentTaskId) return;
        try {
            if (terminalStatusText) terminalStatusText.textContent = 'Killing...';
            await NanaAPI.stopTerminalCommand(currentTaskId);
            
            if (terminalInterval) {
                clearInterval(terminalInterval);
                terminalInterval = null;
            }
            currentTaskId = null;
            
            const killLine = document.createElement('div');
            killLine.className = 'terminal-line';
            killLine.style.color = 'var(--error)';
            killLine.textContent = '^C (Task terminated)';
            terminalHistory.appendChild(killLine);
            
            if (terminalPromptInput) {
                terminalPromptInput.disabled = false;
                terminalPromptInput.value = '';
            }
            if (terminalInputLine) terminalInputLine.style.opacity = '1';
            terminalPromptInput?.focus();
            if (btnKillTerminal) btnKillTerminal.classList.add('hidden');
            if (terminalStatusText) terminalStatusText.textContent = '';
            if (terminalBody) terminalBody.scrollTop = terminalBody.scrollHeight;
        } catch (e) {
            console.error("Failed to stop terminal command", e);
        }
    };
    
    btnKillTerminal?.addEventListener('click', killActiveTask);
    
    // Handle shortcut keys (Ctrl+C, Escape) globally while task is running
    document.addEventListener('keydown', (e) => {
        if (currentTaskId) {
            if (e.key === 'Escape' || (e.ctrlKey && e.key === 'c')) {
                e.preventDefault();
                killActiveTask();
            }
        }
    });
    
    terminalPromptInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const cmd = terminalPromptInput.value.trim();
            terminalPromptInput.value = '';
            if (!cmd) return;
            
            // Save history
            cmdHistory.push(cmd);
            cmdHistoryIndex = cmdHistory.length;
            
            // Print command line
            const promptText = terminalPromptPrefix ? terminalPromptPrefix.textContent : 'nana-assistant@local:~$';
            const cmdLine = document.createElement('div');
            cmdLine.className = 'terminal-line';
            cmdLine.innerHTML = `<span style="color: var(--accent); font-weight: 600;">${promptText}</span> <span style="color: #fff;">${escapeHtml(cmd)}</span>`;
            terminalHistory.appendChild(cmdLine);
            terminalBody.scrollTop = terminalBody.scrollHeight;
            
            // Safety Check: block dangerous commands on frontend
            const blocked = ["rm -rf /", "del /s", "format", "shutdown"];
            const isBlocked = blocked.some(term => cmd.toLowerCase().includes(term));
            if (isBlocked) {
                const errLine = document.createElement('div');
                errLine.className = 'terminal-line';
                errLine.style.color = 'var(--error)';
                errLine.textContent = 'Error: Command contains blocked terms and cannot be executed.';
                terminalHistory.appendChild(errLine);
                terminalBody.scrollTop = terminalBody.scrollHeight;
                return;
            }
            
            try {
                // Disable input during run
                terminalPromptInput.disabled = true;
                if (terminalInputLine) terminalInputLine.style.opacity = '0.5';
                
                if (btnKillTerminal) btnKillTerminal.classList.remove('hidden');
                if (terminalStatusText) terminalStatusText.textContent = 'Running...';
                
                // Create output block
                const outputBlock = document.createElement('pre');
                outputBlock.style.margin = '4px 0 12px 0';
                outputBlock.style.whiteSpace = 'pre-wrap';
                outputBlock.style.wordBreak = 'break-all';
                outputBlock.style.fontFamily = 'var(--font-mono)';
                outputBlock.style.color = '#ccc';
                terminalHistory.appendChild(outputBlock);
                terminalBody.scrollTop = terminalBody.scrollHeight;
                
                const res = await NanaAPI.runTerminalCommand(cmd);
                currentTaskId = res.task_id;
                
                if (terminalInterval) clearInterval(terminalInterval);
                terminalInterval = setInterval(async () => {
                    if (!currentTaskId) return;
                    try {
                        const status = await NanaAPI.getTerminalStatus(currentTaskId);
                        outputBlock.textContent = status.output || '';
                        terminalBody.scrollTop = terminalBody.scrollHeight;
                        
                        if (!status.is_running) {
                            clearInterval(terminalInterval);
                            terminalInterval = null;
                            currentTaskId = null;
                            
                            terminalPromptInput.disabled = false;
                            if (terminalInputLine) terminalInputLine.style.opacity = '1';
                            terminalPromptInput.focus();
                            if (btnKillTerminal) btnKillTerminal.classList.add('hidden');
                            if (terminalStatusText) terminalStatusText.textContent = '';
                        }
                    } catch (e) {
                        clearInterval(terminalInterval);
                        terminalInterval = null;
                        currentTaskId = null;
                        terminalPromptInput.disabled = false;
                        if (terminalInputLine) terminalInputLine.style.opacity = '1';
                        if (btnKillTerminal) btnKillTerminal.classList.add('hidden');
                        if (terminalStatusText) terminalStatusText.textContent = '';
                    }
                }, 800);
            } catch (e) {
                const errLine = document.createElement('div');
                errLine.className = 'terminal-line';
                errLine.style.color = 'var(--error)';
                errLine.textContent = `Failed to start: ${e.message}`;
                terminalHistory.appendChild(errLine);
                
                terminalPromptInput.disabled = false;
                if (terminalInputLine) terminalInputLine.style.opacity = '1';
                if (btnKillTerminal) btnKillTerminal.classList.add('hidden');
                if (terminalStatusText) terminalStatusText.textContent = '';
                terminalBody.scrollTop = terminalBody.scrollHeight;
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (cmdHistoryIndex > 0) {
                cmdHistoryIndex--;
                terminalPromptInput.value = cmdHistory[cmdHistoryIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (cmdHistoryIndex < cmdHistory.length - 1) {
                cmdHistoryIndex++;
                terminalPromptInput.value = cmdHistory[cmdHistoryIndex];
            } else {
                cmdHistoryIndex = cmdHistory.length;
                terminalPromptInput.value = '';
            }
        }
    });
});

