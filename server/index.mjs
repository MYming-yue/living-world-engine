import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, makeLedger, recordTurn, recordingBasis, viewLedger } from './history.mjs';
import { check, text } from './world.mjs';

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

async function writeLedger(dir, file, ledger) {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, '.' + randomUUID() + '.tmp');
    try {
        await writeFile(temp, JSON.stringify(ledger), { flag: 'wx' });
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

export async function init(router) {
    router.get('/health', (req, res) => res.json({ ok: true, version: 1 }));
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
        if (ledger) await writeLedger(dir, file + '.' + ledger.epoch + '.backup', ledger);
        await writeLedger(dir, file, created);
        return inspect(created, body);
    }));
    router.post('/record', endpoint(async ({ body, ledger, dir, file }) => {
        if (recordTurn(ledger, body)) await writeLedger(dir, file, ledger);
        return inspect(ledger, body);
    }));
}
