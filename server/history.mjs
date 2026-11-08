import { createHash, randomUUID } from 'node:crypto';
import { applyProposal, check, coreRoster, inspectable, makeWorld, parseBackground, parseProposal, promptFor, text } from './world.mjs';

export function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

function fingerprint(entry) {
    check(['user', 'assistant'].includes(entry?.role), '消息身份无效');
    check(typeof entry.name === 'string' && entry.name.length <= 160, '消息名称无效');
    check(typeof entry.stamp === 'string' && entry.stamp.length <= 120, '消息时间标识无效');
    text(entry.text, '消息正文', 160_000);
    return digest(JSON.stringify([entry.role, entry.name, entry.stamp, entry.text]));
}

function validHistory(history) {
    check(Array.isArray(history) && history.length <= 12_000, '聊天历史过长或格式无效');
    for (const entry of history) {
        check(entry && typeof entry.id === 'string' && /^[a-f0-9]{64}$/.test(entry.id)
            && ['user', 'assistant'].includes(entry.role), '消息指纹无效');
    }
}

export function makeLedger(seed, history) {
    validHistory(history);
    const initial = makeWorld(seed);
    const core = coreRoster(seed.core ?? [], initial);
    return { version: 1, epoch: randomUUID(), anchor: history, initial, core, turns: {} };
}

function scan(ledger, history) {
    validHistory(history);
    const anchorLength = ledger.anchor.length;
    const initialKey = digest(ledger.epoch);
    if (history.length < anchorLength
        || ledger.anchor.some((entry, i) => history[i].id !== entry.id || history[i].role !== entry.role)) {
        return { status: 'rebuild', reason: '当前聊天已经改动到初始起点，需要重新建立世界起点。' };
    }
    const known = new Map();
    for (const turn of Object.values(ledger.turns)) {
        for (const { id, key } of turn.markers) {
            if (!known.has(id)) known.set(id, new Set());
            known.get(id).add(key);
        }
    }
    let state = structuredClone(ledger.initial);
    let key = initialKey;
    let base = initialKey;
    let start = anchorLength;
    let freshFrom = anchorLength;
    let issues = [];
    let unrecorded = false;
    let latest;
    const markers = [];
    for (let i = anchorLength; i < history.length; i++) {
        const { id, role } = history[i];
        key = digest(key + ':' + id + ':' + role);
        markers.push({ id, key });
        if (known.has(id) && !known.get(id).has(key)) {
            return { status: 'rebuild', reason: '聊天中间的楼层或候选已变更，后文仍在，需要重建世界记录。' };
        }
        if (role !== 'assistant') continue;
        const turn = ledger.turns[key];
        latest = turn;
        if (!turn) {
            unrecorded = true;
            continue;
        }
        check(turn.base === base, '存档的历史起点不一致');
        unrecorded = false;
        if (turn.proposal) {
            state = applyProposal(state, turn.proposal, key.slice(0, 12), { clone: false });
            base = key;
            start = i + 1;
            issues = [];
        } else {
            issues = turn.issues;
        }
        freshFrom = i + 1;
    }
    return {
        status: unrecorded ? 'unrecorded' : issues.length ? 'conflict' : 'ready',
        state, base, tip: key, start, freshFrom, markers, issues, latest,
        canRecord: history.length > anchorLength && history.at(-1)?.role === 'assistant'
            && (unrecorded || Boolean(issues.length)),
    };
}

function hasFollowers(ledger, key) {
    return Object.entries(ledger.turns).some(([tip, turn]) =>
        tip !== key && turn.markers.some(marker => marker.key === key));
}

