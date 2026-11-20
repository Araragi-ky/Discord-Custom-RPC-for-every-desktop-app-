import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import RPC from 'discord-rpc';
import { openWindows } from 'get-windows';

try { process.loadEnvFile(); } catch {}

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const PORT = 3000;
const UPLOAD_DIR = path.resolve('./uploads');

const ACTIVITY_LABELS = {
    0: 'Playing',
    2: 'Listening to',
    3: 'Watching',
    5: 'Competing in'
};

const EXT_TO_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
};

const MIME_TO_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp'
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const rpc = new RPC.Client({ transport: 'ipc' });
const appStartTime = Date.now();
const iconBase64Cache = new Map();
const iconUrlCache = new Map();
const logs = [];
let rpcReady = false;

function addLog(type, message) {
    const time = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    logs.push({ time, type, message });
    if (logs.length > 100) logs.shift();
}

rpc.on('ready', () => {
    rpcReady = true;
    addLog('success', 'Connected to Discord.');
});

if (CLIENT_ID) {
    rpc.login({ clientId: CLIENT_ID }).catch((err) => {
        addLog('error', `Discord connection failed: ${err.message || 'Check Client ID or open Discord.'}`);
    });
} else {
    addLog('warn', 'DISCORD_CLIENT_ID is missing. Add it to your .env file.');
}

function extractExeIcon(exePath) {
    return new Promise((resolve) => {
        if (!exePath) return resolve(null);
        if (iconBase64Cache.has(exePath)) return resolve(iconBase64Cache.get(exePath));

        const psScript = `
            Add-Type -AssemblyName System.Drawing
            $bmp = $null
            try {
                $code = @"
using System;
using System.Runtime.InteropServices;
public class HiResIcon {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHDefExtractIconW(string pszIconFile, int iIndex, uint uFlags, out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIconSize);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
"@
                Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
                $large = [IntPtr]::Zero
                $small = [IntPtr]::Zero
                [HiResIcon]::SHDefExtractIconW($env:EXE_PATH, 0, 0, [ref]$large, [ref]$small, 256) | Out-Null
                if ($large -ne [IntPtr]::Zero) {
                    $bmp = [System.Drawing.Icon]::FromHandle($large).ToBitmap()
                    [HiResIcon]::DestroyIcon($large) | Out-Null
                }
                if ($small -ne [IntPtr]::Zero) {
                    [HiResIcon]::DestroyIcon($small) | Out-Null
                }
            } catch {}

            if (-not $bmp) {
                $fallback = [System.Drawing.Icon]::ExtractAssociatedIcon($env:EXE_PATH)
                if ($fallback) { $bmp = $fallback.ToBitmap() }
            }
            if ($bmp) {
                $ms = New-Object System.IO.MemoryStream
                $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                [Convert]::ToBase64String($ms.ToArray())
            }
        `;

        execFile('powershell', ['-NoProfile', '-Command', psScript], {
            env: { ...process.env, EXE_PATH: exePath },
            maxBuffer: 1024 * 1024 * 5
        }, (err, stdout) => {
            const b64 = stdout ? stdout.trim() : '';
            if (err || !b64) return resolve(null);
            iconBase64Cache.set(exePath, b64);
            resolve(b64);
        });
    });
}

async function uploadBufferToHost(buffer) {
    try {
        const form = new FormData();
        form.append('files[]', new Blob([buffer], { type: 'image/png' }), 'icon.png');
        const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form });
        const json = await res.json();
        if (json?.files?.[0]?.url) return json.files[0].url;
    } catch {}

    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '24h');
        form.append('fileToUpload', new Blob([buffer], { type: 'image/png' }), 'icon.png');
        const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form });
        const url = (await res.text()).trim();
        if (url.startsWith('https://')) return url;
    } catch {}

    addLog('warn', 'Could not upload app icon to image host.');
    return null;
}

