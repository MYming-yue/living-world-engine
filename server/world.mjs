const MAX_ELAPSED = 60 * 24 * 365;
const MEMORY_KINDS = ['seen', 'heard', 'reported', 'inferred', 'initial'];
const MEMORY_LABELS = {
    seen: '亲历或观察',
    heard: '亲耳听到',
    reported: '听闻，未证实',
    inferred: '主观推测',
    initial: '初始记忆',
};

export function check(condition, message) {
    if (!condition) throw new Error(message);
}

export function text(value, label, max = 300) {
    check(typeof value === 'string' && value.trim() && value.length <= max, label + '为空或过长');
    return value.trim();
}

function list(value, label, max) {
    check(Array.isArray(value) && value.length <= max, label + '格式错误或数量超限');
    return value;
}

function number(value, label, min = 0, max = 1_000_000_000) {
    check(Number.isSafeInteger(value) && value >= min && value <= max, label + '超出允许范围');
    return value;
}

function character(state, name) {
    const result = state.characters.find(entry => entry.name === name);
    check(result, '找不到角色「' + name + '」');
    return result;
}

function location(state, name) {
    const result = text(name, '地点', 80);
    check(state.locations.includes(result), '找不到地点「' + result + '」');
    return result;
}

function addCharacter(state, raw, source) {
    const name = text(raw.name, '角色名', 80);
    check(!state.characters.some(entry => entry.name === name), '角色已存在「' + name + '」');
    const items = list(raw.items ?? [], '物品', 64).map(item => ({
        name: text(item.name, '物品名', 100),
        count: number(item.count, '物品数量', 1),
    }));
    check(new Set(items.map(item => item.name)).size === items.length, '角色的物品名称重复');
    const memories = source === '起点'
        ? list(raw.memories ?? [], '初始记忆', 24).map(content => ({
            kind: 'initial', content: text(content, '记忆'), via: '初始设定',
            minute: state.minute, source,
        }))
        : [];
    state.characters.push({
        name,
        location: raw.location ? location(state, raw.location) : null,
        coins: raw.coins == null ? null : number(raw.coins, '金币余额'),
        items,
        debts: [],
        memories,
        condition: null,
        travel: null,
    });
}

function findRoute(state, from, to, mode) {
    return state.routes.find(route => route.from === from && route.to === to && route.mode === mode);
}

function routeFields(state, raw) {
    const from = location(state, raw.from);
    const to = location(state, raw.to);
    check(from !== to, '路线起点和终点相同');
    return { from, to, mode: text(raw.mode, '移动方式', 40) };
}

function addRoute(state, raw, source) {
    const route = routeFields(state, raw);
    const minutes = number(raw.minutes, '移动耗时', 1, MAX_ELAPSED);
    const existing = findRoute(state, route.from, route.to, route.mode);
    check(!existing || existing.minutes === minutes,
        '路线「' + route.from + ' → ' + route.to + '」已有耗时 ' + existing?.minutes + ' 分钟');
    if (!existing) state.routes.push({ ...route, minutes, source });
}

export function makeWorld(seed) {
    check(seed && typeof seed === 'object', '缺少初始世界');
    const locations = list(seed.locations, '地点', 64).map(name => text(name, '地点', 80));
    check(locations.length > 0 && new Set(locations).size === locations.length, '请提供不同的初始地点');
    const state = {
        minute: number(seed.minute, '初始时间'),
        rules: list(seed.rules ?? [], '世界规则', 32).map(rule => text(rule, '规则', 240)),
        locations,
        routes: [],
        characters: [],
        relations: [],
        events: [],
    };
    for (const raw of list(seed.characters, '角色', 32)) addCharacter(state, raw, '起点');
    check(state.characters.length > 0, '请提供至少一个初始角色');
    for (const raw of list(seed.routes ?? [], '路线', 96)) addRoute(state, raw, '起点');
    return state;
}

export function coreRoster(value, state) {
    const roster = list(value, '核心角色', 8).map(entry => ({
        name: character(state, text(entry?.name, '核心角色名', 80)).name,
        profile: text(entry.profile, '人格与背景', 2400),
        goals: text(entry.goals, '目标与日常', 600),
    }));
    check(new Set(roster.map(entry => entry.name)).size === roster.length, '核心角色名重复');
    return roster;
}

function normalized(value) {
    return value.replace(/\s+/gu, ' ').trim();
}