export function viewLedger(ledger, history, { focus = '', budget = 6000 } = {}) {
    validHistory(history);
    if (!ledger) return { status: 'missing' };
    const view = scan(ledger, history);
    if (view.status === 'rebuild') return view;
    const { status, base, tip, start, freshFrom, issues, canRecord, state, latest } = view;
    const core = ledger.core ?? [];
    return {
        status, epoch: ledger.epoch, base, tip, start, freshFrom, issues,
        canRecord: canRecord && !(status === 'conflict' && hasFollowers(ledger, tip)),
        state: inspectable(state), core, rosterVersion: digest(JSON.stringify(core)),
        coreCandidates: ledger.initial.characters.map(person => person.name),
        directorContext: latest?.directorContext ?? null,
        backgroundIssue: latest?.backgroundIssue ?? null,
        prompt: promptFor(state, issues, focus, budget, core),
    };
}

export function recordTurn(ledger, body) {
    check(ledger && body.epoch === ledger.epoch, '世界起点已变更，请重新加载');
    const full = scan(ledger, body.history);
    check(full.status !== 'rebuild', full.reason);
    check(body.tip === full.tip, '候选回复已经变更');
    const existing = ledger.turns[full.tip];
    if (existing?.proposal || (existing && !body.retry)) return false;
    check(!existing || !hasFollowers(ledger, full.tip), '该回复已有后续记录，请从此处重新回答以建立新候选');
    check(full.canRecord, '当前没有可以记录的回复');
    const basis = existing ? scan(ledger, body.history.slice(0, -1)) : full;
    check(basis.status !== 'rebuild' && body.base === basis.base, '事实记录已更新，请重新提取');
    const { entries } = body;
    check(Array.isArray(entries) && entries.length === body.history.length - basis.start
        && entries.length <= 48, '待记录消息超过范围，请重试或重新建立起点');
    for (let i = 0; i < entries.length; i++) {
        const identity = body.history[basis.start + i];
        check(identity.role === entries[i]?.role && identity.id === fingerprint(entries[i]), '原文与当前聊天历史不一致');
    }
    check(entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 160_000, '待记录正文过长');
    check(entries.at(-1)?.role === 'assistant', '等待编导回复');

    const turn = { base: basis.base, markers: full.markers.slice(basis.start - ledger.anchor.length), updatedAt: new Date().toISOString() };
    const directorContext = body.directorContext ?? existing?.directorContext;
    if (typeof directorContext === 'string' && directorContext.length <= 10_000
        && directorContext.startsWith('[Living World Engine · 本轮世界资料]')) {
        turn.directorContext = directorContext;
    }
    try {
        check(JSON.stringify(body.proposal ?? null).length <= 100_000, '状态记录员提案过长');
        const proposal = parseProposal(body.proposal, entries, entries.slice(basis.freshFrom - basis.start), basis.issues.length > 0);
        if (proposal.conflicts) {
            turn.issues = proposal.conflicts;
        } else {
            applyProposal(basis.state, proposal, full.tip.slice(0, 12));
            turn.proposal = proposal;
            const roster = ledger.core ?? [];
            try {
                const background = parseBackground(body.proposal, proposal, roster, entries);
                if (background.length) {
                    check(body.rosterVersion === digest(JSON.stringify(roster)), '记录期间核心角色名单有变动');
                    const combined = { ...proposal, background };
                    applyProposal(basis.state, combined, full.tip.slice(0, 12));
                    turn.proposal = combined;
                }
            } catch (error) {
                turn.backgroundIssue = error.message;
            }
        }
    } catch (error) {
        turn.issues = [{ detail: error.message, ...(error.evidence ? { evidence: error.evidence } : {}) }];
    }
    ledger.turns[full.tip] = turn;
    return true;
}

export function recordingBasis(ledger, history, retry) {
    const full = scan(ledger, history);
    if (full.status === 'rebuild' || !full.canRecord || !retry || !ledger.turns[full.tip] || hasFollowers(ledger, full.tip)) return null;
    const previous = scan(ledger, history.slice(0, -1));
    if (previous.status === 'rebuild') return null;
    return { start: previous.start, freshFrom: previous.freshFrom, issues: previous.issues };
}