async function uploadExeIcon(exePath) {
    if (!exePath) return null;
    if (iconUrlCache.has(exePath)) return iconUrlCache.get(exePath);

    const b64 = await extractExeIcon(exePath);
    if (!b64) {
        addLog('warn', 'Could not extract icon for the selected app.');
        return null;
    }

    const url = await uploadBufferToHost(Buffer.from(b64, 'base64'));
    if (url) {
        iconUrlCache.set(exePath, url);
        addLog('info', 'App icon ready.');
    }
    return url;
}

// Discord rejects external asset URLs longer than 256 characters
async function prepareImageUrl(url) {
    if (!url) return null;
    if (!url.startsWith('http') || url.length <= 256) return url;
    if (iconUrlCache.has(url)) return iconUrlCache.get(url);

    try {
        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());
        const shortUrl = await uploadBufferToHost(buffer);
        if (shortUrl) {
            iconUrlCache.set(url, shortUrl);
            addLog('info', 'Shortened long image URL.');
            return shortUrl;
        }
    } catch {
        addLog('warn', 'Failed to re-host long image URL.');
    }
    return null;
}

function normalizeUrl(url) {
    if (!url) return '';
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function serveUploadedAsset(prefix, res) {
    for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
        const filePath = path.join(UPLOAD_DIR, `${prefix}${ext}`);
        if (fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
            return fs.createReadStream(filePath).pipe(res);
        }
    }
    res.writeHead(404);
    res.end();
}

