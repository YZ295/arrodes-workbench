const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { _electron } = require('playwright-core');

const source = resolve(__dirname, '..');
const binary = process.env.ARRODES_TEST_EXE;
const workspaceName = '验收工作区';
const powershellTask = '用 PowerShell 检查本机版本';
const browserTask = '打开默认浏览器';
const searchTask = '在 GitHub 搜索 unpdf 的公开仓库';
const spreadsheetTask = '生成一份验收用 Excel 表格';
const task = '在工作区新建 math.js，实现 add(a,b) 并检查语法';
const fileText = 'function add(a, b) { return a + b; }\n';
const questions = ['你好', '你的工作区在哪里', '帮我看看这个', '先不做了'];
const teamGoal = '让团队创建 team.js 并验收';
const brokenTeamGoal = '让团队创建有语法错误的 broken.js 并验收';
const rolesQuestion = '查看当前可用的角色';
const roleHelpQuestions = ['你可不可以直接创一个新的agent', '也就是说我要自己创建对吗？你不能自己直接创建一个'];
const desktopRoleRequest = '那我要创建一个新的agent：用于操控电脑';
const draftQuestion = '你帮我拟好名称、职责和建议权限。';
const customRoleName = '引用核对员';
const customRoleDescription = '只核对术语和出处，说明核对依据。';
const customRoleGoal = '让引用核对员给出核对说明';
const forbiddenRoleGoal = '让引用核对员写越权.txt';
const canvasGoal = '按画布协作，创建 canvas.js';
const prepareSkill = 'PREPARE_SKILL_ONLY：交接说明使用 42。';
const implementSkill = 'IMPLEMENT_SKILL_ONLY：用 CommonJS 导出收到的数值。';
const assistant = (content) => ({ role: 'assistant', content });
const toolCall = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{
  id: name, type: 'function', function: { name, arguments: JSON.stringify(args) },
}] });

function teamReply(messages, tools) {
  const stage = messages[0].content.split('\n')[0];
  const input = messages[1].content;
  const goal = stage.startsWith('协作阶段：') ? JSON.parse(input).goal : undefined;
  const broken = input.includes(brokenTeamGoal);
  if (goal === canvasGoal) {
    const payload = JSON.parse(input);
    const prompt = messages[0].content;
    assert.equal(prompt.includes(prepareSkill), stage === '协作阶段：调研');
    assert.equal(prompt.includes(implementSkill), stage === '协作阶段：执行');
    if (stage === '协作阶段：规划') {
      const reviewer = payload.roles.find(({ name }) => name === '资料搭档');
      assert.ok(reviewer);
      assert.ok(!payload.roles.some(({ name }) => name === customRoleName));
      return assistant(JSON.stringify({ action: 'run', tasks: [
        { id: 'implement', role: 'execute', requiredInputs: [], requiredAccess: 'write', acceptance: '交付与目标一致', title: '写文件', goal: '创建 canvas.js', dependsOn: [] },
        { id: 'prepare', role: reviewer.id, requiredInputs: [], requiredAccess: 'read', acceptance: '交付与目标一致', title: '准备资料', goal: '给出可交接的资料', dependsOn: [] },
      ] }));
    }
    if (stage === '协作阶段：调研') {
      assert.ok(!tools.some(({ function: tool }) => tool.name.startsWith('mcp_')));
      return assistant('画布交接：函数应返回 42。');
    }
    if (stage === '协作阶段：执行') {
      assert.match(JSON.stringify(payload.upstream), /画布交接/);
      const mcp = tools.find(({ function: tool }) => tool.name.startsWith('mcp_'));
      assert.ok(mcp);
      const results = messages.filter(({ role }) => role === 'tool');
      if (!results.length) return toolCall(mcp.function.name, {});
      assert.equal(JSON.parse(results[0].content).output, '425.76');
      return results.length > 1
        ? assistant('已生成 canvas.js')
        : toolCall('write_file', { path: 'canvas.js', content: 'module.exports = () => 42;\n' });
    }
    if (stage === '协作阶段：验收') {
      assert.match(input, /canvas\.js.*语法检查通过/s);
      return assistant(JSON.stringify({ passed: true, reason: '交接后完成文件。' }));
    }
    if (stage === '协作阶段：汇总') return assistant('画布协作完成。');
  }
  if (goal === customRoleGoal || goal === forbiddenRoleGoal) {
    if (stage === '协作阶段：规划') {
      const profile = JSON.parse(input).roles.find(({ name }) => name === customRoleName);
      assert.equal(profile.description, customRoleDescription);
      assert.equal(profile.access, 'read');
      return assistant(JSON.stringify({ action: 'run', tasks: [
        { id: 'check-reference', role: profile.id, requiredInputs: [], requiredAccess: 'read', acceptance: '交付与目标一致', title: '核对引用', goal: '报告核对结果', dependsOn: [] },
      ] }));
    }
    if (stage === '协作阶段：调研') {
      assert.ok(messages[0].content.includes(customRoleDescription));
      assert.ok(tools.some((tool) => tool.function.name === 'read_file'));
      assert.ok(!tools.some((tool) => tool.function.name === 'write_file'));
      if (goal === forbiddenRoleGoal) {
        const result = messages.find(({ role }) => role === 'tool');
        if (!result) return toolCall('write_file', { path: '越权.txt', content: 'unexpected' });
        assert.equal(JSON.parse(result.content).ok, false);
      }
      return assistant('核对交付：术语和出处已核对。');
    }
    if (stage === '协作阶段：验收') {
      assert.match(input, /核对交付/);
      return assistant(JSON.stringify({ passed: true, reason: '符合只读核对要求。' }));
    }
    if (stage === '协作阶段：汇总') return assistant('引用核对员已完成，验收通过。');
  }
  if (stage === '协作阶段：规划' && JSON.parse(input).goal === rolesQuestion) {
    return assistant(JSON.stringify({ action: 'roles' }));
  }
  if (stage === '协作阶段：规划' && (roleHelpQuestions.includes(goal) || goal === desktopRoleRequest)) {
    assert.match(messages[0].content, /对话不能创建或修改角色/);
    if (goal === roleHelpQuestions[1]) {
      assert.ok(JSON.parse(input).history.some(({ content }) => content === roleHelpQuestions[0]));
    }
    return assistant(JSON.stringify({ action: 'role_help' }));
  }
  if (stage === '协作阶段：规划' && goal === draftQuestion) {
    assert.ok(JSON.parse(input).history.some(({ content }) => content === desktopRoleRequest));
    if (!messages[0].content.includes('草拟角色使用 reply')) return assistant(JSON.stringify({ action: 'role_help' }));
    return assistant(JSON.stringify({ action: 'reply', text: '名称：桌面操作顾问。职责：提供桌面操作步骤。建议权限：只读。当前无桌面操作工具。' }));
  }
  if (stage === '协作阶段：规划') return assistant(JSON.stringify({ action: 'run', tasks: [
    { id: 'inspect', role: 'research', requiredInputs: [], requiredAccess: 'read', acceptance: '交付与目标一致', title: '调研', goal: '了解目录和代码约定', dependsOn: [] },
    { id: 'write', role: 'execute', requiredInputs: [], requiredAccess: 'write', acceptance: '交付与目标一致', title: '实现', goal: '写入 team.js', dependsOn: ['inspect'] },
  ] }));
  if (stage === '协作阶段：调研') return assistant('调研交付：采用 CommonJS。');
  if (stage === '协作阶段：协助') return assistant('协助交付：导出 add 函数。');
  if (stage === '协作阶段：执行') {
    assert.match(input, /调研交付/);
    if (!input.includes('协助交付')) {
      assert.ok(tools.some((tool) => tool.function.name === 'request_assist'));
      return toolCall('request_assist', { needs: '导出约定', missingInput: '函数如何导出', expected: '给出导出形式' });
    }
    return messages.some(({ role }) => role === 'tool')
      ? assistant(broken ? '执行交付：broken.js。' : '执行交付：team.js。')
      : toolCall('write_file', broken ? { path: 'broken.js', content: 'function broken(' } : { path: 'team.js', content: fileText });
  }
  if (stage === '协作阶段：验收') {
    assert.match(input, broken ? /broken\.js.*SyntaxError/s : /team\.js.*语法检查通过/s);
    return assistant(JSON.stringify({ passed: true, reason: '代码和交付一致。' }));
  }
  if (stage === '协作阶段：汇总') {
    assert.match(input, /代码和交付一致/);
    return assistant('团队已交付 team.js，验收通过。');
  }
}