function quote(value, entries, label = '原文依据') {
    const excerpt = text(value, label, 360);
    check(entries.some(entry => normalized(entry.text).includes(normalized(excerpt))),
        label + '找不到对应原文：「' + excerpt + '」');
    return excerpt;
}

export function parseProposal(raw, entries, freshEntries, hasPending) {
    check(raw && typeof raw === 'object' && !Array.isArray(raw), '状态记录员未返回 JSON 对象');
    const conflicts = list(raw.conflicts, '冲突', 16).map(conflict => ({
        detail: text(conflict.detail, '冲突说明', 300),
        evidence: quote(conflict.evidence, entries),
    }));
    if (conflicts.length) return { conflicts };
    if (hasPending && !raw.repairEvidence) {
        return { conflicts: [{ detail: '前一段剧情的冲突还需要在正文中补足依据。' }] };
    }
    const elapsed = number(raw.elapsed, '本段耗时', 0, MAX_ELAPSED);
    const clockEvidence = elapsed ? quote(raw.clockEvidence, entries, '耗时依据') : null;
    check(typeof raw.estimated === 'boolean', '请标明耗时是否为估计');
    const events = list(raw.events, '事件', 24).map(event => ({
        summary: text(event.summary, '事件', 300),
        evidence: quote(event.evidence, entries),
        offset: number(event.offset ?? elapsed, '事件时间', 0, elapsed),
        changes: list(event.changes, '事件变化', 36),
    }));
    return {
        elapsed, clockEvidence, estimated: raw.estimated, events,
        repairEvidence: hasPending ? quote(raw.repairEvidence, freshEntries, '补写依据') : null,
    };
}

export function parseBackground(raw, foreground, roster, entries) {
    const events = list(raw.background ?? [], '幕后事件', 16);
    if (!events.length) return [];
    check(foreground.elapsed > 0, '本楼没有经过故事时间');
    check(entries.filter(entry => entry.role === 'assistant').length === 1, '补记多楼时只保存前台事实');
    const names = new Set(roster.map(entry => entry.name));
    const presence = list(raw.onstage, '前台出场时段', 32).map(entry => {
        check(names.has(entry?.who), '前台出场时段只需标注核心角色');
        const start = number(entry.start, '出场起点', 0, foreground.elapsed);
        const end = number(entry.end, '出场终点', start, foreground.elapsed);
        quote(entry.evidence, entries, '出场依据');
        return { who: entry.who, start, end };
    });
    return events.map(event => {
        const who = event?.who;
        check(names.has(who), '幕后事件只能由核心角色发起');
        const start = number(event.start, '幕后起点', 0, foreground.elapsed);
        const offset = number(event.offset, '幕后事件时间', start + 1, foreground.elapsed);
        const onstage = presence.some(window => window.who === who && start <= window.end && offset >= window.start)
            || foreground.events.some(scene => scene.offset >= start && scene.offset <= offset
                && scene.changes.some(change => change?.who === who || change?.name === who
                    || change?.from === who || change?.to === who));
        check(!onstage, '「' + who + '」的幕后时段与前台活动重叠');
        const changes = list(event.changes, '幕后变化', 12);
        for (const change of changes) {
            const type = change?.type;
            check(type === 'relation' ? change.from === who
                : ['life', 'condition', 'travel', 'move', 'memory', 'coins', 'debt', 'item'].includes(type) && change.who === who,
            '幕后事件只能更新该核心角色自己的状态或关系');
        }
        const summary = text(event.summary, '幕后事件', 300);
        return { kind: 'background', who, start, offset, summary, evidence: summary, changes };
    });
}

export function applyProposal(previous, proposal, source, { clone = true } = {}) {
    const state = clone ? structuredClone(previous) : previous;
    const travelTimes = new Map();
    let lastOffset = 0;
    const timeline = proposal.background?.length
        ? [...proposal.events, ...proposal.background].sort((a, b) => a.offset - b.offset)
        : proposal.events;
    for (const event of timeline) {
        check(event.offset >= lastOffset, '事件顺序与时间不一致');
        lastOffset = event.offset;
        const minute = state.minute + event.offset;
        for (const change of event.changes) {
            try {
                applyChange(state, change, { minute, source, evidence: event.evidence, travelTimes,
                    offset: event.offset, backgroundStart: event.kind === 'background' ? event.start : undefined });
            } catch (error) {
                error.evidence = event.evidence;
                throw error;
            }
        }
        state.events.push({ minute, source, summary: event.summary, evidence: event.evidence,
            ...(event.kind === 'background' ? { kind: event.kind, who: event.who, start: state.minute + event.start } : {}),
        });
    }
    state.minute = number(state.minute + proposal.elapsed, '世界时间');
    if (proposal.elapsed) {
        state.clock = {
            elapsed: proposal.elapsed, estimated: proposal.estimated,
            evidence: proposal.clockEvidence, source,
        };
    }
    return state;
}

