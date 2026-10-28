/**
 * 冒烟测试：只验证仓库自身的一致性（清单、资源、语法、导出面），
 * 不联网、不依赖 DSH 运行时。运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

test('manifest declares a bundle patch and a web client entry', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(pkg.exports['./client'], 'exports ./client is required by the client module system');
  assert.ok(pkg.exports['./locale/*.json']);
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'bundle patch file exists');
  assert.ok(existsSync(join(root, pkg.exports['./client'])), 'client artifact exists');
  assert.ok(existsSync(join(root, 'icon.svg')), 'icon exists');
});

test('locale files carry plugin metadata', () => {
  for (const locale of ['zh', 'en']) {
    const meta = readJson(`locale/${locale}.json`).meta;
    assert.ok(meta && typeof meta.title === 'string' && meta.title.length > 0, `${locale} title`);
    assert.ok(typeof meta.description === 'string' && meta.description.length > 0, `${locale} description`);
  }
});

test('sources are syntactically valid', () => {
  for (const file of ['index.js', 'client.js']) {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  }
});

test('host plugin exports the expected surface', async () => {
  const mod = await import('../index.js');
  assert.equal(mod.name, '@local/dsh-zhipu-quota');
  assert.ok(Array.isArray(mod.inject));
  assert.ok(mod.inject.includes('webServer'));
  assert.equal(typeof mod.apply, 'function');
});

test('bundle patch inserts the plugin row once', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const matches = text.match(/id:\s*zhipu-quota/g) ?? [];
  assert.equal(matches.length, 1);
});
