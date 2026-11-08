import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const browserModule = process.env.LWE_PLAYWRIGHT_MODULE;
if (!browserModule) throw new Error('Set LWE_PLAYWRIGHT_MODULE to the absolute path of playwright-core/index.mjs.');
const { chromium } = await import(pathToFileURL(browserModule).href);
const target = new URL(process.env.LWE_TEST_URL ?? 'http://127.0.0.1:8019');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.port === '8000') {
    throw new Error('Use an isolated loopback test instance on a separate port.');
}
const url = target.origin;
const installUrl = process.env.LWE_INSTALL_GIT_URL;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage(installUrl ? { viewport: { width: 412, height: 892 }, isMobile: true, hasTouch: true } : {});
const failures = [];
const injections = [];
const recorderInputs = [];
const stateSelector = '#lwe-panel [data-view="state"]';
const statusSelector = '#lwe-panel .lwe-status';
let scriptIndex = 0;
let releaseRecorder;
const firstRecorderGate = new Promise(resolve => { releaseRecorder = resolve; });

const replies = [
    {
        prose: '阿青俯身听见旅人低声说出暗号「燕子」。',
        elapsed: 2,
        changes: [{ type: 'memory', who: '阿青', kind: 'heard', content: '暗号是燕子', via: '旅人私下告知' }],
    },
    {
        prose: '旅人步行十二分钟，从旅店抵达集市。',
        elapsed: 12,
        changes: [{ type: 'move', who: '旅人', from: '旅店', to: '集市', mode: '步行', minutes: 12 }],
    },
    {
        prose: '旅人在旅店又等了三分钟，暂未出门。',
        elapsed: 3,
        changes: [],
    },
    {
        prose: '旅人离开旅店，步行十二分钟后抵达集市。',
        elapsed: 12,
        changes: [{ type: 'move', who: '旅人', from: '旅店', to: '集市', mode: '步行', minutes: 12 }],
    },
    {
        prose: '旅人从钱袋里取出十五枚金币付清，拿走铜灯。',
        elapsed: 1,
        changes: [
            { type: 'item', who: '旅人', name: '铜灯', delta: 1 },
            { type: 'coins', who: '旅人', delta: -15 },
        ],
    },
];

function recordedContent(selected) {
    return JSON.stringify({
        elapsed: selected.elapsed, estimated: false, clockEvidence: selected.prose,
        events: [{ summary: selected.prose, evidence: selected.prose, changes: selected.changes }],
        conflicts: [], repairEvidence: null,
    });
}

const mockKey = 'lwe-test-credential';
let rejectRecorderTest = true;
const customRecorder = createServer(async (request, response) => {
    try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/recorder/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer ' + mockKey);
        let body = '';
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        assert.equal(payload.model, 'isolated-recorder-model');
        if (payload.messages.at(-1).content === '请回复 OK。') {
            if (rejectRecorderTest) {
                response.writeHead(401).end();
            } else {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
            }
            return;
        }
        const input = JSON.parse(payload.messages.at(-1).content);
        recorderInputs.push(input);
        const selected = replies.find(entry => input.newMessages.at(-1)?.text.includes(entry.prose));
        assert.ok(selected, 'Unexpected prose sent to custom state recorder');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: recordedContent(selected) } }] }));
    } catch (error) {
        failures.push(error.message);
        response.writeHead(500).end();
    }
});

page.on('pageerror', error => failures.push(error.message));
page.on('response', response => {
    if (response.status() >= 400 && response.url().includes('/api/plugins/living-world-engine/')) {
        failures.push('World engine HTTP ' + response.status() + ' at ' + response.url());
    }
});

await page.route('**/*', async route => {
    const request = route.request();
    const endpoint = new URL(request.url());
    if (endpoint.origin !== url) return route.abort();
    if (endpoint.pathname === '/api/backends/chat-completions/status') {
        return route.fulfill({ json: { data: [{ id: 'lwe-smoke' }] } });
    }
    if (endpoint.pathname !== '/api/backends/chat-completions/generate') return route.continue();
    const payload = request.postDataJSON();
    const messages = payload.messages ?? [];
    const recording = messages.some(message => String(message.content).includes('你是世界状态记录员'));
    let content;
    if (recording) {
        const input = JSON.parse(messages.at(-1).content);
        recorderInputs.push(input);
        const selected = replies.find(entry => input.newMessages.at(-1)?.text.includes(entry.prose));
        assert.ok(selected, 'Unexpected prose sent to state recorder');
        if (selected === replies[0]) await firstRecorderGate;
        content = recordedContent(selected);
    } else {
        assert.equal(payload.model, 'lwe-smoke');
        assert.equal(payload.custom_url, 'http://127.0.0.1:9999/v1');
        injections.push(messages.map(message => message.content).join('\n'));
        content = replies[scriptIndex++].prose;
    }
    if (payload.stream) {
        assert.equal(recording, false, 'Recording must finish before it is parsed');
        return route.fulfill({
            contentType: 'text/event-stream',
            body: 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
                + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
        });
    }
    return route.fulfill({
        json: { id: 'lwe-smoke', object: 'chat.completion', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] },
    });
});

