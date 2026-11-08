import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, makeLedger, recordTurn, recordingBasis, viewLedger } from './history.mjs';
import { check, coreRoster, text } from './world.mjs';

export const info = {
    id: 'living-world-engine',
    name: 'Living World Engine',
    description: 'World facts, role memories, and branch-aware snapshots for SillyTavern.',
};

const locks = new Map();

async function readLedger(file) {
    try {
        const ledger = JSON.parse(await readFile(file, 'utf8'));
        check(ledger?.version === 1 && ledger.turns && Array.isArray(ledger.anchor), '世界存档格式无法读取');
        return ledger;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function writeJson(dir, file, value) {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, '.' + randomUUID() + '.tmp');
    try {
        await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await rename(temp, file);
    } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') console.warn('[LWE] Unable to remove temporary file'); });
    }
}

async function inOrder(file, action) {
    const job = (locks.get(file) ?? Promise.resolve()).catch(() => {}).then(action);
    locks.set(file, job);
    try {
        return await job;
    } finally {
        if (locks.get(file) === job) locks.delete(file);
    }
}

function endpoint(action) {
    return async (req, res) => {
        const root = req.user?.directories?.root;
        if (!root) return res.sendStatus(401);
        try {
            const body = req.body;
            const owner = text(body?.scope?.owner, '角色或群组标识', 350);
            const chat = text(body?.scope?.chat, '聊天标识', 350);
            const dir = join(root, 'living-world-engine');
            const file = join(dir, digest(JSON.stringify([owner, chat])) + '.json');
            const result = await inOrder(file, async () => {
                const ledger = await readLedger(file);
                return action({ body, ledger, dir, file });
            });
            return res.json(result);
        } catch (error) {
            if (error.code || error instanceof SyntaxError) {
                console.error('[LWE]', error.code ?? error.name);
                return res.status(500).json({ error: '无法读取或保存世界记录，请检查酒馆服务。' });
            }
            return res.status(400).json({ error: error.message });
        }
    };
}

function inspect(ledger, body) {
    return viewLedger(ledger, body.history, {
        focus: typeof body.focus === 'string' ? body.focus.slice(-3000) : '',
        budget: Number.isFinite(body.budget) ? Math.max(800, Math.min(6000, Math.floor(body.budget))) : 6000,
    });
}

function recorderRoute(action) {
    return async (req, res) => {
        const root = req.user?.directories?.root;
        if (!root) return res.sendStatus(401);
        const dir = join(root, 'living-world-engine');
        const file = join(dir, 'recorder-connection.json');
        try {
            const data = await action({ req, dir, file });
            return res.json(data);
        } catch (error) {
            if (error.code || error instanceof SyntaxError) {
                console.error('[LWE recorder]', error.code ?? error.name);
                return res.status(500).json({ error: '无法读取或保存记录员连接。' });
            }
            return res.status(error.status ?? 400).json({ error: error.message });
        }
    };
}

async function readConnection(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function publicConnection(connection) {
    return {
        url: connection?.url ?? '', model: connection?.model ?? '',
        hasKey: Boolean(connection?.apiKey), test: connection?.test ?? null,
    };
}

function sameConnection(left, right) {
    return left && right && left.url === right.url && left.model === right.model && left.apiKey === right.apiKey;
}

function normalizeRecorderUrl(value) {
    const input = text(value, 'API 地址', 2048);
    let url;
    try {
        url = new URL(input);
    } catch {
        throw new Error('请输入完整的 HTTP 或 HTTPS API 地址。');
    }
    check(['http:', 'https:'].includes(url.protocol), 'API 地址需要使用 HTTP 或 HTTPS。');
    check(!url.username && !url.password && !url.search && !url.hash, '请把密钥填入单独的密钥栏，API 地址只填写路径。');
    url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/chat\/completions$/u, '');
    return url.href.replace(/\/$/u, '');
}