function saveUploadedAsset(prefix, label, req, res) {
    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_TO_EXT[mime];
    if (!ext) {
        addLog('error', `${label} update failed: unsupported image format.`);
        res.writeHead(400);
        return res.end('Unsupported image format.');
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        try {
            for (const oldExt of Object.keys(EXT_TO_MIME)) {
                const oldPath = path.join(UPLOAD_DIR, `${prefix}${oldExt}`);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            fs.writeFileSync(path.join(UPLOAD_DIR, `${prefix}${ext}`), Buffer.concat(chunks));
            addLog('success', `${label} updated (${ext.slice(1).toUpperCase()}).`);
            res.writeHead(200);
            res.end(`${label} updated.`);
        } catch {
            addLog('error', `Failed to save ${label.toLowerCase()}.`);
            res.writeHead(500);
            res.end('Failed to save image.');
        }
    });
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(err);
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const { pathname } = reqUrl;

    if (req.method === 'GET' && pathname === '/') {
        const html = fs.readFileSync('./index.html', 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(html);
    }

    if (req.method === 'GET' && pathname === '/assets/bg') {
        return serveUploadedAsset('bg', res);
    }
    if (req.method === 'POST' && pathname === '/assets/bg') {
        return saveUploadedAsset('bg', 'Background', req, res);
    }

    if (req.method === 'GET' && pathname === '/assets/pfp') {
        return serveUploadedAsset('pfp', res);
    }
    if (req.method === 'POST' && pathname === '/assets/pfp') {
        return saveUploadedAsset('pfp', 'Profile picture', req, res);
    }

    if (req.method === 'GET' && pathname === '/logs') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(logs));
    }

    if (req.method === 'POST' && pathname === '/clear-logs') {
        logs.length = 0;
        addLog('info', 'Logs cleared.');
        res.writeHead(200);
        return res.end('Cleared');
    }

    if (req.method === 'GET' && pathname === '/apps') {
        try {
            const windows = await openWindows();
            const apps = windows
                .filter(w => w.owner?.name && w.title)
                .map(w => ({
                    appName: w.owner.name.replace(/\.exe$/i, ''),
                    title: w.title,
                    path: w.owner.path || ''
                }));

            addLog('info', `Found ${apps.length} open window(s).`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(apps));
        } catch {
            addLog('error', 'Could not scan open windows.');
            res.writeHead(500);
            return res.end(JSON.stringify({ error: 'Could not scan open windows.' }));
        }
    }

    if (req.method === 'GET' && pathname === '/icon') {
        const b64 = await extractExeIcon(reqUrl.searchParams.get('path'));
        if (!b64) {
            res.writeHead(404);
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from(b64, 'base64'));
    }

    if (req.method === 'POST' && pathname === '/set-rpc') {
        if (!rpcReady) {
            addLog('error', 'Discord is not connected.');
            res.writeHead(503);
            return res.end('Discord is not connected yet.');
        }

        try {
            const data = await readJsonBody(req);
            const activityType = Number(data.activityType) || 0;
            const activity = { type: activityType };

            if (data.details?.length >= 2) activity.details = data.details.slice(0, 128);
            if (data.state?.length >= 2) activity.state = data.state.slice(0, 128);

            const largeImage = data.largeImage
                ? await prepareImageUrl(data.largeImage)
                : await uploadExeIcon(data.exePath);
            const smallImage = await prepareImageUrl(data.smallImage);

            const assets = {};
            if (largeImage) assets.large_image = largeImage;
            if (data.largeText?.length >= 2) assets.large_text = data.largeText.slice(0, 128);
            if (data.largeUrl) assets.large_url = normalizeUrl(data.largeUrl);

            if (smallImage) assets.small_image = smallImage;
            if (data.smallText?.length >= 2) assets.small_text = data.smallText.slice(0, 128);
            if (data.smallUrl) assets.small_url = normalizeUrl(data.smallUrl);

            if (Object.keys(assets).length > 0) activity.assets = assets;

            const buttons = [];
            if (data.btn1Text && data.btn1Url) {
                buttons.push({ label: data.btn1Text.slice(0, 32), url: normalizeUrl(data.btn1Url) });
            }
            if (data.btn2Text && data.btn2Url) {
                buttons.push({ label: data.btn2Text.slice(0, 32), url: normalizeUrl(data.btn2Url) });
            }
            if (buttons.length > 0) activity.buttons = buttons;

            const timestamps = {};
            if (data.timestampMode === 'now') {
                timestamps.start = Math.floor(Date.now() / 1000);
            } else if (data.timestampMode === 'since_open') {
                timestamps.start = Math.floor(appStartTime / 1000);
            } else if (data.timestampMode === 'current_time') {
                const now = new Date();
                const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                timestamps.start = Math.floor(midnight / 1000);
            } else if (data.timestampMode === 'custom') {
                const rawStart = Number(data.startTimestamp);
                const rawEnd = Number(data.endTimestamp);
                if (rawStart >= 1) timestamps.start = rawStart > 1e11 ? Math.floor(rawStart / 1000) : Math.floor(rawStart);
                if (rawEnd >= 1) timestamps.end = rawEnd > 1e11 ? Math.floor(rawEnd / 1000) : Math.floor(rawEnd);
            }
            if (Object.keys(timestamps).length > 0) activity.timestamps = timestamps;

            await rpc.request('SET_ACTIVITY', { pid: process.pid, activity });

            const label = ACTIVITY_LABELS[activityType] || 'Playing';
            const summary = activity.details || activity.state || 'Custom Status';
            addLog('success', `RPC updated: ${label} — ${summary}`);

            res.writeHead(200);
            return res.end('Updated!');
        } catch (err) {
            const msg = err?.message || 'Invalid RPC fields.';
            addLog('error', `RPC rejected: ${msg}`);
            res.writeHead(400);
            return res.end(msg);
        }
    }

    if (req.method === 'POST' && pathname === '/clear-rpc') {
        if (rpcReady) {
            await rpc.request('SET_ACTIVITY', { pid: process.pid }).catch(() => {});
        }
        addLog('info', 'RPC cleared.');
        res.writeHead(200);
        return res.end('Cleared!');
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Listening on ${url}`);
    addLog('info', 'Server started.');
    exec(`start ${url}`);
});