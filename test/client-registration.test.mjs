/**
 * 回归测试：客户端模块被重新物化（HMR、设置页同步）时，状态栏插槽不应因为
 * 重复注册同一个 id 而抛错。只依赖 Node，不加载真实 DSH 运行时。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const fakeReact = {
  createElement: () => ({}),
  useEffect: () => {},
  useState: (value) => [value, () => {}],
  useRef: (value) => ({ current: value }),
};

/** 在 vm 里执行 client.js，取出 __ModuleLoader__ 注册的模块定义并物化它。 */
function loadClientModule() {
  const source = readFileSync(join(root, 'client.js'), 'utf8');
  let definition;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { definition = def; } } },
    console: { warn: () => {}, error: () => {}, log: () => {} },
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.ok(definition, 'client.js 注册了模块定义');
  const require = (id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require: ${id}`);
  };
  return definition.factory(require);
}

function makeCtx(register) {
  return {
    locale: undefined,
    get: () => undefined,
    effect: (fn) => fn(),
    slots: {
      register,
      inject: (_name, reg) => reg(),
    },
  };
}

const DUPLICATE = 'list slot "conversation.composer.dock" already has an entry with id "dsh-quota" at priority 0 (registered by Gb)';

test('重新物化的客户端不会因为重复注册状态栏插槽而抛错', () => {
  const module = loadClientModule();
  assert.equal(typeof module.apply, 'function');

  let registered = 0;
  const register = () => {
    registered += 1;
    if (registered > 1) throw new Error(DUPLICATE);
    return () => {};
  };

  assert.doesNotThrow(() => module.apply(makeCtx(register)), '首次注册状态栏');
  assert.equal(registered, 1);
  assert.doesNotThrow(() => module.apply(makeCtx(register)), '再次物化时容忍重复注册');
  assert.equal(registered, 2);
});

test('其他注册错误仍然向上抛出', () => {
  const module = loadClientModule();
  const register = () => {
    throw new Error('slot "conversation.composer.dock" is not declared');
  };
  assert.throws(() => module.apply(makeCtx(register)), /is not declared/);
});
