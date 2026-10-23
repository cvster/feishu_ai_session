import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const bundle = readFileSync(new URL('../dist/cli.js', import.meta.url), 'utf8');
function section(path) {
  const marker = `// ${path}\n`;
  const from = bundle.indexOf(marker);
  assert.ok(from >= 0, `Missing section ${path}`);
  const to = bundle.indexOf('\n// ', from + marker.length);
  return bundle.slice(from, to < 0 ? undefined : to);
}
const projectHelper = bundle.match(/^function projectNameFromCwd\(cwd\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(projectHelper, 'Missing project-name helper');
const api = runInNewContext([
  section('src/agent/models.ts'),
  section('src/card/run-progress.ts'),
  section('src/card/run-status-render.ts'),
  section('src/card/run-renderer.ts'),
  projectHelper,
  '({renderCard, renderRunStatus, renderColoredRunStatus, modelLabel, projectNameFromCwd})',
].join('\n'));
const initial = {
  blocks: [], reasoning: { content: '', active: false }, footer: 'thinking', terminal: 'running',
};
function buttons(card) {
  return card.body.elements.find((element) => element.tag === 'column_set')
    .columns.map((column) => ({ ...column.elements[0], icon: column.elements[0].elements[0].columns[0].elements[0].icon }));
}

test('deployed controls use five icons and preserve their callbacks', () => {
  for (const terminal of ['running', 'done']) {
    const controls = buttons(api.renderCard({ ...initial, terminal }));
    assert.deepEqual(Array.from(controls, (button) => button.icon?.token ?? button.text?.content),
      ['stop_outlined', 'setting_outlined', 'refresh_outlined', 'mindmap-down_outlined', 'archive_outlined']);
    for (const button of controls) {
      assert.equal(button.icon.tag, 'standard_icon');
      assert.equal(button.text, undefined);
      assert.ok(button.hover_tips.content);
    }
    for (const [index, button] of [[0, controls[0]], [4, controls[4]]]) {
      const color = index === 0 && terminal === 'done' ? 'grey' : 'red';
      assert.equal(button.icon.color, color);
      assert.equal(button.border_color, color);
      assert.equal(button.text, undefined);
      assert.ok(button.hover_tips.content);
    }
    assert.deepEqual(Array.from(controls, (button) => button.behaviors[0].value.cmd),
      ['stop', 'config', 'refresh', 'fork', 'finish']);
    assert.equal(controls[2].icon.color, 'green');
    assert.equal(controls[3].icon.color, 'blue');
    for (const column of api.renderCard(initial).body.elements.at(-1).columns) {
      assert.equal(column.width, 'weighted');
      assert.equal(column.weight, 1);
      assert.equal(column.horizontal_align, 'center');
      const control = column.elements[0];
      assert.equal(control.tag, 'interactive_container');
      assert.equal(control.width, '32px');
      assert.equal(control.height, '32px');
      const glyphRow = control.elements[0];
      const glyphColumn = glyphRow.columns[0];
      assert.equal(control.padding, '0px');
      assert.equal(control.vertical_align, 'center');
      assert.equal(glyphRow.horizontal_align, 'center');
      assert.equal(glyphRow.horizontal_spacing, '0px');
      assert.equal(glyphColumn.width, '16px');
      assert.equal(glyphColumn.padding, '0px');
      assert.equal(control.border_color, glyphColumn.elements[0].icon.color);
      assert.equal(glyphColumn.elements[0].text_size, 'notation');
    }
  }
});
test('deployed production controls use centered framed images with clickable callbacks', () => {
  const actions = ['stop', 'config', 'refresh', 'fork', 'finish'];
  const buttonImageKeys = Object.fromEntries(actions.map((action) => [action, `img_${action}`]));
  const card = api.renderCard(initial, { buttonImageKeys, signCallback: () => 'signed-stop' });
  const controls = card.body.elements.at(-1).columns.map((column) => column.elements[0]);
  for (const [index, control] of controls.entries()) {
    assert.equal(control.has_border, false);
    assert.equal(control.width, '32px');
    assert.equal(control.height, '32px');
    assert.equal(control.elements.length, 1);
    assert.equal(control.elements[0].tag, 'img');
    assert.equal(control.elements[0].img_key, `img_${actions[index]}`);
    assert.equal(control.elements[0].size, '32px 32px');
    assert.equal(control.elements[0].preview, false);
    assert.equal(control.behaviors[0].value.cmd, actions[index]);
  }
  assert.equal(controls[0].behaviors[0].value.bridge_token, 'signed-stop');
});

test('deployed custom Git fork image preserves its callback', () => {
  const fork = buttons(api.renderCard(initial, { forkIconKey: 'img_test_fork' }))[3];
  assert.equal(fork.icon.tag, 'custom_icon');
  assert.equal(fork.icon.img_key, 'img_test_fork');
  assert.equal(fork.behaviors[0].value.cmd, 'fork');
});
test('deployed stop remains signed, and disabling it keeps the other controls', () => {
  const controls = buttons(api.renderCard(initial, { signCallback: (action) => `signed-${action}` }));
  assert.equal(controls[0].behaviors[0].value.bridge_token, 'signed-stop');
  assert.equal(controls[0].behaviors[0].value.__bridge_cb, true);
  assert.equal(buttons(api.renderCard(initial, { showStopButton: false })).length, 4);
});
test('deployed status includes the project and model for running and completed tasks', () => {
  for (const terminal of ['running', 'done']) {
    const state = { ...initial, terminal, projectName: api.projectNameFromCwd('/home/pc/code/tmini_platform/'),
      execution: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      runtime: { startedAtMs: 1000, lastActivityAtMs: 1000, checkedAtMs: 2000, processRunning: true },
    };
    assert.ok(api.renderRunStatus(state).includes('项目 tmini_platform · gpt-6.1-sol · high'));
    assert.ok(api.renderColoredRunStatus(state).includes(`<font color='${terminal === 'running' ? 'blue' : 'green'}'>`));
    assert.ok(JSON.stringify(api.renderCard(state)).includes('项目 tmini_platform'));
  }
  assert.equal(api.projectNameFromCwd('C:\\code\\project\\'), 'project');
  assert.equal(api.modelLabel('codex', 'gpt-6.1-sol'), 'gpt-6.1-sol');
});
test('project names cannot inject status font markup', () => {
  assert.ok(api.renderColoredRunStatus({ ...initial, projectName: '<demo>&' })
    .includes('&lt;demo&gt;&amp;'));
});
