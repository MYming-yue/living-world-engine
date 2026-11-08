import { customRecorderProfile, extractTurn, recorderRequest } from './recorder.js';

const id = 'living-world-engine';
const endpoint = '/api/plugins/' + id;
const marker = '[Living World Engine · 本轮世界资料]';
const endMarker = '[Living World Engine · 世界资料结束]';
const supported = new Set(['normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
const tasks = new Map();
const audits = new WeakMap();
const fingerprints = new WeakMap();
const encoder = new TextEncoder();
let activeGeneration;
let panel;
let coreEditor;
let refreshCount = 0;

function context() {
    return globalThis.SillyTavern.getContext();
}

function scopeOf(ctx) {
    if (!ctx.chatId) return null;
    if (ctx.groupId != null) return { owner: 'group:' + ctx.groupId, chat: String(ctx.chatId) };
    const character = ctx.characters[ctx.characterId];
    return character?.avatar ? { owner: 'character:' + character.avatar, chat: String(ctx.chatId) } : null;
}

function keyOf(scope) {
    return JSON.stringify(scope);
}

function settings(ctx = context()) {
    return ctx.extensionSettings[id] ??= { enabled: true, profile: '' };
}

function enabled(ctx) {
    return settings(ctx).enabled && !ctx.extensionSettings.disabledExtensions?.includes('third-party/' + id);
}

function clearPrompt(ctx = context()) {
    ctx.setExtensionPrompt(id, '', -1, 1);
}

function messageEntry(message) {
    if (message?.is_system || typeof message?.mes !== 'string' || !message.mes.trim()
        || message.mes === '...' || message.mes === '…') return null;
    const entry = {
        role: message.is_user ? 'user' : 'assistant',
        name: String(message.name ?? ''),
        stamp: String(message.send_date ?? ''),
        text: message.mes,
    };
    const input = JSON.stringify([entry.role, entry.name, entry.stamp, entry.text]);
    let cached = fingerprints.get(message);
    if (cached?.input !== input) {
        const promise = globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input)).then(bytes =>
            Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''));
        cached = { input, promise };
        fingerprints.set(message, cached);
    }
    return cached.promise.then(hash => ({ ...entry, id: hash }));
}

async function snapshot(ctx, chat = ctx.chat) {
    const scope = scopeOf(ctx);
    if (!scope) return null;
    if (!globalThis.crypto?.subtle) throw new Error('请通过本机地址或 HTTPS 打开酒馆');
    const entries = (await Promise.all(chat.map(messageEntry))).filter(Boolean);
    return {
        scope, entries, key: keyOf(scope),
        history: entries.map(({ id, role }) => ({ id, role })),
        directorContext: auditFor(lastReply(chat)),
        focus: entries.slice(-2).map(entry => entry.text).join('\n').slice(-3000),
    };
}

async function request(path, selected, extra = {}) {
    const response = await fetch(endpoint + path, {
        method: 'POST',
        headers: context().getRequestHeaders(),
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ scope: selected.scope, history: selected.history, focus: selected.focus, ...extra }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
        if (response.status === 404) throw new Error('世界引擎服务未加载，请启用服务端插件并重启酒馆');
        throw new Error(payload?.error ?? '无法连接世界引擎');
    }
    return payload;
}

async function stillSelected(selected) {
    const ctx = context();
    if (!enabled(ctx) || keyOf(scopeOf(ctx)) !== selected.key) return false;
    const latest = await snapshot(ctx);
    return latest && latest.key === selected.key
        && latest.history.length >= selected.history.length
        && selected.history.every((entry, i) => entry.id === latest.history[i]?.id)
        && latest.history.slice(selected.history.length).every(entry => entry.role === 'user');
}

function showStatus(message) {
    if (panel) panel.querySelector('.lwe-status').textContent = message;
}

