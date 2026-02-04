const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let controlWindow;
let targetWindow;
let clickCount = 0;
let targetCount = 100;
let isRunning = false;
let currentPrompt = '';

const downloadDir = path.join(app.getPath('userData'), 'downloads');
const localDownloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(localDownloadDir)) {
    fs.mkdirSync(localDownloadDir);
}

// Helper: Calculate SHA-256 Hash
let savedImageHashes = new Set(); // Track content hashes
function calculateHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Helper: Save Image with Hash Check
async function saveImageIfUnique(buffer, index) {
    const hash = calculateHash(buffer);
    if (savedImageHashes.has(hash)) {
        console.log(`Duplicate image detected (Hash: ${hash.substring(0, 8)}...), skipping.`);
        return false; // Duplicate
    }

    savedImageHashes.add(hash);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Using simple naming scheme
    const byteFilename = `image_${index}_${timestamp}.png`;
    const filepath = path.join(localDownloadDir, byteFilename);

    fs.writeFile(filepath, buffer, (err) => {
        if (err) console.error('Write error:', err);
        else console.log('Saved:', filepath);
    });
    return true;
}

// Helper to track saved images by URL (optimization to avoid re-fetching)
let savedImageUrls = new Set();

function createWindows() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const controlWidth = 320;

    controlWindow = new BrowserWindow({
        x: 0,
        y: 0,
        width: controlWidth,
        height: height,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'Control',
        autoHideMenuBar: true
    });

    controlWindow.loadFile('index.html');

    targetWindow = new BrowserWindow({
        x: controlWidth,
        y: 0,
        width: width - controlWidth,
        height: height,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        title: 'ImageFX'
    });

    targetWindow.loadURL('https://labs.google/fx/ja/tools/image-fx');

    controlWindow.on('closed', () => { controlWindow = null; if (targetWindow) targetWindow.close(); });
    targetWindow.on('closed', () => { targetWindow = null; if (controlWindow) controlWindow.close(); });
}

app.whenReady().then(() => {
    createWindows();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('start-automation', async (event, count, prompt) => {
    savedImageUrls = new Set(); // Reset on new run
    savedImageHashes = new Set(); // Reset hashes

    if (isRunning) return;
    targetCount = count || 100;
    currentPrompt = prompt || '';
    clickCount = 0;
    isRunning = true;

    console.log(`Start: ${targetCount}`);
    controlWindow.webContents.send('update-status', `開始: ${targetCount}回`);
    runAutomationStep();
});

async function runAutomationStep() {
    if (!isRunning || !targetWindow || targetWindow.isDestroyed()) {
        stopAutomation();
        return;
    }

    if (clickCount >= targetCount) {
        controlWindow.webContents.send('automation-finished');
        stopAutomation();
        return;
    }

    controlWindow.webContents.send('update-status', `生成中... (${clickCount + 1}/${targetCount})`);

    try {
        // 1. Click Generate
        const clickResult = await targetWindow.webContents.executeJavaScript(`
            (function() {
                const buttons = Array.from(document.querySelectorAll('button'));
                const generateBtn = buttons.find(b => 
                    b.innerText.includes('作成') || 
                    b.innerText.includes('Generate') || 
                    b.innerText.includes('Create')
                );

                if (generateBtn && !generateBtn.disabled && generateBtn.offsetParent !== null) {
                    generateBtn.click();
                    return 'Clicked';
                }
                return 'Button not found or disabled';
            })();
        `);

        if (clickResult !== 'Clicked') {
            controlWindow.webContents.send('update-status', `待機中... (${clickResult})`);
            setTimeout(runAutomationStep, 3000);
            return;
        }

        // 2. Wait for generation (~25s)
        controlWindow.webContents.send('update-status', '生成完了を待機中...');
        await new Promise(resolve => setTimeout(resolve, 25000));

        if (!isRunning) return;

        // 3. Scan for NEW images
        controlWindow.webContents.send('update-status', '画像をスキャン中...');

        // Retrieve ALL candidate image sources/data from the page
        const foundImages = await targetWindow.webContents.executeJavaScript(`
            (function() {
                const images = Array.from(document.querySelectorAll('img'));
                
                // Filter for result candidate images
                const candidates = images.filter(img => {
                    const isResult = img.alt && (img.alt.includes('生成された画像') || img.alt.includes('Generated image'));
                    const isLarge = img.width > 200 && img.height > 200; 
                    return (isResult || isLarge) && img.src;
                });
                
                // Return just the source URLs/Data Strings
                return candidates.map(img => img.src);
            })();
        `);

        // Filter unique ones we haven't saved BY URL first (optimization)
        const uniqueNewImages = foundImages.filter(src => !savedImageUrls.has(src));

        if (uniqueNewImages.length > 0) {
            controlWindow.webContents.send('update-status', `画像候補 ${uniqueNewImages.length}枚を処理中...`);

            let savedCount = 0;
            // Process sequentially to be safe
            for (let i = 0; i < uniqueNewImages.length; i++) {
                const src = uniqueNewImages[i];
                savedImageUrls.add(src); // Mark URL as processed

                try {
                    let buffer;
                    if (src.startsWith('data:image')) {
                        // Data URL
                        const base64Data = src.split(';base64,').pop();
                        buffer = Buffer.from(base64Data, 'base64');
                    } else if (src.startsWith('http')) {
                        // Http URL
                        buffer = await new Promise((resolve, reject) => {
                            require('https').get(src, (res) => {
                                const chunks = [];
                                res.on('data', chunk => chunks.push(chunk));
                                res.on('end', () => resolve(Buffer.concat(chunks)));
                                res.on('error', reject);
                            }).on('error', reject);
                        });
                    }

                    if (buffer) {
                        const isSaved = await saveImageIfUnique(buffer, `${clickCount}_${i}`);
                        if (isSaved) savedCount++;
                    }
                } catch (e) {
                    console.error('Save failed', e);
                }
            }

            if (savedCount > 0) {
                controlWindow.webContents.send('update-status', `${savedCount}枚の新規画像を保存しました`);
            } else {
                controlWindow.webContents.send('update-status', '新規画像なし (重複のみ)');
            }
        } else {
            controlWindow.webContents.send('update-status', '新しい画像が見つかりませんでした');
        }

        clickCount++;
        controlWindow.webContents.send('update-count', clickCount);
        setTimeout(runAutomationStep, 2000);

    } catch (error) {
        console.error('Error:', error);
        controlWindow.webContents.send('update-status', 'エラー: ' + error.message);
        setTimeout(runAutomationStep, 5000);
    }
}

function stopAutomation() {
    isRunning = false;
    if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('update-status', '停止しました');
    }
}

ipcMain.on('stop-automation', stopAutomation);
