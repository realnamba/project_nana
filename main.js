const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let backendProcess;
let apiToken = null;
const { spawnSync } = require('child_process');

function verifyVenv(candidate) {
    console.log(`[Nana] Verifying venv at ${candidate.pythonExe} ...`);
    if (!fs.existsSync(candidate.pythonExe)) {
        const errMsg = `Virtual environment Python executable is missing. Checked: ${candidate.pythonExe}`;
        console.error(`[Nana] venv check: FAILED (${errMsg})`);
        throw new Error(errMsg + " Please run setup.ps1 to create the environment.");
    }
    
    const result = spawnSync(candidate.pythonExe, ['-c', 'import sys'], { timeout: 3000 });
    if (result.status !== 0 || result.error) {
        let details = "";
        if (result.status === 103) {
            details = "Exit code 103: Base Python interpreter missing/moved";
        } else if (result.error) {
            details = result.error.message;
        } else {
            details = `Exit code ${result.status}`;
        }
        console.error(`[Nana] venv check: FAILED (${details})`);
        throw new Error(`Python virtual environment is broken or not runnable (${details}). Please run setup.ps1 to repair your environment.`);
    }
    console.log("[Nana] venv check: OK");
}

const BACKEND_PORT = 8777;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

function getBaseDir() {
    return findBackendDir().rootDir;
}

function getBackendCandidates() {
    const roots = app.isPackaged
        ? [path.dirname(process.execPath), process.resourcesPath]
        : [__dirname];

    return roots.map((rootDir) => ({
        rootDir,
        backendDir: path.join(rootDir, 'backend'),
        pythonExe: path.join(rootDir, 'backend', 'venv', 'Scripts', 'python.exe'),
        runScript: path.join(rootDir, 'backend', 'run.py'),
    }));
}

function findBackendDir() {
    const candidates = getBackendCandidates();
    const found = candidates.find((candidate) =>
        fs.existsSync(candidate.pythonExe) && fs.existsSync(candidate.runScript)
    );

    if (!found) {
        const checked = candidates.map((candidate) => candidate.pythonExe).join('\n');
        throw new Error(`Python backend runtime was not found. Checked:\n${checked}`);
    }

    return found;
}

function getNanaDataDir() {
    if (app.isPackaged) {
        return process.env.PORTABLE_EXECUTABLE_DIR
            ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'NanaData')
            : path.join(app.getPath('userData'), 'NanaData');
    }
    return __dirname;
}

function getModelsDir() {
    return path.resolve(getNanaDataDir(), 'models');
}

ipcMain.handle('nana:open-models-folder', async (_event, folderPath) => {
    // Accept the backend-reported path if it's a valid existing directory,
    // otherwise fall back to our computed models dir
    let targetDir = getModelsDir();
    if (folderPath && typeof folderPath === 'string') {
        const requested = path.resolve(folderPath);
        if (fs.existsSync(requested)) {
            targetDir = requested;
        }
    }
    // Ensure the directory exists
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    const err = await shell.openPath(targetDir);
    return err || '';
});

ipcMain.handle('nana:get-data-dir', () => {
    return getNanaDataDir();
});

ipcMain.handle('nana:get-token', () => {
    return apiToken;
});

ipcMain.handle('nana:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) {
        return null;
    }
    return result.filePaths[0];
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: "Nana — Local AI Assistant",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    mainWindow.setMenu(null);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(BACKEND_URL)) {
            event.preventDefault();
        }
    });
}

function startBackend() {
    return new Promise((resolve, reject) => {
        let backend;
        try {
            backend = findBackendDir();
            verifyVenv(backend);
        } catch (e) {
            reject(e);
            return;
        }

        const nanaDataDir = getNanaDataDir();

        console.log("[Nana] Spawning backend process ...");
        // Increase timeout for cold starts in portable env
        backendProcess = spawn(backend.pythonExe, [backend.runScript], {
            cwd: backend.backendDir,
            env: { ...process.env, NANA_DATA_DIR: nanaDataDir }
        });

        let settled = false;
        let checkInterval = null;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            if (checkInterval) clearInterval(checkInterval);
            reject(error);
        };

        backendProcess.stdout.on('data', (data) => {
            const line = data.toString();
            const match = line.match(/NANA_API_TOKEN:([a-f0-9]{64})/);
            if (match) {
                apiToken = match[1];
                console.log("Captured API Token from backend.");
            }
            console.log(`Backend: ${data}`);
        });

        backendProcess.stderr.on('data', (data) => {
            console.error(`Backend Error: ${data}`);
        });

        backendProcess.on('error', (error) => {
            fail(new Error(`Failed to start Python backend at ${backend.pythonExe}: ${error.message}`));
        });

        backendProcess.on('exit', (code, signal) => {
            console.log(`[Nana] Backend exited with code=${code} signal=${signal}`);
            if (!settled && code !== 0) {
                let msg = `Python backend exited early with code ${code}.`;
                if (code === 103) {
                    msg = `Python backend exited early with code 103 (Base interpreter not found). Please run setup.ps1 to repair your virtual environment.`;
                }
                fail(new Error(msg));
            }
        });

        let retries = 120; // 60 seconds (120 * 500ms)
        checkInterval = setInterval(() => {
            const headers = {};
            if (apiToken) {
                headers['X-Nana-Token'] = apiToken;
            }
            http.get(`${BACKEND_URL}/api/status`, { headers }, (res) => {
                if (!settled && res.statusCode === 200) {
                    settled = true;
                    clearInterval(checkInterval);
                    resolve();
                }
            }).on('error', () => {
                retries--;
                if (retries <= 0) {
                    fail(new Error(`Backend failed to start in time from ${backend.backendDir}.`));
                }
            });
        }, 500);
    });
}

app.whenReady().then(async () => {
    try {
        await startBackend();
        createWindow();
        mainWindow.loadURL(BACKEND_URL);
    } catch (e) {
        console.error(`[Nana] Backend Startup FAILED: ${e.message}`);
        dialog.showErrorBox(
            'Backend Error',
            'Failed to start the Nana Python backend. Ensure the virtual environment exists and port 8777 is free.\n\nDetails: ' +
                e.message
        );
        console.log("[Nana] User acknowledged error, quitting.");
        app.quit();
    }

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    if (backendProcess) {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', backendProcess.pid, '/f', '/t']);
        } else {
            try {
                backendProcess.kill('SIGTERM');
            } catch (_) {
                /* ignore */
            }
        }
    }
});
