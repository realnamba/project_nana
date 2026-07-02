/**
 * chat.js — Chat UI controller for Project Nana.
 * Manages message rendering, markdown formatting, and scroll behavior.
 */

const ChatUI = {
    messagesEl: null,
    welcomeScreen: null,
    isStreaming: false,
    currentStreamEl: null,

    init() {
        this.messagesEl = document.getElementById('messages');
        this.welcomeScreen = document.getElementById('welcomeScreen');
    },

    /** Hide welcome screen and show messages */
    hideWelcome() {
        if (this.welcomeScreen) {
            this.welcomeScreen.style.display = 'none';
        }
    },

    /** Show welcome screen (for new chat) */
    showWelcome() {
        if (this.welcomeScreen) {
            const greetings = [
                "Hello! I'm Nana",
                "Hey there! Ready to build something cool?",
                "Hi! How can I help you today?",
                "Welcome back! What are we working on?",
                "Hey! Ask me anything, I'm ready."
            ];
            const greeting = greetings[Math.floor(Math.random() * greetings.length)];
            
            const headingEl = this.welcomeScreen.querySelector('h2');
            if (headingEl) {
                headingEl.textContent = greeting;
            }
            
            const cardPool = [
                { icon: "🐛", label: "Debug code", action: "window.setPrompt('Help me debug this code')" },
                { icon: "💡", label: "Explain concept", action: "window.setPrompt('Explain this concept')" },
                { icon: "📸", label: "Capture screen", action: "window.captureAndSend()" },
                { icon: "⚡", label: "Optimize code", action: "window.setPrompt('How can I optimize this code?')" },
                { icon: "🧪", label: "Write unit tests", action: "window.setPrompt('Help me write unit tests for this')" },
                { icon: "🎭", label: "Tell a joke", action: "window.setPrompt('Tell me a programming joke')" }
            ];
            
            // Pick 3 random cards
            const shuffled = [...cardPool].sort(() => 0.5 - Math.random());
            const selectedCards = shuffled.slice(0, 3);
            
            const cardsContainer = this.welcomeScreen.querySelector('.welcome-cards');
            if (cardsContainer) {
                cardsContainer.innerHTML = selectedCards.map(card => `
                    <button class="welcome-card" onclick="${card.action}">
                        <span class="card-icon">${card.icon}</span>
                        <span>${card.label}</span>
                    </button>
                `).join('');
            }
            this.welcomeScreen.style.display = 'flex';
        }
    },

    /** Clear all messages */
    clear() {
        // Remove all message elements but keep welcome screen
        const messages = this.messagesEl.querySelectorAll('.message');
        messages.forEach(m => m.remove());
    },

    /**
     * Add a message bubble to the chat.
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - Message text
     * @param {string|null} imageB64 - Optional screenshot to show
     * @returns {HTMLElement} The message text element (for streaming updates)
     */
    addMessage(role, content, imageB64 = null) {
        this.hideWelcome();

        const msgEl = document.createElement('div');
        msgEl.className = `message ${role}`;

        const avatarLabel = role === 'user' ? 'You' : '✦';

        let imageHtml = '';
        if (imageB64 && role === 'user') {
            const src = imageB64.startsWith('data:') ? imageB64 : `data:image/jpeg;base64,${imageB64}`;
            imageHtml = `<img class="message-screenshot" src="${src}" alt="Screenshot">`;
        }

        msgEl.innerHTML = `
            <div class="message-avatar">${avatarLabel}</div>
            <div class="message-content">
                <div class="message-role">${role === 'user' ? 'You' : 'Nana'}</div>
                ${imageHtml}
                <div class="message-text">${this.formatMarkdown(content)}</div>
            </div>
        `;

        this.messagesEl.appendChild(msgEl);
        this.scrollToBottom();

        return msgEl.querySelector('.message-text');
    },

    /**
     * Start streaming an assistant message.
     * Returns functions to append tokens and finish.
     */
    startStream() {
        this.isStreaming = true;
        const textEl = this.addMessage('assistant', '');
 
        // Show thinking dots initially
        textEl.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';
        let rawContent = '';
        let firstToken = true;
 
        return {
            /** Append a token to the stream */
            append: (token, modelName) => {
                if (firstToken) {
                    textEl.innerHTML = '';
                    firstToken = false;
                }
                rawContent += token;
                
                if (modelName) {
                    let modelSec = textEl.querySelector(`[data-model="${modelName}"]`);
                    if (!modelSec) {
                        modelSec = document.createElement('div');
                        modelSec.setAttribute('data-model', modelName);
                        modelSec.className = 'council-model-section';
                        modelSec.style.cssText = 'margin-bottom: 20px; border-left: 2px solid var(--accent); padding-left: 10px;';
 
                        const chip = document.createElement('div');
                        chip.className = 'council-model-chip';
                        chip.style.cssText = 'display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 12px; background: rgba(124, 106, 239, 0.15); color: var(--accent); margin-bottom: 6px;';
                        chip.textContent = modelName;
 
                        const contentDiv = document.createElement('div');
                        contentDiv.className = 'council-model-content';
                        contentDiv.style.cssText = 'color: var(--text-primary); line-height: 1.5;';
 
                        modelSec.appendChild(chip);
                        modelSec.appendChild(contentDiv);
                        textEl.appendChild(modelSec);
                    }
                    
                    const contentDiv = modelSec.querySelector('.council-model-content');
                    if (contentDiv) {
                        let text = contentDiv.getAttribute('data-raw') || '';
                        text += token;
                        contentDiv.setAttribute('data-raw', text);
                        contentDiv.innerHTML = this.formatMarkdown(text);
                    }
                } else {
                    textEl.innerHTML = this.formatMarkdown(rawContent);
                }
                this.scrollToBottom();
            },
            /** Finish the stream */
            finish: () => {
                this.isStreaming = false;
                this.scrollToBottom();
                return rawContent;
            },
            /** Get raw content */
            getContent: () => rawContent,
        };
    },

    /**
     * Basic markdown → HTML formatter.
     * Handles code blocks, inline code, bold, italic, lists, and line breaks.
     */
    formatMarkdown(text) {
        if (!text) return '';

        let html = text;

        // Escape HTML entities (except already-safe content)
        html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Code blocks: ```lang\ncode\n```
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            let runBtn = '';
            const runLangs = ['bash', 'sh', 'cmd', 'powershell', 'ps1', 'shell'];
            if (lang && runLangs.includes(lang.toLowerCase())) {
                const safeCode = code.trim().replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                runBtn = `<button class="btn-run-cmd" style="margin-top: 8px; font-size: 12px; padding: 4px 8px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: inherit; cursor: pointer;" onclick="window.confirmRunCommand(this, '${safeCode}')">▶ Run command</button>`;
            } else {
                try {
                    const b64 = btoa(unescape(encodeURIComponent(code.trim())));
                    runBtn = `<button class="btn-preview-code" style="margin-top: 8px; font-size: 12px; padding: 4px 8px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: inherit; cursor: pointer;" onclick="window.previewCodeInEditor('${b64}')">📝 Preview in Editor</button>`;
                } catch(e) {
                    // Ignore encoding issues
                }
            }
            return `<div class="code-block-wrapper"><pre><code class="language-${lang || 'text'}">${code.trim()}</code></pre>${runBtn}</div>`;
        });

        // Propose Change block
        html = html.replace(/<proposeChange path="([^"]+)">([\s\S]*?)<\/proposeChange>/g, (_, path, content) => {
            try {
                const safeContent = btoa(unescape(encodeURIComponent(content.trim())));
                return `<div class="code-block-wrapper" style="border: 1px solid var(--accent); padding: 8px; border-radius: 4px; margin: 8px 0; background: rgba(124, 106, 239, 0.1);">
                    <div style="font-size: 11px; font-weight: bold; margin-bottom: 4px; color: var(--accent);">PROPOSED CHANGE: ${path}</div>
                    <button class="btn-run-cmd" style="font-size: 12px; padding: 4px 8px; background: var(--accent); color: #fff; border: none; border-radius: 4px; cursor: pointer;" onclick="window.Workspace.openReviewPanel('${path}', '${safeContent}')">Review Changes</button>
                </div>`;
            } catch(e) {
                return `<div>Failed to parse proposed change for ${path}</div>`;
            }
        });

        // Inline code: `code`
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Bold: **text**
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // Italic: *text*
        html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

        // Unordered lists
        html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

        // Line breaks → paragraphs
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');

        // Wrap in paragraph if not already wrapped
        if (!html.startsWith('<')) {
            html = `<p>${html}</p>`;
        }

        return html;
    },

    /** Scroll chat to bottom smoothly */
    scrollToBottom() {
        const container = document.getElementById('messagesContainer');
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    },

    /**
     * Load and display existing conversation messages.
     * @param {Array} messages - Array of message objects
     */
    loadMessages(messages) {
        this.clear();
        this.hideWelcome();
        messages.forEach(msg => {
            this.addMessage(msg.role, msg.content);
        });
    },
};
