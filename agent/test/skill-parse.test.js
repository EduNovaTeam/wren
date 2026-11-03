import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SkillFormatError, parseSkillFile } from '../src/skills/parse.js';

const text = (frontmatter, body = '# 正文\n') =>
  ['---', ...frontmatter.split('\n'), '---', '', body].join('\n');

test('parses fields, metadata and block-list allowed-tools', () => {
  const { data, body } = parseSkillFile(
    text(
      [
        'name: weekly-report',
        'description: 用户需要写周报时使用。',
        'allowed-tools:',
        '  - current_time',
        '  - fetch_url',
        'license: MIT',
        'compatibility: 需要工具调用',
        'metadata:',
        '  owner: product',
        '  version: "1.0"',
      ].join('\n'),
    ),
  );
  assert.equal(data.name, 'weekly-report');
  assert.equal(data.description, '用户需要写周报时使用。');
  assert.deepEqual(data['allowed-tools'], ['current_time', 'fetch_url']);
  assert.equal(data.metadata.owner, 'product');
  assert.equal(data.metadata.version, '1.0');
  assert.equal(body, '# 正文');
});

test('allowed-tools accepts spaces and commas on one line', () => {
  const { data } = parseSkillFile(
    text('name: x\ndescription: 简介\nallowed-tools: a, b  c'),
  );
  assert.deepEqual(data['allowed-tools'], ['a', 'b', 'c']);
});

test('quoted scalar values are unwrapped', () => {
  const { data } = parseSkillFile(
    text("name: x\ndescription: '带引号的简介'\nlicense: \"MIT\""),
  );
  assert.equal(data.description, '带引号的简介');
  assert.equal(data.license, 'MIT');
});

test('rejects unsupported frontmatter formats', () => {
  const cases = [
    ['没有 frontmatter', '# 只有正文'],
    ['没有闭合', '---\nname: x\ndescription: d\n'],
    ['未知字段', text('name: x\ndescription: d\nauthor: me')],
    ['多行值', text('name: x\ndescription: |\n  d')],
    ['流式集合', text('name: x\ndescription: [a]')],
    ['锚点', text('name: x\ndescription: &a d')],
    ['制表符', text('name:\tx\ndescription: d')],
    ['重复字段', text('name: x\nname: y\ndescription: d')],
    ['metadata 缩进不对', text('name: x\ndescription: d\nmetadata:\n    owner: p')],
    ['metadata 不是键值', text('name: x\ndescription: d\nmetadata:\n  - owner')],
    ['顶层缩进', text('name: x\n description: d')],
    ['行内注释', text('name: x\ndescription: d # 注释')],
    ['重复 metadata 字段', text('name: x\ndescription: d\nmetadata:\n  owner: a\n  owner: b')],
  ];
  for (const [label, source] of cases) {
    assert.throws(() => parseSkillFile(source), SkillFormatError, label);
  }
});

test('CRLF and BOM are tolerated', () => {
  const { data } = parseSkillFile('\uFEFF---\r\nname: x\r\ndescription: d\r\n---\r\n正文\r\n');
  assert.equal(data.name, 'x');
});