function applyChange(state, raw, at) {
    check(raw && typeof raw === 'object', '状态变化格式错误');
    switch (raw.type) {
        case 'place': {
            const name = text(raw.name, '地点', 80);
            if (!state.locations.includes(name)) state.locations.push(name);
            return;
        }
        case 'character':
            addCharacter(state, raw, at.source);
            return;
        case 'route':
            addRoute(state, raw, at.source);
            return;
        case 'travel':
        case 'move': {
            const person = character(state, raw.who);
            const route = routeFields(state, raw);
            check(!person.location || person.location === route.from,
                person.name + ' 当前位于「' + person.location + '」，移动起点是「' + route.from + '」');
            if (raw.type === 'travel') {
                person.travel = { ...route, started: at.minute };
                return;
            }
            const known = findRoute(state, route.from, route.to, route.mode);
            check(known, '到达记录缺少已知路线「' + route.from + ' → ' + route.to + '」');
            const minutes = number(raw.minutes, '到达耗时', 1, MAX_ELAPSED);
            check(minutes === known.minutes, '到达耗时 ' + minutes + ' 分钟与已知路线 ' + known.minutes + ' 分钟冲突');
            const prior = person.travel && person.travel.from === route.from
                && person.travel.to === route.to && person.travel.mode === route.mode
                ? Math.max(0, state.minute - person.travel.started) : 0;
            const total = (at.travelTimes.get(person.name) ?? 0) + Math.max(0, minutes - prior);
            check(total <= at.offset, '「' + person.name + '」的移动耗时超过该事件的时间');
            check(at.backgroundStart === undefined || minutes - prior <= at.offset - at.backgroundStart,
                '「' + person.name + '」的移动耗时超过该幕后时段');
            at.travelTimes.set(person.name, total);
            person.location = route.to;
            person.travel = null;
            return;
        }
        case 'coins': {
            const person = character(state, raw.who);
            check(person.coins !== null, '「' + person.name + '」的余额尚未确认');
            const delta = number(raw.delta, '金币变化', -1_000_000_000);
            check(person.coins + delta >= 0, '「' + person.name + '」只有 ' + person.coins + ' 枚金币，记录尝试减少 ' + -delta + ' 枚');
            person.coins = number(person.coins + delta, '金币余额');
            return;
        }
        case 'item': {
            const person = character(state, raw.who);
            const name = text(raw.name, '物品', 100);
            const delta = number(raw.delta, '物品变化', -1_000_000_000);
            const previous = person.items.find(entry => entry.name === name);
            const count = (previous?.count ?? 0) + delta;
            check(count >= 0, '「' + person.name + '」持有的「' + name + '」数量不足');
            number(count, '物品数量');
            if (previous && count) previous.count = count;
            else if (previous) person.items = person.items.filter(entry => entry !== previous);
            else if (count) person.items.push({ name, count });
            return;
        }
        case 'debt': {
            const person = character(state, raw.who);
            const to = text(raw.to, '债权人', 80);
            const delta = number(raw.delta, '欠款变化', -1_000_000_000);
            const previous = person.debts.find(entry => entry.to === to);
            const coins = number((previous?.coins ?? 0) + delta, '尚欠金币');
            if (previous && coins) previous.coins = coins;
            else if (previous) person.debts = person.debts.filter(entry => entry !== previous);
            else if (coins) person.debts.push({ to, coins });
            return;
        }
        case 'memory': {
            const person = character(state, raw.who);
            check(MEMORY_KINDS.includes(raw.kind) && raw.kind !== 'initial', '记忆获知方式不明确');
            const content = text(raw.content, '记忆内容');
            const via = text(raw.via, '明确获知途径', 160);
            if (!person.memories.some(entry => entry.kind === raw.kind && entry.content === content && entry.via === via)) {
                person.memories.push({ kind: raw.kind, content, via, minute: at.minute, source: at.source, evidence: at.evidence });
            }
            return;
        }
        case 'condition':
            character(state, raw.who).condition = {
                note: text(raw.note, '角色状态'), minute: at.minute, source: at.source, evidence: at.evidence,
            };
            return;
        case 'life':
            character(state, raw.who).life = {
                note: text(raw.note, '生活近况', 600), minute: at.minute, source: at.source, evidence: at.evidence,
            };
            return;
        case 'relation': {
            character(state, raw.from);
            character(state, raw.to);
            check(raw.from !== raw.to, '关系需要两个不同角色');
            const entry = {
                from: raw.from, to: raw.to, note: text(raw.note, '关系状态'),
                minute: at.minute, source: at.source, evidence: at.evidence,
            };
            state.relations = state.relations.filter(relation => relation.from !== raw.from || relation.to !== raw.to);
            state.relations.push(entry);
            return;
        }
        default:
            throw new Error('无法识别的状态变化类型');
    }
}