// The suite includes multiple Electron launches and real filesystem and shell operations.
test('桌面首屏、零工具问答、真实文件和重启恢复', { timeout: 180000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'arrodes-stage-a-'));
  const outside = await mkdtemp(join(process.env.ARRODES_TEST_WORKSPACE_ROOT || tmpdir(), 'arrodes-folder-'));
  const existingFolder = join(outside, '现有文件夹');
  const customFolder = join(outside, '指定位置新建');
  await mkdir(existingFolder);
  const requests = [];
  const token = randomUUID();
  const backgroundTask = '切换会话时继续执行';
  const clarifyTask = '熟悉这两个订单文件';
  const clarifyOption = '交叉分析并落盘';
  const clarifyFile = '确认后的订单分析.md';
  let finishBackground;
  const backgroundGate = new Promise((resolve) => { finishBackground = resolve; });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/models') {
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'local-test-model' }, { id: 'other-model' }] }));
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { messages, tools, model } = JSON.parse(Buffer.concat(chunks));
      if (!tools && messages.length === 1) {
        assert.equal(model, 'local-test-model');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
        return;
      }
      requests.push(messages);
      const latest = messages.findLast(({ role }) => role === 'user').content;
      if (latest === questions[0]) {
        assert.match(messages[0].content, /对话不能创建或修改角色/);
      }
      const results = messages.slice(messages.findLastIndex(({ role }) => role === 'user') + 1)
        .filter(({ role }) => role === 'tool');
      let message = teamReply(messages, tools);
      if (latest === backgroundTask) {
        await backgroundGate;
        message = assistant('后台任务已完成。');
      } else if (latest === clarifyTask) {
        assert.ok(tools.some((tool) => tool.function.name === 'ask_user'));
        message = toolCall('ask_user', { question: '你希望怎么交付？', options: [
          { label: clarifyOption, task: '交叉核对订单和退款', inputs: ['orders.csv', 'refunds.csv'], outputs: [clarifyFile] },
        ] });
      } else if (latest.includes(`已选方案：${clarifyOption}`)) {
        assert.match(latest, /源文件：\["orders\.csv","refunds\.csv"\]/);
        assert.ok(latest.includes(clarifyFile));
        message = results.length ? assistant('已写入确认后的订单分析。')
          : toolCall('write_file', { path: clarifyFile, content: '已交叉核对订单和退款。' });
      } else if (message) {
        // The local provider implements the team protocol deterministically.
      } else if (latest === powershellTask) {
        assert.ok(tools.some((tool) => tool.function.name === 'run_powershell'));
        if (results.length) {
          const result = JSON.parse(results.at(-1).content);
          assert.equal(result.exitCode, 0, result.output);
          assert.match(result.output, /PowerShell [0-9]+\.[0-9]+/);
        }
        message = results.length ? assistant('已读取 PowerShell 版本。')
          : toolCall('run_powershell', { script: 'Write-Output ("PowerShell " + $PSVersionTable.PSVersion)' });
      } else if (latest === browserTask) {
        assert.ok(tools.some((tool) => tool.function.name === 'open_desktop'));
        if (results.length) assert.equal(JSON.parse(results.at(-1).content).ok, true);
        message = results.length ? assistant('已请求打开浏览器。')
          : toolCall('open_desktop', { target: 'browser' });
      } else if (latest === searchTask) {
        assert.ok(tools.some((tool) => tool.function.name === 'search_github'));
        if (results.length) {
          const result = JSON.parse(results.at(-1).content);
          assert.ok(result.ok, result.output);
          assert.match(result.output, /unjs\/unpdf/);
        }
        message = results.length ? assistant('找到 unjs/unpdf。')
          : toolCall('search_github', { query: 'unpdf in:name', limit: 3 });
      } else if (latest === spreadsheetTask) {
        assert.match(messages[0].content, /表格与数据分析/);
        assert.ok(tools.some((tool) => tool.function.name === 'export_xlsx'));
        if (results.length) assert.equal(JSON.parse(results.at(-1).content).ok, true);
        message = results.length ? assistant('已生成 report.xlsx。')
          : toolCall('export_xlsx', { path: 'report.xlsx', rows: [['金额'], [42]] });
      } else if (latest === task && results.length < 2) {
        const name = results.length === 0 ? 'write_file' : 'check_syntax';
        assert.ok(tools.some((tool) => tool.function.name === name));
        message = { role: 'assistant', content: null, tool_calls: [{
          id: name, type: 'function', function: {
            name, arguments: JSON.stringify({ path: 'math.js', content: fileText }),
          },
        }] };
      } else {
        if (latest === task) assert.ok(results.every((entry) => JSON.parse(entry.content).ok));
        const answers = new Map([
          ['你好', '你好！'],
          ['你的工作区在哪里', messages[0].content.split('当前工作区目录：').at(-1)],
          ['帮我看看这个', '## 先确认\n\n你想让我重点看什么？\n\n- **范围**\n- `math.js`\n\n<img src=x onerror=alert(1)>'],
          ['先不做了', '好，先停在这里。'],
          [task, '已创建 math.js，语法检查通过。'],
          ['接着做什么？', '我们刚刚创建并检查了 math.js。'],
        ]);
        assert.ok(answers.has(latest));
        message = { role: 'assistant', content: answers.get(latest) };
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message }] }));
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, APPDATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.AEW_NODE;
  let app;
  async function launch() {
    app = await _electron.launch({
      ...(binary ? { executablePath: binary } : {}),
      args: [...(binary ? [] : [source]), `--user-data-dir=${profile}`],
      env,
    });
    const directory = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.ok(directory.toLowerCase().startsWith(profile.toLowerCase()), directory);
    return { page: await app.firstWindow(), data: join(directory, 'data') };
  }
  async function send(page, input, answer) {
    await page.locator('#input').fill(input);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.bubble.assistant').last().filter({ hasText: answer }).waitFor();
  }

  try {
    const { page, data } = await launch();
    await page.getByRole('heading', { name: '今天想做什么？' }).waitFor({ timeout: 5000 });
    assert.equal(await page.title(), '谦卑之心');
    const windowChrome = await page.evaluate(() => {
      const titlebar = document.querySelector('.window-titlebar');
      const topLogo = titlebar?.querySelector('.logo');
      const sideLogo = document.querySelector('.sidebar .logo');
      return {
        title: titlebar?.textContent.trim(),
        color: titlebar && getComputedStyle(titlebar).backgroundColor,
        drag: titlebar && getComputedStyle(titlebar).getPropertyValue('-webkit-app-region'),
        sharedLogo: Boolean(topLogo && sideLogo && getComputedStyle(topLogo).background === getComputedStyle(sideLogo).background),
        overlay: navigator.windowControlsOverlay?.visible,
        overlayWidth: navigator.windowControlsOverlay?.getTitlebarAreaRect().width,
        titleHeight: titlebar?.getBoundingClientRect().height,
        contentTop: document.querySelector('#root').getBoundingClientRect().top,
      };
    });
    assert.equal(windowChrome.title, '谦卑之心');
    assert.equal(windowChrome.color, 'rgb(255, 255, 255)');
    assert.equal(windowChrome.drag, 'drag');
    assert.equal(windowChrome.sharedLogo, true);
    assert.equal(windowChrome.overlay, true);
    assert.ok(windowChrome.overlayWidth > 0 && windowChrome.overlayWidth < await page.evaluate(() => innerWidth));
    assert.ok(windowChrome.titleHeight > 0);
    assert.equal(windowChrome.titleHeight, windowChrome.contentTop);

    assert.equal(await page.locator('#input').isVisible(), true);
    const sidebar = page.getByRole('navigation', { name: '主导航' });
    assert.deepEqual(await sidebar.locator(':scope > button:first-child, :scope > section > header > h2').allTextContents(), ['多 Agent', '会话', '项目']);
    await sidebar.getByRole('button', { name: '多 Agent', exact: true }).click();
    await page.getByRole('heading', { name: '多 Agent', exact: true }).waitFor();
    const firstCanvas = page.getByRole('region', { name: '协作画布' });
    await firstCanvas.waitFor({ timeout: 4000 });
    assert.equal(await firstCanvas.getByRole('button', { name: '连接 Agent', exact: true }).count(), 0);
    for (const [id, ports] of [['coordinator', ['out']], ['research', ['in', 'out']], ['execute', ['in', 'out']], ['reviewer', ['in']]]) {
      assert.deepEqual(await firstCanvas.locator(`[data-agent="${id}"] [data-port]`).evaluateAll((items) =>
        items.map((item) => item.dataset.port)), ports);
    }
    await page.getByRole('button', { name: '开始协作' }).waitFor({ timeout: 3500 });
    await page.getByRole('button', { name: '可用角色' }).click({ timeout: 3500 });
    const roster = page.getByRole('dialog', { name: '可用角色' });
    for (const label of ['协调者', '调研 Agent', '执行 Agent', '验收 Agent']) {
      await roster.getByText(label, { exact: true }).waitFor();
    }
    await roster.getByRole('button', { name: '新建角色' }).click({ timeout: 3500 });
    await roster.getByLabel('角色名称').fill(customRoleName);
    await roster.getByLabel('职责').fill(customRoleDescription);
    assert.equal(await roster.getByRole('radio', { name: '只读', exact: true }).isChecked(), true);
    await roster.getByRole('button', { name: '保存角色' }).click();
    await roster.getByText(customRoleName, { exact: true }).waitFor();
    assert.ok((await readFile(join(data, 'team-roles.json'), 'utf8')).includes(customRoleDescription));
    assert.equal(requests.length, 0);
    await roster.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '返回对话' }).click();
    await page.locator('#input').waitFor();
    await page.locator('#workspace-trigger').press('Enter');
    await page.getByRole('button', { name: /默认工作区/ }).last().waitFor();
    await page.locator('#workspace-trigger').press('Escape');
    assert.equal(await page.locator('#workspace-picker').getAttribute('open'), null);
    console.log('1 首屏和输入框');

    await page.getByRole('button', { name: '设置' }).click();
    assert.equal(await page.getByLabel('接口地址').inputValue(), 'https://api.deepseek.com');
    assert.equal(await page.getByLabel('模型', { exact: true }).inputValue(), 'deepseek-flash');
    await page.getByLabel('接口地址').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.getByLabel('模型', { exact: true }).fill('local-test-model');
    await page.getByLabel('API Key').fill(token);
    await page.getByRole('button', { name: '获取模型', exact: true }).click();
    await page.getByLabel('已发现模型').selectOption('local-test-model');
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByText('连接成功，模型已返回回复。', { exact: true }).waitFor({ timeout: 4000 });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('heading', { name: '连接模型' }).waitFor({ state: 'hidden' });
    const settings = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'));
    assert.ok(settings.encryptedKey);
    assert.ok(!JSON.stringify(settings).includes(token));
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('heading', { name: '连接模型' }).waitFor({ state: 'hidden' });
    console.log('2 设置保存，留空时保留原连接凭据');

    await page.getByRole('button', { name: '+ 新建工作区' }).click();
    await page.getByLabel('工作区名称').fill(workspaceName);
    await page.getByRole('button', { name: '创建', exact: true }).click();
    const workspace = join(data, 'workspaces', workspaceName);
    const answers = ['你好！', workspace, '你想让我重点看什么？', '好，先停在这里。'];
    for (let i = 0; i < questions.length; i++) await send(page, questions[i], answers[i]);
    const formatted = page.locator('.bubble.assistant').filter({ hasText: '你想让我重点看什么？' });
    assert.equal(await formatted.getByRole('heading', { name: '先确认' }).count(), 1);
    assert.equal(await formatted.locator('li strong').innerText(), '范围');
    assert.equal(await formatted.locator('li code').innerText(), 'math.js');
    assert.equal(await formatted.locator('img').count(), 0);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((messages) => !messages.some(({ role }) => role === 'tool')));
    assert.deepEqual(await readdir(workspace), []);
    assert.ok(requests[0].some(({ role, content }) => role === 'assistant' && content === '你好！'));
    console.log('3–6 问候、工作区问答、澄清、停止均未运行工具');

    await send(page, task, '已创建 math.js，语法检查通过。');
    assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'), fileText);
    assert.equal(requests.at(-1).at(-1).tool_call_id, 'check_syntax');
    assert.equal(JSON.parse(requests.at(-1).at(-1).content).ok, true);
    console.log('7 实际写入 math.js，语法检查退出成功');

    const opened = await app.evaluate(({ shell }) => {
      const paths = [];
      shell.openPath = async (path) => { paths.push(path); return ''; };
      globalThis.__openedWorkspacePaths = paths;
      return paths;
    });
    assert.deepEqual(opened, []);
    await page.getByRole('button', { name: '打开目录' }).click();
    await page.waitForTimeout(150);
    assert.deepEqual(await app.evaluate(() => globalThis.__openedWorkspacePaths), [workspace]);
    console.log('8 打开目录调用 Windows shell，路径指向含 math.js 的工作区');

    const store = join(data, 'conversations');
    const files = await readdir(store);
    assert.equal(files.length, 1);
    const disk = JSON.parse(await readFile(join(store, files[0]), 'utf8'));
    assert.equal(disk.history.length, 10);
    assert.equal(disk.workspaceName, workspaceName);
    assert.ok(!JSON.stringify(disk).includes(token));
    await app.close();
    app = undefined;

    const { page: reopened } = await launch();
    await reopened.locator('.bubble.assistant').filter({ hasText: '已创建 math.js，语法检查通过。' }).waitFor();
    assert.equal(await reopened.locator('.bubble.user').count(), 5);
    assert.equal(await reopened.locator('#workspace-trigger .workspace-label').textContent(), workspaceName);
    await send(reopened, '接着做什么？', '我们刚刚创建并检查了 math.js。');
    assert.ok(requests.at(-1).some(({ role, content }) => role === 'user' && content === task));
    console.log('重启恢复 10 条消息和工作区，续聊携带持久化上下文');

    const projects = reopened.getByRole('region', { name: '项目', exact: true });
    const project = projects.getByRole('button', { name: workspaceName, exact: true });
    await projects.getByRole('button', { name: '你好', exact: true }).waitFor();
    await project.click();
    await projects.getByRole('button', { name: '你好', exact: true }).waitFor({ state: 'hidden' });
    await project.click();
    await projects.getByRole('button', { name: '你好', exact: true }).waitFor();
    await projects.getByRole('button', { name: `${workspaceName}：新建会话` }).click();
    assert.equal(await reopened.locator('.bubble.user').count(), 0);
    await send(reopened, '接着做什么？', '我们刚刚创建并检查了 math.js。');
    assert.equal(requests.at(-1).filter(({ role }) => role === 'user').length, 1);
    assert.equal((await readdir(store)).length, 2);
    await projects.getByRole('button', { name: '你好', exact: true }).click();
    assert.equal(await reopened.locator('.bubble.user').count(), 6);
    await reopened.getByRole('region', { name: '会话', exact: true }).getByRole('button', { name: '接着做什么？', exact: true }).click();
    assert.equal(await reopened.locator('.bubble.user').count(), 1);
    console.log('侧栏顺序、项目折叠、项目内新建与切换会话通过');

    await app.evaluate(({ dialog }, folders) => {
      dialog.showOpenDialog = async (_window, options) => {
        if (!options.properties.includes('openDirectory')) throw new Error('请选择文件夹');
        return { canceled: false, filePaths: [folders.shift()] };
      };
    }, [existingFolder, outside]);
    await reopened.getByRole('button', { name: '+ 新建工作区' }).click();
    await reopened.getByRole('button', { name: '添加已有文件夹' }).click({ timeout: 3500 });
    await projects.getByRole('button', { name: '现有文件夹', exact: true }).waitFor();
    await reopened.getByRole('button', { name: '多 Agent', exact: true }).click();
    const requestsBeforeRoles = requests.length;
    await reopened.locator('#input').fill(rolesQuestion);
    await reopened.getByRole('button', { name: '开始协作' }).click();
    await reopened.locator('.bubble.assistant').filter({ hasText: '调研 Agent' }).waitFor();
    assert.equal(requests.length, requestsBeforeRoles + 1);
    assert.equal(await reopened.locator('.team-trace').count(), 0);
    assert.deepEqual(await readdir(existingFolder), []);
    console.log('空工作区查询角色，只有模型答复，无协作派发或文件操作');
    for (const question of [...roleHelpQuestions, desktopRoleRequest]) {
      const before = await reopened.locator('.bubble.assistant').count();
      await reopened.locator('#input').fill(question);
      await reopened.getByRole('button', { name: '开始协作' }).click();
      await reopened.locator('.bubble.assistant').nth(before).waitFor({ timeout: 4000 });
      assert.match(await reopened.locator('.bubble.assistant').nth(before).innerText(),
        /^我不能在对话里替你创建 Agent。/);
    }
    await reopened.locator('#input').fill(draftQuestion);
    await reopened.getByRole('button', { name: '开始协作' }).click();
    const draft = reopened.locator('.bubble.assistant').last();
    await draft.filter({ hasText: '名称：桌面操作顾问' }).waitFor({ timeout: 4000 });
    assert.match(await draft.innerText(), /职责：.+建议权限：只读/);
    assert.equal(requests.length, requestsBeforeRoles + 5);
    assert.equal(await reopened.locator('.team-trace').count(), 0);
    assert.deepEqual(await readdir(existingFolder), []);

    await reopened.getByRole('button', { name: '返回对话' }).click();
    await send(reopened, task, '已创建 math.js，语法检查通过。');
    assert.equal(await readFile(join(existingFolder, 'math.js'), 'utf8'), fileText);
    assert.ok(requests.at(-1)[0].content.endsWith(existingFolder));

    await reopened.getByRole('button', { name: '+ 新建工作区' }).click();
    await reopened.getByLabel('工作区名称').fill('指定位置新建');
    await reopened.getByRole('button', { name: '选择位置' }).click();
    await reopened.getByText(outside, { exact: true }).waitFor();
    await reopened.getByRole('button', { name: '创建', exact: true }).click();
    await projects.getByRole('button', { name: '指定位置新建', exact: true }).waitFor();
    await send(reopened, task, '已创建 math.js，语法检查通过。');
    assert.equal(await readFile(join(customFolder, 'math.js'), 'utf8'), fileText);
    assert.ok(requests.at(-1)[0].content.endsWith(customFolder));
    assert.ok(!(await readdir(join(data, 'workspaces'))).includes('指定位置新建'));
    await app.close();
    app = undefined;

    const { page: restored } = await launch();
    await restored.locator('.bubble.assistant').filter({ hasText: '已创建 math.js，语法检查通过。' }).waitFor();
    assert.equal(await restored.locator('#workspace-trigger .workspace-label').textContent(), '指定位置新建');
    await send(restored, '你的工作区在哪里', customFolder);
    console.log('添加已有文件夹、指定位置新建、真实写入与重启恢复通过');

    await assert.rejects(restored.evaluate((path) => window.arrodes.createWorkspace('未选择的位置', path), outside), /请先选择工作区位置/);
    await rename(customFolder, join(outside, '暂时不可用'));
    const callsBefore = requests.length;
    await restored.locator('#input').fill(task);
    await restored.getByRole('button', { name: '发送', exact: true }).click();
    await restored.getByRole('alert').filter({ hasText: '工作区位置不可用' }).waitFor();
    assert.equal(requests.length, callsBefore);
    assert.equal(await restored.locator('#input').inputValue(), task);
    console.log('未选位置被拒绝，原目录失联时保留输入并停止执行');

    await restored.locator('#workspace-trigger').click();
    await restored.locator('#workspace-picker').getByRole('button', { name: /现有文件夹/ }).click();
    await restored.locator('#workspace-trigger .workspace-label').filter({ hasText: '现有文件夹' }).waitFor();
    await restored.getByRole('button', { name: '多 Agent', exact: true }).click();
    await restored.locator('#input').fill(teamGoal);
    await restored.getByRole('button', { name: '开始协作' }).click();
    await restored.locator('.bubble.assistant').filter({ hasText: '团队已交付 team.js，验收通过。' }).waitFor();
    assert.equal(await readFile(join(existingFolder, 'team.js'), 'utf8'), fileText);
    await restored.getByText('协作过程', { exact: true }).click();
    await restored.getByText(/请求协助/).waitFor();
    await restored.getByText(/继续执行/).waitFor();
    await restored.getByText(/交接/).first().waitFor();
    await restored.getByText(/team\.js.*语法检查通过/).waitFor();
    assert.ok(requests.some((messages) => messages[0].content.startsWith('协作阶段：验收')));
    console.log('多 Agent 规划、分工、交接、协助续跑、真实写入和验收通过');

    await restored.locator('#input').fill(brokenTeamGoal);
    await restored.getByRole('button', { name: '开始协作' }).click();
    await restored.locator('.bubble.assistant').filter({ hasText: '本次协作未通过验收。文件检查失败：broken.js。' }).waitFor();
    assert.equal(await readFile(join(existingFolder, 'broken.js'), 'utf8'), 'function broken(');
    assert.equal(requests.at(-1)[0].content.split('\n')[0], '协作阶段：验收');
    console.log('实际语法检查失败时拒绝验收');

    await restored.getByRole('button', { name: '可用角色' }).click();
    const restoredRoster = restored.getByRole('dialog', { name: '可用角色' });
    await restoredRoster.getByText(customRoleName, { exact: true }).waitFor();
    await restoredRoster.getByRole('button', { name: '关闭', exact: true }).click();
    await restored.locator('#input').fill(customRoleGoal);
    await restored.getByRole('button', { name: '开始协作' }).click();
    await restored.locator('.bubble.assistant').filter({ hasText: '引用核对员已完成，验收通过。' }).waitFor();
    await restored.locator('#input').fill(forbiddenRoleGoal);
    await restored.getByRole('button', { name: '开始协作' }).click();
    await restored.locator('.bubble.assistant').filter({ hasText: /本次协作未通过验收。.*失败.*write_file/s }).waitFor();
    assert.ok(!(await readdir(existingFolder)).includes('越权.txt'));
    console.log('自定义角色创建、重启恢复、按职责派发和只读权限通过');

    const canvas = restored.getByRole('region', { name: '协作画布' });
    const skillFiles = [
      ['prepare', prepareSkill], ['implement', implementSkill],
    ];
    const paths = await Promise.all(skillFiles.map(async ([name, instructions]) => {
      const directory = join(outside, name);
      await mkdir(directory);
      const path = join(directory, 'SKILL.md');
      await writeFile(path, `---\nname: ${name}-skill\ndescription: Fixture for ${name}\n---\n\n${instructions}\n`, 'utf8');
      return path;
    }));
    await app.evaluate(({ dialog, net }, { files, markdown }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.shift()] });
      const original = net.fetch.bind(net);
      net.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.hostname !== 'api.github.com') return original(input, options);
        if (options?.redirect !== 'error') throw new Error('GitHub requests must reject redirects');
        if (url.pathname === '/repos/example/skills/contents/SKILL.md') return new Response(null, { status: 404 });
        if (url.pathname === '/repos/example/skills/git/trees/HEAD' && url.searchParams.get('recursive') === '1') {
          return Response.json({ truncated: false, tree: [
            { type: 'blob', mode: '100644', path: 'prepare/SKILL.md' },
            { type: 'blob', mode: '100644', path: 'other/SKILL.md' },
          ] });
        }
        if (url.pathname === '/repos/example/skills/contents/prepare/SKILL.md' && url.searchParams.get('ref') === 'HEAD') {
          const bytes = Buffer.from(markdown);
          return Response.json({ type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
        }
        return new Response(null, { status: 404 });
      };
    }, { files: [paths[1]], markdown: await readFile(paths[0], 'utf8') });
    await canvas.getByRole('button', { name: '新建 Agent' }).click();
    const creator = restored.getByRole('dialog', { name: '新建角色' });
    await creator.getByLabel('角色名称').fill('资料搭档');
    await creator.getByLabel('职责').fill('为执行 Agent 准备任务资料。');
    await creator.getByText('Skill（可选）', { exact: true }).click({ timeout: 3000 });
    await creator.getByLabel(/适用场景/).fill('准备资料，材料整理');
    await creator.getByRole('textbox', { name: 'GitHub 地址' }).fill('https://github.com/example/skills');
    await creator.getByRole('button', { name: '导入 GitHub' }).click();
    await creator.getByLabel('选择 Skill').selectOption({ label: 'prepare/SKILL.md' });
    await creator.getByRole('button', { name: '导入所选 Skill' }).click();
    await creator.getByRole('checkbox', { name: /prepare-skill/ }).waitFor();
    assert.equal(await creator.getByRole('checkbox', { name: /prepare-skill/ }).isChecked(), true);
    await creator.getByRole('button', { name: '保存', exact: true }).click();
    const sourceRole = canvas.getByRole('button', { name: '添加资料搭档' });
    const stage = canvas.locator('.canvas-stage');
    await sourceRole.dragTo(stage, { targetPosition: { x: 69, y: 190 } });
    const move = canvas.getByRole('button', { name: '移动资料搭档' });
    const box = await move.boundingBox();
    const initial = await move.evaluate((node) => node.closest('[data-agent]').style.left);
    await restored.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await restored.mouse.down();
    await restored.mouse.move(box.x + box.width / 2 + 34, box.y + box.height / 2 - 22, { steps: 4 });
    await restored.mouse.up();
    const moved = await move.evaluate((node) => node.closest('[data-agent]').style.left);
    assert.notEqual(moved, initial);
    await canvas.getByRole('button', { name: '从资料搭档连线' }).click();
    await canvas.getByRole('button', { name: '连接到执行 Agent' }).click();
    await canvas.getByRole('button', { name: '删除连线：资料搭档 → 执行 Agent' }).waitFor();
    await canvas.getByRole('button', { name: '从执行 Agent连线' }).click();
    await canvas.getByRole('button', { name: '连接到资料搭档' }).click();
    await canvas.getByRole('alert').filter({ hasText: '环' }).waitFor();
    assert.equal(await canvas.getByRole('button', { name: /删除连线/ }).count(), 1);

    const from = await canvas.getByRole('button', { name: '从协调者连线' }).boundingBox();
    const to = await canvas.getByRole('button', { name: '连接到资料搭档' }).boundingBox();
    await restored.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await restored.mouse.down();
    await restored.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await restored.mouse.up();
    await canvas.getByRole('button', { name: '删除连线：协调者 → 资料搭档' }).waitFor();
    await canvas.getByRole('button', { name: '从执行 Agent连线' }).click();
    await canvas.getByRole('button', { name: '连接到验收 Agent' }).click();
    await canvas.getByRole('button', { name: '删除连线：执行 Agent → 验收 Agent' }).waitFor();

    await canvas.getByRole('button', { name: '配置执行 Agent 的 Skill', exact: true }).click();
    const editor = restored.getByRole('dialog', { name: '执行 Agent · Skill' });
    await editor.getByRole('button', { name: '导入 SKILL.md' }).click();
    await editor.getByRole('checkbox', { name: /implement-skill/ }).check();
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });

    await restored.getByRole('button', { name: '设置', exact: true }).click();
    await restored.getByRole('button', { name: 'MCP 服务器', exact: true }).click();
    const mcpSettings = restored.getByRole('dialog').filter({ hasText: 'MCP 服务器' });
    await mcpSettings.getByLabel('服务器名称').fill('退款服务');
    await mcpSettings.getByLabel('可执行程序').fill(process.execPath);
    await mcpSettings.getByLabel(/启动参数/).fill(JSON.stringify([join(__dirname, 'mcp-fixture.mjs')]));
    await mcpSettings.getByRole('button', { name: '测试并保存连接' }).click();
    await mcpSettings.getByText(/audit_total/).waitFor();
    await mcpSettings.getByRole('button', { name: '关闭', exact: true }).click();
    await restored.getByRole('button', { name: '可用角色' }).click();
    const roles = restored.getByRole('dialog', { name: '可用角色' });
    await roles.getByRole('definition').filter({ hasText: '在工作区读写文件，并检查 JavaScript 语法。' })
      .getByRole('button', { name: '配置 MCP 工具' }).click();
    const grants = restored.getByRole('dialog').filter({ hasText: '执行 Agent的 MCP 工具' }).last();
    await grants.getByRole('checkbox', { name: /audit_total/ }).check();
    await grants.getByRole('button', { name: '保存权限' }).click();
    await grants.waitFor({ state: 'hidden' });
    await roles.getByRole('button', { name: '关闭', exact: true }).click();

    await restored.evaluate(() => {
      window.flights = [];
      new MutationObserver((changes) => {
        for (const change of changes) for (const node of change.addedNodes) {
          if (node instanceof Element && node.matches('[data-flight]')) {
            window.flights.push([node.getAttribute('data-from'), node.getAttribute('data-to')]);
          }
        }
      }).observe(document.getElementById('root'), { childList: true, subtree: true });
    });
    await restored.locator('#input').fill(canvasGoal);
    await restored.getByRole('button', { name: '开始协作' }).click();
    const mcpApproval = restored.getByRole('dialog', { name: '调用 MCP 工具' });
    await mcpApproval.getByText(/退款服务 \/ audit_total/).waitFor();
    await mcpApproval.getByRole('button', { name: '允许本次' }).click();
    await restored.locator('.bubble.assistant').filter({ hasText: '画布协作完成。' }).waitFor();
    const trace = restored.locator('.team-trace').last();
    await trace.getByText('协作过程', { exact: true }).click();
    await trace.getByText('425.76', { exact: true }).waitFor();
    const sourceId = await move.evaluate((node) => node.closest('[data-agent]').dataset.agent);
    const flights = await restored.evaluate(() => window.flights);
    assert.equal(flights.filter(([from, to]) => from === sourceId && to === 'execute').length, 1);
    assert.equal(flights.filter(([from, to]) => from === 'coordinator' && to === sourceId).length, 1);
    assert.equal(await readFile(join(existingFolder, 'canvas.js'), 'utf8'), 'module.exports = () => 42;\n');
    await canvas.getByRole('button', { name: '执行 Agent → 验收 Agent', exact: true }).click();
    const transfer = restored.getByRole('dialog', { name: '执行 Agent → 验收 Agent' });
    await transfer.getByRole('button', { name: '打开 canvas.js' }).click();
    await transfer.getByText('module.exports = () => 42;', { exact: true }).waitFor();
    assert.equal(await transfer.getByText('画布交接：函数应返回 42。', { exact: true }).count(), 0);
    const outsidePreview = await restored.evaluate(() =>
      window.arrodes.getConversation().then(({ workspaceId }) =>
        window.arrodes.canvasArtifact(workspaceId, '../canvas.js')));
    assert.equal(outsidePreview.ok, false);
    await transfer.getByRole('button', { name: '关闭', exact: true }).click();
    if (process.env.ARRODES_CANVAS_SCREENSHOT) await restored.screenshot({ path: process.env.ARRODES_CANVAS_SCREENSHOT });

    await app.close();
    app = undefined;
    const { page: replay } = await launch();
    await replay.getByRole('button', { name: '多 Agent', exact: true }).click();
    const replayCanvas = replay.getByRole('region', { name: '协作画布' });
    await replayCanvas.getByRole('button', { name: '删除连线：资料搭档 → 执行 Agent' }).waitFor();
    const replayPosition = await replayCanvas.getByRole('button', { name: '移动资料搭档' })
      .evaluate((node) => node.closest('[data-agent]').style.left);
    assert.equal(replayPosition, moved);
    await replayCanvas.getByRole('button', { name: '执行 Agent → 验收 Agent', exact: true }).waitFor();
    assert.equal(await replayCanvas.locator('[data-flight]').count(), 0);
    await replayCanvas.getByRole('button', { name: '配置资料搭档 的 Skill' }).click();
    const replaySkills = replay.getByRole('dialog', { name: '资料搭档 · Skill' });
    assert.equal(await replaySkills.getByRole('checkbox', { name: /prepare-skill/ }).isChecked(), true);
    assert.equal(await replaySkills.getByRole('checkbox', { name: /implement-skill/ }).isChecked(), false);
    const savedTrace = await replay.evaluate(async () => JSON.stringify(await window.arrodes.getConversation()));
    assert.ok(savedTrace.includes('prepare-skill') && savedTrace.includes('implement-skill'));
    assert.ok(savedTrace.includes('mcp.result') && savedTrace.includes('425.76'));
    assert.ok(!savedTrace.includes('PREPARE_SKILL_ONLY') && !savedTrace.includes('IMPLEMENT_SKILL_ONLY'));
    await replaySkills.getByRole('button', { name: '取消', exact: true }).click();
    const current = await replay.evaluate(() => window.arrodes.getConversation());
    await replay.locator(`[id="recent-${current.id}"]`).locator('..').hover();
    await replay.locator(`[id="recent-${current.id}"]`).locator('..')
      .getByRole('button', { name: /^归档会话/ }).click();
    await replay.getByText('此会话已归档').waitFor();
    assert.equal(await replay.locator('#input').count(), 0);
    assert.equal(await replay.locator(`[id="recent-${current.id}"]`).count(), 0);
    await app.close();
    app = undefined;
    const { page: archivePage } = await launch();
    await archivePage.getByText('已归档会话', { exact: true }).click();
    await archivePage.locator(`[id="archived-${current.id}"]`).click();
    await archivePage.getByText('画布协作完成。', { exact: false }).last().waitFor();
    await archivePage.getByRole('button', { name: '恢复会话', exact: true }).click();
    await archivePage.locator('#input').waitFor();
    await archivePage.locator(`[id="recent-${current.id}"]`).waitFor();
    await send(archivePage, spreadsheetTask, '已生成 report.xlsx。');
    const path = await archivePage.evaluate(() => window.arrodes.getConversation().then(({ workspaceId }) =>
      window.arrodes.listWorkspaces().then((items) => items.find(({ id }) => id === workspaceId)?.path)));
    assert.equal((await readFile(join(path, 'report.xlsx'))).subarray(0, 2).toString(), 'PK');
    if (process.env.ARRODES_LIVE_SEARCH === '1') {
      await send(archivePage, searchTask, '找到 unjs/unpdf。');
      console.log('Electron 实际调用 GitHub 搜索并把结果回传模型');
    }
    await app.evaluate(({ shell }) => {
      globalThis.__desktopLaunches = [];
      shell.openExternal = async (url) => { globalThis.__desktopLaunches.push(url); };
    });
    const confirmation = archivePage.getByRole('dialog', { name: '打开 Windows 应用' });
    const browserRun = send(archivePage, browserTask, '已请求打开浏览器。');
    await confirmation.getByText('默认浏览器', { exact: false }).waitFor();
    await confirmation.getByRole('button', { name: '允许本次' }).click();
    await browserRun;
    assert.deepEqual(await app.evaluate(() => globalThis.__desktopLaunches), ['https://www.bing.com/']);
    const shellRun = send(archivePage, powershellTask, '已读取 PowerShell 版本。');
    const approval = archivePage.getByRole('dialog', { name: '运行 PowerShell' });
    await approval.getByText('工作目录', { exact: true }).waitFor();
    assert.match(await approval.locator('pre').textContent(), /Write-Output/);
    if (process.env.ARRODES_APPROVAL_SCREENSHOT) await approval.screenshot({ path: process.env.ARRODES_APPROVAL_SCREENSHOT });
    await approval.getByRole('button', { name: '运行脚本' }).click();
    await shellRun;
    const executionHistory = archivePage.locator('details').filter({ has: archivePage.getByText('执行记录（1 条）', { exact: true }) }).last();
    await executionHistory.getByText('执行记录（1 条）', { exact: true }).waitFor();
    assert.equal(await executionHistory.evaluate((node) => node.open), false);
    await executionHistory.getByText('执行记录（1 条）', { exact: true }).click();
    const card = archivePage.getByRole('region', { name: 'PowerShell 执行结果' }).last();
    assert.match(await card.textContent(), /执行成功 · 退出码 0/);
    assert.match(await card.locator('pre').textContent(), /PowerShell [0-9]+\.[0-9]+/);
    if (process.env.ARRODES_RESULT_SCREENSHOT) await card.screenshot({ path: process.env.ARRODES_RESULT_SCREENSHOT });
    const chooseApproval = async (current, next) => {
      await archivePage.getByLabel(`批准权限：${current}`, { exact: true }).click();
      await archivePage.locator('#approval-picker').getByRole('button', { name: new RegExp(next) }).click();
    };
    await chooseApproval('请求批准', '帮我批准');
    await send(archivePage, browserTask, '已请求打开浏览器。');
    assert.equal(await confirmation.count(), 0);
    const reviewedShell = send(archivePage, powershellTask, '已读取 PowerShell 版本。');
    await approval.getByRole('button', { name: '运行脚本' }).click();
    await reviewedShell;
    await chooseApproval('帮我批准', '完全访问权限');
    await send(archivePage, powershellTask, '已读取 PowerShell 版本。');
    assert.equal(await approval.count(), 0);
    await archivePage.getByText('执行记录（1 条）', { exact: true }).nth(2).waitFor();
    await chooseApproval('完全访问权限', '请求批准');
    const creatorToggle = archivePage.getByRole('button', { name: '创造模式', exact: true });
    await creatorToggle.click();
    await archivePage.locator('#input').fill('修改 Arrodes');
    await archivePage.getByRole('button', { name: '发送', exact: true }).click();
    await archivePage.getByRole('alert').filter({ hasText: '独立的 Arrodes Git 源码副本' }).waitFor();
    await archivePage.getByRole('button', { name: '创造模式已开启', exact: true }).click();
    await archivePage.getByRole('button', { name: '新建会话', exact: true }).click();
    await archivePage.getByRole('heading', { name: '今天想做什么？' }).waitFor();
    const originId = await archivePage.evaluate(async () => (await window.arrodes.getConversation()).id);
    await archivePage.locator('#input').fill(backgroundTask);
    await archivePage.getByRole('button', { name: '发送', exact: true }).click();
    await archivePage.getByRole('button', { name: '执行中…', exact: true }).waitFor();
    await archivePage.getByRole('button', { name: '新建会话', exact: true }).click();
    await archivePage.getByRole('button', { name: '另一会话执行中', exact: true }).waitFor();
    const currentId = await archivePage.evaluate(async () => (await window.arrodes.getConversation()).id);
    assert.notEqual(currentId, originId);
    await archivePage.locator('#input').fill('保留另一会话输入');
    finishBackground();
    await archivePage.getByRole('button', { name: '发送', exact: true }).waitFor();
    assert.equal(await archivePage.locator('#input').inputValue(), '保留另一会话输入');
    assert.equal(await archivePage.getByText('后台任务已完成。', { exact: true }).count(), 0);
    await archivePage.locator(`[id="recent-${originId}"]`).click();
    await archivePage.getByText('后台任务已完成。', { exact: true }).waitFor();
    assert.equal(await archivePage.locator('.bubble.user').filter({ hasText: backgroundTask }).count(), 1);
    await send(archivePage, clarifyTask, '你希望怎么交付？');
    const pending = archivePage.getByRole('region', { name: '待确认任务' });
    await pending.getByRole('button', { name: clarifyOption }).waitFor();
    await app.close();
    app = undefined;
    const { page: resumed } = await launch();
    await resumed.getByRole('button', { name: '多 Agent', exact: true }).click();
    const requestsBeforeGreeting = requests.length;
    await resumed.locator('#input').fill('你好');
    await resumed.getByRole('button', { name: '开始协作' }).click();
    await resumed.getByText('你好！', { exact: true }).waitFor();
    assert.equal(requests.length, requestsBeforeGreeting);
    assert.equal(await resumed.locator('.team-trace').count(), 0);
    await resumed.getByRole('button', { name: '返回对话', exact: true }).click();
    await resumed.getByRole('region', { name: '待确认任务' }).getByRole('button', { name: clarifyOption }).click();
    await resumed.getByText('已写入确认后的订单分析。', { exact: true }).waitFor();
    assert.equal(await resumed.getByRole('region', { name: '待确认任务' }).count(), 0);
    assert.equal(await readFile(join(path, clarifyFile), 'utf8'), '已交叉核对订单和退款。');
    console.log('新确认界面、PowerShell 结果卡和创造模式工作区校验通过');
    console.log('内置 Skill 已注入，Electron 主进程生成真实 XLSX');
    console.log('会话归档、历史保留、重启及恢复通过');
    console.log('画布连接、角色 Skill 注入与隔离、真实交接、文件和重启恢复通过');
  } finally {
    finishBackground();
    if (app) await app.close();
    await new Promise((done) => server.close(done));
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
    await rm(outside, { recursive: true, force: true, maxRetries: 5 });
  }
});
