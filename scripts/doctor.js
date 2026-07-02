const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const net = require('net');

console.log("==================================================");
console.log("          Project Nana Environment Doctor         ");
console.log("==================================================");
console.log("");

let passed = true;

// 1. Check Virtual Environment
const isWindows = process.platform === 'win32';
const pythonExe = isWindows
    ? path.join(__dirname, '..', 'backend', 'venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', 'backend', 'venv', 'bin', 'python');

console.log(`[Doctor] Checking virtual environment path: ${pythonExe}`);
if (fs.existsSync(pythonExe)) {
    console.log("  => [PASS] Venv Python binary exists.");
    
    // Test runnability and version
    const checkResult = spawnSync(pythonExe, ['-c', "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], { encoding: 'utf8', timeout: 5000 });
    if (checkResult.status === 0) {
        const version = checkResult.stdout.trim();
        console.log(`  => [PASS] Venv Python is runnable. Version: ${version}`);
        const [major, minor] = version.split('.').map(Number);
        if (major === 3 && minor >= 10) {
            console.log("  => [PASS] Python version is >= 3.10.");
        } else {
            console.log(`  => [FAIL] Python version is ${version}. Required version is >= 3.10.`);
            passed = false;
        }
    } else {
        const errorDetail = checkResult.error ? checkResult.error.message : `Exit code ${checkResult.status}`;
        console.log(`  => [FAIL] Venv Python is not runnable: ${errorDetail}`);
        passed = false;
    }
} else {
    console.log("  => [FAIL] Venv Python binary does not exist.");
    passed = false;
}

console.log("");

// 2. Check Port 8777 Availability
console.log("[Doctor] Checking Port 8777 availability...");
const checkPort = (port) => {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve({ free: false, reason: "Port is already in use by another process." });
            } else {
                resolve({ free: false, reason: err.message });
            }
        });
        server.once('listening', () => {
            server.close();
            resolve({ free: true });
        });
        server.listen(port, '127.0.0.1');
    });
};

async function runPortCheck() {
    const portResult = await checkPort(8777);
    if (portResult.free) {
        console.log("  => [PASS] Port 8777 is free and available.");
    } else {
        console.log(`  => [FAIL] Port 8777 check failed: ${portResult.reason}`);
        passed = false;
    }

    console.log("");
    console.log("==================================================");
    if (passed) {
        console.log("  [SUCCESS] All system checks passed! Your environment is ready.");
        console.log("==================================================");
        process.exit(0);
    } else {
        console.log("  [FAILURE] Some checks failed. Please run setup.ps1 to repair.");
        console.log("==================================================");
        process.exit(1);
    }
}

runPortCheck();