function storyTime(minutes) {
    const hh = String(Math.floor(minutes % 1440 / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    return '第 ' + (Math.floor(minutes / 1440) + 1) + ' 天 ' + hh + ':' + mm;
}

function stateText(view) {
    if (!view?.state) return view?.reason ?? '在当前聊天中建立世界起点后，这里会显示存档。';
    const state = view.state;
    const lines = [state.time];
    if (state.clock) {
        lines.push('上次推进 ' + state.clock.elapsed + ' 分钟' + (state.clock.estimated ? '（估计）' : '')
            + '。「' + state.clock.evidence + '」');
    }
    lines.push('地点　' + state.locations.join('、'));
    for (const rule of state.rules) lines.push('规则　' + rule);
    for (const character of state.characters) {
        const core = view.core?.find(entry => entry.name === character.name);
        const where = character.travel ? character.travel.from + ' → ' + character.travel.to + '（途中）'
            : (character.location ?? '位置未确认');
        lines.push('', character.name + (core ? '（核心）' : '') + ' · ' + where
            + (character.coins === null ? '' : ' · ' + character.coins + ' 枚金币'));
        if (core) lines.push('目标与日常　' + core.goals);
        if (character.life) lines.push('生活近况　' + character.life.note);
        if (character.condition) lines.push('状态　' + character.condition.note);
        if (character.items.length) lines.push('物品　' + character.items.map(item => item.name + ' × ' + item.count).join('、'));
        if (character.debts.length) lines.push('欠款　' + character.debts.map(debt => debt.to + ' ' + debt.coins + ' 枚').join('、'));
        for (const memory of character.memories.slice(-8)) {
            const kinds = { initial: '初始', seen: '亲历', heard: '亲耳听到', reported: '听闻', inferred: '推测' };
            lines.push('记忆　' + memory.content + '（' + kinds[memory.kind] + '，' + memory.via + '）'
                + '〔' + storyTime(memory.minute) + ' · ' + memory.source + '〕');
            if (memory.evidence) lines.push('　　「' + memory.evidence + '」');
        }
    }
    if (state.relations.length) {
        lines.push('', '关系');
        for (const entry of state.relations.slice(-12)) lines.push(entry.from + ' → ' + entry.to + '　' + entry.note);
    }
    if (state.routes.length) {
        lines.push('', '路线');
        for (const entry of state.routes.slice(-24)) lines.push(entry.from + ' → ' + entry.to + '　' + entry.mode + ' ' + entry.minutes + ' 分钟');
    }
    if (state.events.length) {
        lines.push('', '近期事件');
        for (const event of state.events.slice(-12)) {
            const detail = event.kind === 'background' ? '幕后 · ' + event.who + ' · ' + event.summary
                : '正文 · ' + event.summary + '「' + event.evidence + '」';
            lines.push(storyTime(event.minute) + '　' + detail + '〔' + event.source + '〕');
        }
    }
    if (view.issues.length) {
        lines.push('', '待处理的冲突');
        for (const issue of view.issues) lines.push(issue.detail + (issue.evidence ? '「' + issue.evidence + '」' : ''));
    }
    if (view.backgroundIssue) lines.push('', '本楼幕后变化未入账　' + view.backgroundIssue);
    return lines.join('\n');
}

function lastReply(chat) {
    return chat.findLast(message => !message.is_user && !message.is_system && !['...', '…'].includes(message.mes));
}

function auditFor(message) {
    const audit = message && audits.get(message);
    return audit && audit.prose === message.mes && audit.swipe === message.swipe_id ? audit.context : undefined;
}

function directorText(view, key) {
    if (activeGeneration?.key === key && activeGeneration?.audit) {
        return activeGeneration.audit.context ?? (activeGeneration.audit.checked
            ? '本次请求中未找到完整的引擎资料。' : '正在组装本次编导请求…');
    }
    const current = lastReply(context().chat);
    return (view?.state && (auditFor(current) ?? view.directorContext)) || '当前回复没有可查看的编导上下文记录。';
}

function editCoreFields() {
    const section = panel.querySelector('[data-part="core"]');
    const name = section.querySelector('select').value;
    const entry = coreEditor?.core.find(person => person.name === name);
    section.querySelector('[name="lwe-profile"]').value = entry?.profile ?? '';
    section.querySelector('[name="lwe-goals"]').value = entry?.goals ?? '';
    section.querySelector('[data-act="remove-core"]').disabled = !entry;
}

function drawCore(view, key) {
    const section = panel.querySelector('[data-part="core"]');
    section.hidden = !view?.coreCandidates?.length;
    if (section.hidden) {
        coreEditor = undefined;
        return;
    }
    if (coreEditor?.key === key && coreEditor.epoch === view.epoch && coreEditor.version === view.rosterVersion) return;
    const select = section.querySelector('select');
    const selected = coreEditor?.key === key ? select.value : '';
    coreEditor = { key, epoch: view.epoch, version: view.rosterVersion, core: view.core };
    select.replaceChildren(...view.coreCandidates.map(name =>
        new Option(view.core.some(entry => entry.name === name) ? name + '（核心）' : name, name)));
    select.value = view.coreCandidates.includes(selected) ? selected : (view.core[0]?.name ?? view.coreCandidates[0]);
    editCoreFields();
    section.querySelector('[data-view="core-status"]').textContent = view.core.length
        ? '已登记 ' + view.core.length + ' 位核心角色。' : '登记后，这些角色才会参与幕后演化。';
}

async function saveCore(event) {
    const button = event.currentTarget;
    const editor = coreEditor;
    if (!editor) return;
    const section = button.closest('[data-part="core"]');
    const fields = section.querySelector('fieldset');
    const status = section.querySelector('[data-view="core-status"]');
    const name = section.querySelector('select').value;
    const core = editor.core.filter(person => person.name !== name);
    if (button.dataset.act === 'save-core') {
        core.push({ name, profile: section.querySelector('[name="lwe-profile"]').value,
            goals: section.querySelector('[name="lwe-goals"]').value });
    }
    fields.disabled = true;
    try {
        const selected = await snapshot(context());
        if (selected?.key !== editor.key) return;
        const view = await request('/core', selected, { epoch: editor.epoch, rosterVersion: editor.version, core });
        if (keyOf(scopeOf(context())) === selected.key) draw(view, selected.key);
    } catch (error) {
        if (keyOf(scopeOf(context())) === editor.key) status.textContent = error.message;
    } finally {
        fields.disabled = false;
    }
}

function draw(view, key) {
    if (!panel) return;
    const status = {
        missing: '当前聊天尚未建立世界起点。',
        ready: '世界记录与当前聊天一致。',
        conflict: '正文已显示，受影响的世界变化待处理。',
        unrecorded: '当前回复尚未完成记录。',
        rebuild: view?.reason,
    };
    showStatus(tasks.has(key) ? '正在提取世界记录…' : (status[view?.status] ?? '请选择一段聊天。'));
    panel.querySelector('[data-view="state"]').textContent = stateText(view);
    panel.querySelector('[data-view="prompt"]').textContent = directorText(view, key);
    panel.querySelector('[data-view="state-json"]').textContent = view?.state
        ? JSON.stringify({ ...view.state, core: view.core, issues: view.issues, backgroundIssue: view.backgroundIssue }, null, 2) : '';
    drawCore(view, key);
    const seed = panel.querySelector('[data-part="seed"]');
    seed.hidden = !view || !['missing', 'rebuild'].includes(view.status);
    const create = seed.querySelector('[data-act="seed"]');
    create.dataset.rebuild = String(view?.status === 'rebuild');
    create.textContent = view?.status === 'rebuild' ? '以当前聊天重建起点' : '建立世界起点';
    const retry = panel.querySelector('[data-act="retry"]');
    retry.hidden = !view?.canRecord;
    retry.disabled = tasks.has(key);
}

async function refresh() {
    const current = ++refreshCount;
    try {
        const ctx = context();
        if (!enabled(ctx)) {
            draw(null);
            showStatus('已暂停世界记录。');
            return;
        }
        const selection = await snapshot(ctx);
        const view = selection && await request('/view', selection);
        if (current === refreshCount && keyOf(scopeOf(context())) === (selection?.key ?? 'null')) draw(view, selection?.key);
    } catch (error) {
        if (current === refreshCount) showStatus(error.message);
    }
}

function inspectActualPrompt(event) {
    const generation = activeGeneration;
    if (event.dryRun || !generation?.audit) return;
    const contents = Array.isArray(event.messages) ? event.messages.flatMap(({ content }) =>
        Array.isArray(content) ? content.map(part => part?.text) : [content]) : [event.prompt];
    const fragment = contents.find(value => typeof value === 'string' && value.includes(marker) && value.includes(endMarker));
    const start = fragment?.indexOf(marker) ?? -1;
    const end = fragment?.indexOf(endMarker, start) ?? -1;
    generation.audit.checked = true;
    generation.audit.context = end > start ? fragment.slice(start, end).trimEnd() : null;
    if (panel && keyOf(scopeOf(context())) === generation.key) {
        panel.querySelector('[data-view="prompt"]').textContent = directorText(null, generation.key);
    }
}

globalThis.livingWorldEngineBeforeGenerate = async (_chat, contextSize, _abort, type = 'normal') => {
    const ctx = context();
    clearPrompt(ctx);
    activeGeneration = undefined;
    if (!enabled(ctx) || !supported.has(type)) return;
    const scope = scopeOf(ctx);
    if (!scope) return;
    const key = keyOf(scope);
    const generation = { key, canceled: false, ready: false };
    activeGeneration = generation;
    try {
        await tasks.get(key);
        if (activeGeneration !== generation || generation.canceled || keyOf(scopeOf(context())) !== key) return;
        const current = context();
        // The swipe placeholder and the text being continued belong to the response being replaced.
        const replacesTail = ['swipe', 'continue', 'append'].includes(type) && !current.chat.at(-1)?.is_user;
        const selection = await snapshot(current, replacesTail ? current.chat.slice(0, -1) : current.chat);
        if (!selection || selection.key !== key) return;
        const budget = Number.isFinite(contextSize) ? Math.floor(contextSize * 0.65) : 6000;
        const view = await request('/view', selection, { budget });
        if (activeGeneration !== generation || generation.canceled || keyOf(scopeOf(context())) !== key) return;
        if (view.prompt) {
            const prompt = view.prompt.replaceAll('{{', '｛｛').replaceAll('}}', '｝｝') + '\n' + endMarker;
            ctx.setExtensionPrompt(id, prompt, 1, 1, false, 0);
            generation.audit = { context: null, checked: false };
        }
        generation.ready = ['ready', 'conflict'].includes(view.status);
        draw(view, key);
    } catch (error) {
        showStatus('本轮无法载入世界状态。' + error.message);
        if (panel && activeGeneration === generation) {
            panel.querySelector('[data-view="prompt"]').textContent = '本轮未载入世界上下文。';
        }
    }
};

function enqueue(selectionPromise, key, retry = false) {
    if (tasks.has(key)) return tasks.get(key);
    const job = (async () => {
        try {
            const selection = await selectionPromise;
            if (!selection || selection.key !== key || !await stillSelected(selection)) return;
            const view = await request('/view', selection, { retry });
            if (!view.canRecord || (view.status === 'conflict' && (!retry || !view.retryBasis))) return;
            const basis = view.retryBasis ?? view;
            const entries = selection.entries.slice(basis.start);
            if (entries.length > 48 || entries.reduce((sum, entry) => sum + entry.text.length, 0) > 160_000) {
                throw new Error('待提取的消息过长，请在当前聊天重新建立起点或缩短未记录的历史。');
            }
            const ctx = context();
            if (!await stillSelected(selection)) return;
            showStatus('正在提取世界记录…');
            const proposal = await extractTurn(ctx, settings(ctx).profile, view.state, basis, entries, view.core);
            if (!await stillSelected(selection)) return;
            await request('/record', selection, {
                epoch: view.epoch, base: view.base, tip: view.tip, entries, proposal, retry, rosterVersion: view.rosterVersion,
                directorContext: selection.directorContext,
            });
            tasks.delete(key);
            await refresh();
        } catch (error) {
            if (keyOf(scopeOf(context())) === key) showStatus('世界记录待补记。' + error.message);
        } finally {
            if (tasks.get(key) === job) tasks.delete(key);
            if (panel && keyOf(scopeOf(context())) === key) panel.querySelector('[data-act="retry"]').disabled = false;
        }
    })();
    tasks.set(key, job);
    return job;
}

function onRendered(messageIndex, type) {
    const ctx = context();
    const generation = activeGeneration;
    if (!generation || !supported.has(type)) return;
    activeGeneration = undefined;
    clearPrompt(ctx);
    const rendered = ctx.chat[messageIndex];
    const prose = rendered?.mes;
    if (!enabled(ctx) || !generation.ready || generation.canceled || generation.key !== keyOf(scopeOf(ctx))
        || !rendered || rendered.is_user) {
        void refresh();
        return;
    }
    // Let SillyTavern finish assigning swipe metadata before capturing the selected reply.
    const selection = new Promise(resolve => setTimeout(resolve, 0)).then(() => {
        const current = context();
        if (keyOf(scopeOf(current)) !== generation.key || current.chat[messageIndex] !== rendered || rendered.mes !== prose) return null;
        if (generation.audit?.context) audits.set(rendered, { prose, swipe: rendered.swipe_id, context: generation.audit.context });
        return snapshot(current, current.chat.slice(0, messageIndex + 1));
    });
    void enqueue(selection, generation.key);
}

function lines(value) {
    return value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
}

function fields(line) {
    return line.split(/[|｜]/u).map(field => field.trim());
}

function seedFromPanel() {
    const value = name => panel.querySelector('[name="' + name + '"]').value;
    const [hours, mins] = value('lwe-time').split(':').map(Number);
    const characters = lines(value('lwe-characters')).map(line => {
        const [name, location, coins] = fields(line);
        return { name, location, coins: coins ? Number(coins) : null, memories: [], items: [] };
    });
    for (const line of lines(value('lwe-memories'))) {
        const [who, memory] = fields(line);
        const person = characters.find(entry => entry.name === who);
        if (!person || !memory) throw new Error('初始记忆格式为「角色 | 记忆」，角色须在上方名单内。');
        person.memories.push(memory);
    }
    for (const line of lines(value('lwe-items'))) {
        const [who, name, count] = fields(line);
        const person = characters.find(entry => entry.name === who);
        if (!person || !name || !count) throw new Error('初始物品格式为「角色 | 物品 | 数量」。');
        person.items.push({ name, count: Number(count) });
    }
    return {
        minute: (Number(value('lwe-day')) - 1) * 1440 + hours * 60 + mins,
        locations: lines(value('lwe-places')),
        characters,
        core: lines(value('lwe-seed-core')).map(line => {
            const [name, profile, goals] = fields(line);
            return { name, profile, goals };
        }),
        rules: lines(value('lwe-rules')),
        routes: lines(value('lwe-routes')).map(line => {
            const [from, to, minutes, mode = '步行'] = fields(line);
            return { from, to, minutes: Number(minutes), mode };
        }),
    };
}

function example() {
    const set = (name, value) => { panel.querySelector('[name="' + name + '"]').value = value; };
    set('lwe-day', '1');
    set('lwe-time', '09:00');
    set('lwe-places', '旅店\n集市');
    set('lwe-characters', '旅人 | 旅店 | 10\n阿青 | 旅店\n阿岚 | 集市');
    set('lwe-seed-core', '阿青 | 旅店的年轻管事，细心，喜欢默默把事情做完 | 白天照看旅店，正在修补二楼旧书\n阿岚 | 做事利落的集市学徒，想有自己的摊位 | 白天理货，今天打算问师傅能否独立看摊');
    set('lwe-routes', '旅店 | 集市 | 12 | 步行\n集市 | 旅店 | 12 | 步行');
    set('lwe-rules', '人物只有亲历、听见或经转述才知道消息。\n只能按实际付款、赊账或物品交接更新记录。');
    set('lwe-memories', '阿青 | 旧钥匙藏在旅店二楼的书里。');
    set('lwe-items', '旅人 | 地图 | 1');
}

function updateProfiles() {
    if (!panel) return;
    const ctx = context();
    const select = panel.querySelector('[data-act="profile"]');
    select.replaceChildren(new Option('使用当前酒馆连接', ''));
    select.add(new Option('自定义接口', customRecorderProfile));
    for (const profile of ctx.extensionSettings.connectionManager?.profiles ?? []) {
        if (profile.id) select.add(new Option(profile.name || profile.id, profile.id));
    }
    const value = settings(ctx).profile;
    if (value && !Array.from(select.options).some(option => option.value === value)) {
        select.add(new Option('已选连接不可用，请重新选择', value));
    }
    select.value = value;
    void showRecorderConnection();
}

function showSavedRecorderConnection(form, connection) {
    form.dataset.loaded = 'true';
    form.dataset.savedUrl = connection.url;
    form.dataset.savedModel = connection.model;
    form.elements['lwe-recorder-url'].value = connection.url;
    form.elements['lwe-recorder-model'].value = connection.model;
    form.elements['lwe-recorder-key'].value = '';
    form.elements['lwe-recorder-clear-key'].checked = false;
    form.querySelector('[data-part="clear-recorder-key"]').hidden = !connection.hasKey;
    form.querySelector('[data-view="recorder-status"]').textContent = connection.url
        ? (connection.hasKey ? '接口和密钥已保存。' : '接口已保存，未设置密钥。')
        : '填写地址和模型 ID 后保存。';
    showRecorderTestResult(form, connection.test);
    updateRecorderTestButton(form);
}

function showRecorderTestResult(form, test) {
    const view = form.querySelector('[data-view="recorder-test"]');
    view.dataset.result = test ? (test.ok ? 'ok' : 'failed') : '';
    view.textContent = test
        ? (test.ok ? '连接成功' : '连接失败') + ' · ' + new Date(test.checkedAt).toLocaleString()
            + (test.detail ? '。' + test.detail : '')
        : '尚未测试连接。';
}

function updateRecorderTestButton(form) {
    const dirty = form.elements['lwe-recorder-url'].value.trim() !== (form.dataset.savedUrl ?? '')
        || form.elements['lwe-recorder-model'].value.trim() !== (form.dataset.savedModel ?? '')
        || Boolean(form.elements['lwe-recorder-key'].value.trim())
        || form.elements['lwe-recorder-clear-key'].checked;
    const button = form.querySelector('[data-act="test-recorder"]');
    button.disabled = dirty || !form.dataset.savedUrl || !form.dataset.savedModel;
    const view = form.querySelector('[data-view="recorder-test"]');
    view.hidden = dirty;
    form.querySelector('[data-view="recorder-unsaved"]').hidden = !dirty;
}

async function testRecorderConnection(event) {
    const form = event.currentTarget.form;
    const fields = form.querySelector('fieldset');
    const view = form.querySelector('[data-view="recorder-test"]');
    fields.disabled = true;
    view.dataset.result = '';
    view.textContent = '正在测试连接…';
    try {
        const connection = await recorderRequest(context(), 'recorder-test', {}, 65_000);
        showSavedRecorderConnection(form, connection);
    } catch (error) {
        view.dataset.result = 'failed';
        view.textContent = '测试失败。' + error.message;
    } finally {
        fields.disabled = false;
    }
}

async function showRecorderConnection() {
    const form = panel.querySelector('[data-part="recorder-connection"]');
    form.hidden = settings().profile !== customRecorderProfile;
    const fields = form.querySelector('fieldset');
    if (form.hidden || form.dataset.loaded || fields.disabled) return;
    const status = form.querySelector('[data-view="recorder-status"]');
    fields.disabled = true;
    status.textContent = '正在读取记录员接口…';
    try {
        showSavedRecorderConnection(form, await recorderRequest(context(), 'recorder-connection'));
    } catch (error) {
        status.textContent = error.message;
    } finally {
        fields.disabled = false;
    }
}

async function saveRecorderConnection(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = form.querySelector('fieldset');
    const status = form.querySelector('[data-view="recorder-status"]');
    const key = form.elements['lwe-recorder-key'].value.trim();
    const clearKey = form.elements['lwe-recorder-clear-key'].checked;
    if (key && clearKey) {
        status.textContent = '请选择填写新密钥或清除密钥。';
        return;
    }
    fields.disabled = true;
    status.textContent = '正在保存记录员接口…';
    try {
        showSavedRecorderConnection(form, await recorderRequest(context(), 'recorder-connection', {
            url: form.elements['lwe-recorder-url'].value,
            model: form.elements['lwe-recorder-model'].value,
            ...(clearKey || key ? { apiKey: clearKey ? null : key } : {}),
        }));
    } catch (error) {
        status.textContent = error.message;
    } finally {
        fields.disabled = false;
    }
}

function mount() {
    if (panel) return;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!host) return;
    panel = document.createElement('details');
    panel.id = 'lwe-panel';
    panel.innerHTML = [
        '<summary><strong>Living World Engine · 世界引擎</strong></summary>',
        '<div class="lwe-stack">',
        '<p class="lwe-status" role="status" aria-live="polite"></p>',
        '<div class="lwe-row"><label><input type="checkbox" data-act="enabled"> 启用世界记录</label>',
        '<button class="menu_button" type="button" data-act="refresh">刷新查看</button>',
        '<button class="menu_button" type="button" data-act="retry" hidden>补记当前回复</button></div>',
        '<details open><summary>当前世界记录</summary><pre data-view="state"></pre>',
        '<details><summary>查看当前状态 JSON</summary><pre data-view="state-json"></pre></details></details>',
        '<details open><summary>本轮发给编导的世界资料</summary>',
        '<small>这里显示实际请求中的引擎片段，对应当前选中的回复。</small><pre data-view="prompt"></pre></details>',
        '<details data-part="core" hidden><summary>设置核心角色</summary><fieldset class="lwe-stack">',
        '<small>从世界起点的角色里选择。最多八位，只有核心角色参与幕后演化。</small>',
        '<label>角色<select class="text_pole"></select></label>',
        '<label>角色卡 / 人格与背景<textarea class="text_pole" name="lwe-profile" rows="4" maxlength="2400"></textarea></label>',
        '<label>目标与日常<textarea class="text_pole" name="lwe-goals" rows="2" maxlength="600"></textarea></label>',
        '<div class="lwe-row"><button class="menu_button" type="button" data-act="save-core">保存核心角色</button>',
        '<button class="menu_button" type="button" data-act="remove-core">移出主角团</button></div>',
        '<small data-view="core-status" role="status"></small></fieldset></details>',
        '<label>状态记录员的连接 <select class="text_pole" data-act="profile"></select></label>',
        '<form data-part="recorder-connection" hidden><fieldset class="lwe-stack">',
        '<label>API 地址<input name="lwe-recorder-url" class="text_pole" type="url" placeholder="https://api.example.com/v1" required></label>',
        '<label>API 密钥<input name="lwe-recorder-key" class="text_pole" type="password" autocomplete="new-password"></label>',
        '<small>同一地址留空会沿用已保存的密钥。换地址后请填写该接口的密钥。</small>',
        '<label class="lwe-inline-check" data-part="clear-recorder-key" hidden><input type="checkbox" name="lwe-recorder-clear-key"> 清除已保存的密钥</label>',
        '<label>模型 ID<input name="lwe-recorder-model" class="text_pole" type="text" required></label>',
        '<div class="lwe-row lwe-recorder-actions"><button class="menu_button" type="submit">保存记录员接口</button>',
        '<button class="menu_button" type="button" data-act="test-recorder" disabled>测试连接</button></div>',
        '<small data-view="recorder-status" role="status" aria-live="polite"></small>',
        '<small data-view="recorder-test" role="status" aria-live="polite">尚未测试连接。</small>',
        '<small data-view="recorder-unsaved" hidden>保存当前修改后即可测试连接。</small>',
        '</fieldset></form>',
        '<small>建立世界起点后，每轮正文显示后会额外调用一次状态记录员。</small>',
        '<details data-part="seed" hidden><summary>设置世界起点</summary><div class="lwe-stack">',
        '<small>当前已有正文作为起点之前的历史。填入此刻的事实，接下来的回复会更新它们。</small>',
        '<div class="lwe-row"><label>第 <input name="lwe-day" class="text_pole" type="number" min="1" value="1"> 天</label>',
        '<label>时间 <input name="lwe-time" class="text_pole" type="time" value="09:00"></label></div>',
        '<label>地点，每行一个<textarea name="lwe-places" class="text_pole" rows="2" placeholder="旅店"></textarea></label>',
        '<label>角色，每行「名字 | 位置 | 金币余额」，未知余额可留空<textarea name="lwe-characters" class="text_pole" rows="3" placeholder="旅人 | 旅店 | 10"></textarea></label>',
        '<label>核心角色，可留空，每行「名字 | 人格与背景 | 目标与日常」<textarea name="lwe-seed-core" class="text_pole" rows="2"></textarea></label>',
        '<label>路线，每行「起点 | 终点 | 分钟 | 移动方式」<textarea name="lwe-routes" class="text_pole" rows="2" placeholder="旅店 | 集市 | 12 | 步行"></textarea></label>',
        '<label>硬设定和规则，每行一条<textarea name="lwe-rules" class="text_pole" rows="2"></textarea></label>',
        '<label>初始记忆，每行「角色 | 记忆」<textarea name="lwe-memories" class="text_pole" rows="2"></textarea></label>',
        '<label>初始物品，每行「角色 | 物品 | 数量」<textarea name="lwe-items" class="text_pole" rows="2"></textarea></label>',
        '<div class="lwe-row"><button class="menu_button" type="button" data-act="example">填入旅店示例</button>',
        '<button class="menu_button" type="button" data-act="seed">建立世界起点</button></div></div></details></div>',
    ].join('');
    host.append(panel);
    panel.querySelector('[data-act="enabled"]').checked = enabled(context());
    updateProfiles();
    panel.querySelector('[data-act="enabled"]').addEventListener('change', event => {
        const ctx = context();
        settings(ctx).enabled = event.target.checked;
        ctx.saveSettingsDebounced();
        clearPrompt(ctx);
        void refresh();
    });
    panel.querySelector('[data-act="profile"]').addEventListener('change', event => {
        const ctx = context();
        settings(ctx).profile = event.target.value;
        ctx.saveSettingsDebounced();
        void showRecorderConnection();
    });
    const recorderForm = panel.querySelector('[data-part="recorder-connection"]');
    recorderForm.addEventListener('submit', saveRecorderConnection);
    recorderForm.addEventListener('input', () => updateRecorderTestButton(recorderForm));
    recorderForm.querySelector('[data-act="test-recorder"]').addEventListener('click', testRecorderConnection);
    const coreSection = panel.querySelector('[data-part="core"]');
    coreSection.querySelector('select').addEventListener('change', editCoreFields);
    coreSection.querySelector('[data-act="save-core"]').addEventListener('click', saveCore);
    coreSection.querySelector('[data-act="remove-core"]').addEventListener('click', saveCore);
    panel.querySelector('[data-act="example"]').addEventListener('click', example);
    panel.querySelector('[data-act="refresh"]').addEventListener('click', () => void refresh());
    panel.querySelector('[data-act="retry"]').addEventListener('click', () => {
        const ctx = context();
        const scope = scopeOf(ctx);
        if (scope) void enqueue(snapshot(ctx), keyOf(scope), true);
    });
    panel.querySelector('[data-act="seed"]').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const selected = await snapshot(context());
            if (!selected) throw new Error('请先打开一个聊天。');
            const view = await request('/seed', selected, {
                seed: seedFromPanel(), rebuild: button.dataset.rebuild === 'true',
            });
            if (keyOf(scopeOf(context())) === selected.key) draw(view, selected.key);
        } catch (error) {
            showStatus(error.message);
        } finally {
            button.disabled = false;
        }
    });
    void refresh();
}

const ctx = context();
const { eventSource, eventTypes } = ctx;
eventSource.on(eventTypes.APP_READY, mount);
eventSource.on(eventTypes.CONNECTION_PROFILE_LOADED, updateProfiles);
eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, inspectActualPrompt);
eventSource.on(eventTypes.TEXT_COMPLETION_SETTINGS_READY, inspectActualPrompt);
eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, inspectActualPrompt);
eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onRendered);
eventSource.on(eventTypes.GENERATION_STOPPED, () => {
    if (activeGeneration) activeGeneration.canceled = true;
    clearPrompt();
});
eventSource.on(eventTypes.CHAT_CHANGED, () => {
    activeGeneration = undefined;
    clearPrompt();
    void refresh();
});
for (const type of ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
    if (eventTypes[type]) eventSource.on(eventTypes[type], () => void refresh());
}