async function worldShows(text, timeout = 16_000) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text),
        { selector: stateSelector, text }, { timeout });
}

async function send(text) {
    await page.evaluate(async text => {
        const input = document.querySelector('#send_textarea');
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await SillyTavern.getContext().generate('normal');
    }, text);
}

try {
    await new Promise((resolve, reject) => {
        customRecorder.once('error', reject);
        customRecorder.listen(0, '127.0.0.1', resolve);
    });
    const customUrl = 'http://127.0.0.1:' + customRecorder.address().port + '/recorder/v1';
    await page.goto(url + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(install => document.querySelector('dialog[open] .onboarding')
        || (install ? globalThis.SillyTavern?.getContext?.().characters.length : document.querySelector('#lwe-panel')),
    Boolean(installUrl), { timeout: 30_000 });
    const onboarding = page.locator('dialog[open]').filter({ has: page.locator('.onboarding') });
    if (await onboarding.count()) {
        await onboarding.locator('.popup-input').fill('旅人');
        await onboarding.locator('.popup-button-ok').click();
    }
    if (installUrl) {
        await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0);
        const installed = await page.evaluate(async url => {
            const response = await fetch('/api/extensions/install', {
                method: 'POST',
                headers: SillyTavern.getContext().getRequestHeaders(),
                body: JSON.stringify({ url, global: false }),
            });
            if (!response.ok) throw new Error('SillyTavern extension installation failed: ' + response.status + ' ' + await response.text());
            return response.json();
        }, installUrl);
        assert.equal(installed.display_name, 'Living World Engine');
        await page.reload({ waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('#lwe-panel', { state: 'attached', timeout: 30_000 });
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0);
    await page.evaluate(async chatId => {
        const script = await import('/script.js');
        const api = await import('/scripts/openai.js');
        const ctx = SillyTavern.getContext();
        await ctx.selectCharacterById('0');
        await ctx.openCharacterChat(chatId);
        script.changeMainAPI('openai');
        Object.assign(api.oai_settings, {
            chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:9999/v1',
            custom_model: 'lwe-smoke', stream_openai: true, openai_max_context: 8192,
        });
        script.setOnlineStatus('Valid');
    }, 'lwe-smoke-' + Date.now());
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('尚未建立世界起点'), statusSelector);
    await page.locator('#lwe-panel [data-act="example"]').evaluate(button => button.click());
    await page.locator('#lwe-panel [data-act="seed"]').evaluate(button => button.click());
    await worldShows('09:00');

    await send('我只告诉阿青，暗号是燕子。');
    assert.match(await page.locator('#chat .mes').last().textContent(), /阿青俯身听见/);
    assert.match(await page.locator(stateSelector).textContent(), /09:00/);
    releaseRecorder();
    await worldShows('09:02');
    await worldShows('暗号是燕子（亲耳听到');
    assert.match(injections[0], /\[Living World Engine · 本轮世界资料\]/);
    assert.match(injections[0], /我只告诉阿青，暗号是燕子/);
    assert.match(await page.locator('#lwe-panel [data-view="prompt"]').textContent(), /09:00/);
    await page.evaluate(async () => { (await import('/scripts/openai.js')).oai_settings.stream_openai = false; });

    await page.locator('#lwe-panel [data-act="profile"]').evaluate(select => {
        select.value = Array.from(select.options).find(option => option.text === '自定义接口').value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#lwe-panel [data-part="recorder-connection"]').dataset.loaded === 'true');
    await page.locator('#lwe-panel [data-part="recorder-connection"]').evaluate((form, { url, key }) => {
        form.elements['lwe-recorder-url'].value = url;
        form.elements['lwe-recorder-model'].value = 'isolated-recorder-model';
        form.elements['lwe-recorder-key'].value = key;
        form.requestSubmit();
    }, { url: customUrl + '/chat/completions', key: mockKey });
    await page.waitForFunction(() => document.querySelector('#lwe-panel [data-view="recorder-status"]').textContent.includes('接口和密钥已保存'));
    assert.equal(await page.locator('#lwe-panel [name="lwe-recorder-key"]').inputValue(), '');
    const saved = await page.evaluate(() => fetch('/api/plugins/living-world-engine/recorder-connection').then(response => response.json()));
    assert.deepEqual(saved, { url: customUrl, model: 'isolated-recorder-model', hasKey: true, test: null });
    const testButton = page.locator('#lwe-panel [data-act="test-recorder"]');
    const testResult = page.locator('#lwe-panel [data-view="recorder-test"]');
    assert.match(await testResult.textContent(), /尚未测试连接/);
    await testButton.evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelector('#lwe-panel [data-view="recorder-test"]').dataset.result === 'failed');
    assert.match(await testResult.textContent(), /HTTP 401/);
    rejectRecorderTest = false;
    await testButton.evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelector('#lwe-panel [data-view="recorder-test"]').dataset.result === 'ok');
    assert.match(await testResult.textContent(), /连接成功/);

    await send('我步行去集市。');
    await worldShows('09:14');
    await worldShows('旅人 · 集市');
    assert.match(injections[1], /阿青 的记忆.*暗号是燕子/);
    assert.doesNotMatch(injections[1], /阿岚 的记忆.*暗号是燕子/);

    await page.evaluate(() => SillyTavern.getContext().generate('regenerate'));
    await worldShows('09:05');
    await worldShows('旅人 · 旅店');
    assert.match(injections[2], /当前时间：第 1 天 09:02/);

    await page.evaluate(async () => {
        const script = await import('/script.js');
        const { SWIPE_SOURCE } = await import('/scripts/constants.js');
        await script.swipe_right(null, { source: SWIPE_SOURCE.SLASH_COMMAND, message: SillyTavern.getContext().chat.at(-1) });
    });
    await worldShows('09:14');
    await worldShows('旅人 · 集市');
    assert.match(injections[3], /当前时间：第 1 天 09:02/);
    await page.evaluate(async () => {
        const script = await import('/script.js');
        const { SWIPE_SOURCE } = await import('/scripts/constants.js');
        await script.swipe_left(null, { source: SWIPE_SOURCE.SLASH_COMMAND, message: SillyTavern.getContext().chat.at(-1) });
    });
    await worldShows('09:05');
    await worldShows('旅人 · 旅店');

    await send('我想看看这盏铜灯。');
    await worldShows('记录尝试减少 15 枚');
    assert.match(await page.locator('#chat .mes').last().textContent(), /拿走铜灯/);
    assert.match(await page.locator(stateSelector).textContent(), /旅人 · 旅店 · 10 枚金币/);
    assert.doesNotMatch(await page.locator(stateSelector).textContent(), /物品　.*铜灯/);
    await page.evaluate(() => SillyTavern.getContext().deleteLastMessage());
    await page.evaluate(() => SillyTavern.getContext().deleteLastMessage());
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('当前聊天一致'), statusSelector);
    await worldShows('09:05');
    await page.evaluate(() => SillyTavern.getContext().saveChat());
    const activeChatId = await page.evaluate(() => SillyTavern.getContext().chatId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#lwe-panel', { state: 'attached' });
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0);
    await page.evaluate(async id => {
        const ctx = SillyTavern.getContext();
        if (ctx.chatId !== id) {
            await ctx.selectCharacterById('0');
            if (ctx.chatId !== id) await ctx.openCharacterChat(id);
        }
    }, activeChatId);
    await worldShows('09:05');
    assert.equal(recorderInputs.length, 5);
    await page.waitForFunction(() => document.querySelector('#lwe-panel [data-view="recorder-test"]').dataset.result === 'ok');
    await page.evaluate(async prose => {
        const ctx = SillyTavern.getContext();
        const index = ctx.chat.findIndex(entry => entry.mes.includes(prose));
        await ctx.deleteMessage(index);
    }, replies[0].prose);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('需要重建'), statusSelector);
    assert.deepEqual(failures, []);
    console.log('SillyTavern browser smoke passed: independent recorder URL and key, native context injection, direct prose, travel, regenerate, swipe, conflict, truncation, reload, middle deletion.');
} catch (error) {
    console.error('Status:', await page.locator(statusSelector).textContent({ timeout: 1000 }).catch(() => 'unavailable'));
    console.error('Browser errors:', failures);
    throw error;
} finally {
    releaseRecorder();
    customRecorder.close();
    await browser.close();
}
