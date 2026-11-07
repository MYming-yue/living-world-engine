import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, makeLedger, recordTurn, viewLedger } from '../server/history.mjs';

const seed = {
    minute: 9 * 60,
    locations: ['旅店', '集市'],
    rules: ['只有通过明确途径获知的消息才能成为角色的记忆。'],
    routes: [{ from: '旅店', to: '集市', mode: '步行', minutes: 12 }],
    characters: [
        { name: '旅人', location: '旅店', coins: 10 },
        { name: '阿青', location: '旅店' },
        { name: '阿岚', location: '集市' },
    ],
};

function message(role, text, stamp = text) {
    const name = role === 'user' ? '旅人' : '编导';
    const id = digest(JSON.stringify([role, name, stamp, text]));
    return { id, role, name, stamp, text };
}

const ids = entries => entries.map(({ id, role }) => ({ id, role }));
const user = text => message('user', text);
const reply = text => message('assistant', text);
const person = (view, name) => view.state.characters.find(entry => entry.name === name);

function proposal(evidence, changes, elapsed = 0) {
    return {
        elapsed, estimated: false, clockEvidence: elapsed ? evidence : null,
        events: [{ summary: evidence, evidence, offset: elapsed, changes }],
        conflicts: [], repairEvidence: null,
    };
}

function prepare(ledger, entries, update) {
    const history = ids(entries);
    const view = viewLedger(ledger, history);
    return {
        history, epoch: view.epoch, tip: view.tip, base: view.base, entries: entries.slice(view.start), proposal: update,
    };
}

function save(ledger, entries, update) {
    recordTurn(ledger, prepare(ledger, entries, update));
    return viewLedger(ledger, ids(entries));
}

test('same player action can have independent alternatives with no double charge', () => {
    const ledger = makeLedger(seed, []);
    const input = user('我问老板能否便宜点。');
    const first = reply('老板同意三枚金币，旅人支付后拿走灯。');
    const second = reply('老板同意五枚金币，旅人支付后拿走灯。');
    const paid = count => [{ type: 'coins', who: '旅人', delta: -count }, { type: 'item', who: '旅人', name: '灯', delta: 1 }];
    const request = prepare(ledger, [input, first], proposal(first.text, paid(3), 2));
    assert.equal(recordTurn(ledger, request), true);
    assert.equal(recordTurn(ledger, request), false);
    const secondView = save(ledger, [input, second], proposal(second.text, paid(5), 4));
    assert.equal(person(secondView, '旅人').coins, 5);
    const restored = viewLedger(JSON.parse(JSON.stringify(ledger)), ids([input, first]));
    assert.equal(restored.state.time, '第 1 天 09:02');
    assert.equal(person(restored, '旅人').coins, 7);
    assert.deepEqual(person(restored, '旅人').items, [{ name: '灯', count: 1 }]);
    assert.equal(person(viewLedger(ledger, ids([input])), '旅人').coins, 10);
});

test('a middle deletion with retained prose requires a rebuild', () => {
    const ledger = makeLedger(seed, []);
    const first = [user('询问路线。'), reply('她指向集市。')];
    save(ledger, first, proposal(first[1].text, []));
    const later = [user('向阿青告别。'), reply('她道了声再见。')];
    save(ledger, [...first, ...later], proposal(later[1].text, []));
    const altered = viewLedger(ledger, ids([first[0], ...later]));
    assert.equal(altered.status, 'rebuild');
    assert.equal(altered.prompt, undefined);
    assert.equal(viewLedger(ledger, ids(first)).status, 'ready');
});

test('a contradiction holds dependent changes until later prose supplies evidence', () => {
    const ledger = makeLedger(seed, []);
    const entry = [user('我买地图。'), reply('旅人拿到地图，付了十五枚金币。')];
    const rejected = save(ledger, entry, proposal(entry[1].text, [
        { type: 'item', who: '旅人', name: '地图', delta: 1 },
        { type: 'coins', who: '旅人', delta: -15 },
    ]));
    assert.equal(rejected.status, 'conflict');
    assert.deepEqual(person(rejected, '旅人').items, []);
    assert.equal(person(rejected, '旅人').coins, 10);
    assert.match(rejected.issues[0].detail, /只有 10/);
    assert.equal(rejected.issues[0].evidence, entry[1].text);
    const fix = [user('我确认还有多少欠款。'), reply('商人说刚才只收了十枚金币，余下五枚记账。')];
    const update = proposal(fix[1].text, [
        { type: 'item', who: '旅人', name: '地图', delta: 1 },
        { type: 'coins', who: '旅人', delta: -10 },
        { type: 'debt', who: '旅人', to: '商人', delta: 5 },
    ]);
    update.repairEvidence = fix[1].text;
    const repaired = save(ledger, [...entry, ...fix], update);
    assert.equal(repaired.status, 'ready');
    assert.equal(person(repaired, '旅人').coins, 0);
    assert.deepEqual(person(repaired, '旅人').debts, [{ to: '商人', coins: 5 }]);
    assert.equal(viewLedger(ledger, ids(entry)).status, 'conflict');
});

test('only the named recipient learns the secret and travel can span responses', () => {
    const ledger = makeLedger(seed, []);
    const opening = [user('我私下告诉阿青暗号是燕子。'), reply('阿青听清了暗号，随后从旅店步行出发。')];
    const first = proposal(opening[1].text, [
        { type: 'memory', who: '阿青', kind: 'heard', content: '暗号是燕子', via: '旅人私下告知' },
        { type: 'travel', who: '阿青', from: '旅店', to: '集市', mode: '步行' },
    ], 0);
    first.elapsed = 5;
    first.clockEvidence = opening[1].text;
    const traveling = save(ledger, opening, first);
    assert.equal(person(traveling, '阿青').travel.to, '集市');
    assert.equal(person(traveling, '阿青').location, '旅店');
    assert.match(traveling.prompt, /阿青 的记忆.*暗号是燕子/);
    assert.equal(person(traveling, '阿岚').memories.length, 0);
    const arrival = [user('再等七分钟。'), reply('又过了七分钟，阿青抵达集市。')];
    const arrived = save(ledger, [...opening, ...arrival], proposal(arrival[1].text, [
        { type: 'move', who: '阿青', from: '旅店', to: '集市', mode: '步行', minutes: 12 },
    ], 7));
    assert.equal(arrived.status, 'ready');
    assert.equal(arrived.state.time, '第 1 天 09:12');
    assert.equal(person(arrived, '阿青').location, '集市');
    assert.equal(person(arrived, '阿青').travel, null);
});

test('a fabricated citation does not change the world', () => {
    const ledger = makeLedger(seed, []);
    const entries = [user('我想去集市。'), reply('你还站在旅店门口。')];
    const view = save(ledger, entries, proposal('已经走到集市', [
        { type: 'move', who: '旅人', from: '旅店', to: '集市', mode: '步行', minutes: 12 },
    ], 12));
    assert.equal(view.status, 'conflict');
    assert.equal(person(view, '旅人').location, '旅店');
    assert.equal(view.state.time, '第 1 天 09:00');
});