export function storyTime(minutes) {
    const day = Math.floor(minutes / 1440) + 1;
    const hours = String(Math.floor(minutes % 1440 / 60)).padStart(2, '0');
    const mins = String(minutes % 60).padStart(2, '0');
    return '第 ' + day + ' 天 ' + hours + ':' + mins;
}

export function promptFor(state, issues, focus, budget = 6000, roster = []) {
    const sections = [
        '[Living World Engine · 本轮世界资料]',
        '编剧根据事实安排情节，导演把它写成正文。事件结果由你在玩家行动和已有世界事实的约束内创作。',
        '这些是编导可见资料。每个角色的台词与行动只使用她有明确途径获知的信息。传闻和推测保留其不确定性。',
        '当前时间：' + storyTime(state.minute),
    ];
    function append(line) {
        if (sections.join('\n').length + line.length + 1 <= budget) sections.push(line);
    }
    for (const rule of state.rules) append('世界规则：' + rule);
    for (const issue of issues.slice(0, 5)) {
        append('待补正：' + issue.detail + (issue.evidence ? '（原文「' + issue.evidence + '」）' : ''));
    }
    if (issues.length) append('有解释空间时，在读者可见的正文补足因果。待补正变化仍按最后确认状态处理。');
    const ordered = [...state.characters].sort((a, b) => Number(focus.includes(b.name)) - Number(focus.includes(a.name)));
    for (const person of ordered) {
        const line = ['角色 ' + person.name, person.travel
            ? '从 ' + person.travel.from + ' 前往 ' + person.travel.to + '（尚未到达）'
            : '位置 ' + (person.location ?? '未确认')];
        if (person.coins !== null) line.push('金币 ' + person.coins);
        if (person.debts.length) line.push('欠款 ' + person.debts.slice(0, 8).map(debt => debt.to + ' ' + debt.coins).join('、'));
        if (person.items.length) line.push('物品 ' + person.items.slice(0, 12).map(item => item.name + '×' + item.count).join('、'));
        if (person.condition) line.push(person.condition.note);
        append(line.join(' | '));
    }
    for (const person of ordered) {
        const core = roster.find(entry => entry.name === person.name);
        if (!core) continue;
        const latest = state.events.findLast(event => event.kind === 'background' && event.who === person.name);
        if (latest) append(person.name + ' 的幕后近况（按正文和角色记忆判断谁知道）：' + latest.summary);
        if (person.life) append(person.name + ' 的生活状态：' + person.life.note);
        append('核心角色 ' + person.name + ' 的目标与日常：' + core.goals);
        append('核心角色 ' + person.name + ' 的人格与背景：' + core.profile);
    }
    const relevantRoutes = [...state.routes].sort((a, b) =>
        Number(focus.includes(b.from) || focus.includes(b.to)) - Number(focus.includes(a.from) || focus.includes(a.to)));
    for (const route of relevantRoutes.slice(0, 16)) {
        append('路线：' + route.from + ' → ' + route.to + '，' + route.mode + ' ' + route.minutes + ' 分钟');
    }
    for (const relation of state.relations.slice(-12)) append('关系：' + relation.from + ' 对 ' + relation.to + '，' + relation.note);
    for (const person of ordered) {
        for (const memory of person.memories.slice(-5).reverse()) {
            append(person.name + ' 的记忆（' + MEMORY_LABELS[memory.kind] + '，' + memory.via + '）：' + memory.content);
        }
    }
    return sections.join('\n');
}

export function inspectable(state) {
    return {
        ...state,
        time: storyTime(state.minute),
        events: state.events.slice(-30),
        characters: state.characters.map(person => ({ ...person, memories: person.memories.slice(-30) })),
    };
}