async function completeWithRecorder(connection, messages) {
    check(connection, '请先保存记录员的自定义接口。');
    check(Array.isArray(messages) && messages.length === 2
        && messages[0]?.role === 'system' && messages[1]?.role === 'user'
        && messages.every(message => typeof message.content === 'string' && message.content.length <= 1_000_000),
    '记录员请求格式不正确。');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (connection.apiKey) headers.Authorization = 'Bearer ' + connection.apiKey;
    let response;
    try {
        response = await fetch(connection.url + '/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: connection.model,
                messages: messages.map(({ role, content }) => ({ role, content })),
                stream: false,
                max_tokens: 3000,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(60_000),
        });
    } catch (error) {
        if (error.name === 'TimeoutError') {
            throw Object.assign(new Error('记录员的自定义接口请求超时，可补记当前回复。'), { status: 504 });
        }
        throw Object.assign(new Error('无法连接记录员的自定义接口，请检查 API 地址。'), { status: 502 });
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error('记录员的自定义接口返回 HTTP ' + response.status + '，请检查连接配置。'), { status: 502 });
    }
    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw Object.assign(new Error('记录员的自定义接口没有返回有效的聊天补全内容。'), { status: 502 });
    }
    return { content };
}

export async function init(router) {
    router.get('/health', (req, res) => res.json({ ok: true, version: 1 }));
    router.get('/recorder-connection', recorderRoute(async ({ file }) => publicConnection(await readConnection(file))));
    router.post('/recorder-connection', recorderRoute(({ req, dir, file }) => inOrder(file, async () => {
        const body = req.body;
        const url = normalizeRecorderUrl(body?.url);
        const model = text(body?.model, '模型 ID', 240);
        const previous = await readConnection(file);
        const apiKey = body?.apiKey === undefined
            ? (previous?.url === url ? previous.apiKey : '')
            : (body.apiKey === null ? '' : text(body.apiKey, 'API 密钥', 4096));
        check(!apiKey || /^[!-~]+$/u.test(apiKey), 'API 密钥需要是单行字符，请检查是否复制完整。');
        const connection = { url, model, apiKey };
        if (sameConnection(previous, connection)) connection.test = previous.test;
        await writeJson(dir, file, connection);
        return publicConnection(connection);
    })));
    router.post('/recorder-completion', recorderRoute(async ({ req, file }) => {
        return completeWithRecorder(await readConnection(file), req.body?.messages);
    }));
    router.post('/recorder-test', recorderRoute(async ({ dir, file }) => {
        const connection = await readConnection(file);
        check(connection, '请先保存记录员的自定义接口。');
        let test;
        try {
            await completeWithRecorder(connection, [
                { role: 'system', content: '这是一条连接测试。请只回复 OK。' },
                { role: 'user', content: '请回复 OK。' },
            ]);
            test = { ok: true, checkedAt: new Date().toISOString() };
        } catch (error) {
            test = { ok: false, checkedAt: new Date().toISOString(), detail: error.message };
        }
        return inOrder(file, async () => {
            const latest = await readConnection(file);
            check(sameConnection(latest, connection), '接口配置已更新，请刷新后重新测试。');
            latest.test = test;
            await writeJson(dir, file, latest);
            return publicConnection(latest);
        });
    }));
    router.post('/view', endpoint(({ body, ledger }) => {
        const view = inspect(ledger, body);
        if (ledger && body.retry && view.status === 'conflict') {
            view.retryBasis = recordingBasis(ledger, body.history, true);
        }
        return view;
    }));
    router.post('/seed', endpoint(async ({ body, ledger, dir, file }) => {
        const status = inspect(ledger, body).status;
        check(status === 'missing' || (status === 'rebuild' && body.rebuild === true), '当前聊天已经有世界记录');
        const created = makeLedger(body.seed, body.history);
        if (ledger) await writeJson(dir, file + '.' + ledger.epoch + '.backup', ledger);
        await writeJson(dir, file, created);
        return inspect(created, body);
    }));
    router.post('/core', endpoint(async ({ body, ledger, dir, file }) => {
        const view = inspect(ledger, body);
        check(view.state && view.epoch === body.epoch, '世界起点已变化，请刷新后再保存核心角色');
        check(view.rosterVersion === body.rosterVersion, '核心角色名单已更新，请刷新后再保存');
        ledger.core = coreRoster(body.core, ledger.initial);
        await writeJson(dir, file, ledger);
        return inspect(ledger, body);
    }));
    router.post('/record', endpoint(async ({ body, ledger, dir, file }) => {
        if (recordTurn(ledger, body)) await writeJson(dir, file, ledger);
        return inspect(ledger, body);
    }));
}
