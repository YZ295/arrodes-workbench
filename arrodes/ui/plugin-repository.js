function pluginRepository() {
  const app = window.arrodes;
  const marketStatus = el("p", { class: "hint", role: "status" });
  const grid = el("div", { class: "market-grid" });
  const search = el("input", { type: "search", "aria-label": "搜索插件", placeholder: "搜索插件、作者或用途" });
  const filters = el("div", { class: "repository-actions", "aria-label": "按分类筛选" });
  const content = el("div");
  let market;
  let syncing = false;
  let page = "发现";
  let category = "全部";
  const list = el("div", { class: "repository-list" });
  const feedback = el("p", { class: "hint", role: "status" }, "正在检测本机 Agent…");

  async function refresh() {
    const [plugins, canvas] = await Promise.all([app.getTeamExecutors(), state.ready ? app.getCanvas(state.workspace) : null]);
    const graph = canvas?.graph;
    const bound = new Set(Object.values(graph?.roleExecutors ?? {}));
    if (graph?.coordinatorExecutor) bound.add(graph.coordinatorExecutor);
    teamCanvas.refreshExecutors(plugins);
    list.replaceChildren(...plugins.filter(({ id }) => id !== "builtin").map((plugin) => connection(plugin, bound.has(plugin.id))));
  }

  async function action(button, status, pending, run, success) {
    const scope = button.closest("article");
    const controls = [...scope.querySelectorAll("button, input, select")].filter((control) => !control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    status.textContent = pending;
    try {
      const result = await run();
      status.textContent = result.ok ? success : result.error;
      return result;
    } catch {
      status.textContent = "操作未完成，请重试。";
    } finally {
      controls.forEach((control) => { control.disabled = false; });
    }
  }

  function connection(plugin, bound) {
    const { id, name, enabled, detected, verifiedAt, executable, detectedPath } = plugin;
    const status = el("p", { class: "hint", role: "status" },
      [enabled ? "已启用" : "未启用", detected ? "已检测到" : "未检测到",
        verifiedAt ? "连接已验证" : "连接未验证", ...(bound ? ["当前工作区已绑定"] : [])].join(" · "));
    const resultMessage = el("p", { class: "hint", role: "status" });
    const path = id === "codex" ? el("input", { type: "text", value: executable, placeholder: "留空使用自动检测" }) : null;
    const toggle = control(enabled ? "停用" : "启用", async () => {
      const result = await action(toggle, resultMessage, "正在保存…",
        () => app.saveConnectionPlugin(id, { enabled: !enabled, executable }), "已保存。");
      if (result?.ok) await reload();
    });
    const test = control("测试连接", async () => {
      const result = await action(test, resultMessage, "正在等待 Agent 回复…", () => app.testConnectionPlugin(id), "连接通过。");
      if (result?.ok) await reload();
      else if (result) status.textContent = "已启用 · 已检测到 · 连接未验证";
    });
    test.disabled = !detected;
    const save = control("保存路径", async () => {
      const result = await action(save, resultMessage, "正在保存…",
        () => app.saveConnectionPlugin(id, { enabled, executable: path.value.trim() }), "已保存。");
      if (result?.ok) await reload();
    });
    const bind = control("绑定角色", () => {
      state.view = "collaboration";
      render();
      void openTeamRoles();
    });
    bind.disabled = !verifiedAt;
    return el("article", { class: "repository-entry", "aria-label": name },
      el("h3", {}, name), status, el("p", { class: "hint" }, plugin.detail),
      ...(path ? [field("Codex CLI 路径", path), ...(detectedPath ? [el("p", { class: "hint" }, detectedPath)] : [])] : []),
      el("div", { class: "repository-actions" }, toggle, ...(path ? [save] : []), ...(enabled ? [test, bind] : [])),
      resultMessage);
  }

  function control(label, onclick) {
    return el("button", { type: "button", class: "tool", onclick }, label);
  }

  async function reload() {
    try {
      await refresh();
      feedback.textContent = "";
    } catch {
      feedback.textContent = "无法读取连接插件，请重新检测。";
    }
  }

  const url = el("input", { type: "url", placeholder: "公开 GitHub 仓库或 SKILL.md 地址" });
  const choices = el("div");
  const githubStatus = el("p", { class: "hint", role: "status" });
  const importGithub = control("导入 GitHub 技能", async () => {
    const link = choices.querySelector("select")?.value || url.value.trim();
    if (!link) { githubStatus.textContent = "请输入 GitHub 地址。"; return; }
    const result = await action(importGithub, githubStatus, "正在读取 GitHub…",
      () => app.importGithubSkill(link), "已导入，可在角色的 Skill 设置中启用。");
    if (result?.choices) {
      const select = el("select", { "aria-label": "选择要导入的技能" }, ...result.choices.map(({ path, url }) =>
        el("option", { value: url }, path)));
      choices.replaceChildren(select);
      githubStatus.textContent = "请选择目录中的技能，再点击导入。";
      select.focus();
    } else if (result?.ok) {
      choices.replaceChildren();
      teamCanvas.refreshSkills(result.skills);
    }
  });
  url.oninput = () => choices.replaceChildren();

  function update(next) {
    market = next;
    applyMarketTheme(next.theme);
    drawEntries();
  }

  function marketCard(entry) {
    const installed = Object.hasOwn(market.installed, entry.id);
    const isTheme = entry.kind === "theme";
    const status = el("p", { class: "hint", role: "status" });
    const install = control("安装", async () => {
      const result = await action(install, status, "正在安装…",
        () => app.installMarketPlugin(entry.id), "已安装。");
      if (result?.ok) {
        teamCanvas.refreshSkills(result.skills);
        update(result.market);
      }
    });
    const active = market.theme === entry.id;
    const apply = control(active ? "恢复默认主题" : "应用", async () => {
      const result = await action(apply, status, "正在切换…", () => app.setMarketTheme(active ? null : entry.id), "主题已切换。");
      if (result?.ok) update(result.market);
    });
    return el("article", { class: "market-card", "aria-label": entry.name },
      el("div", { class: "market-card-heading" }, el("h3", {}, entry.name),
        installed ? el("span", { class: "market-installed" }, "已安装") : install),
      el("p", { class: "hint" }, `${entry.author} · v${entry.version}`),
      el("p", {}, entry.description),
      el("div", { class: "market-card-footer" },
        el("span", { class: "hint" }, `${isTheme ? "主题" : "Skill"} · ${entry.category}`),
        ...(installed && isTheme ? [apply] : [])),
      status);
  }

  function drawEntries() {
    if (!market) return;
    const options = [...new Set(["全部", "技能", ...market.catalog.map(({ category }) => category)])];
    const categoryButtons = options.map((name) => {
      const button = control(name, () => { category = name; drawEntries(); filters.querySelector("[aria-pressed=true]")?.focus(); });
      button.setAttribute("aria-pressed", String(name === category));
      return button;
    });
    filters.replaceChildren(...categoryButtons);
    const query = search.value.trim().toLocaleLowerCase();
    const entries = (page === "已安装" ? Object.values(market.installed) : market.catalog).filter((entry) =>
      (page === "已安装" || category === "全部" || category === entry.category || category === "技能" && entry.kind === "skill") &&
      [entry.name, entry.description, entry.author, entry.category].some((value) => value.toLocaleLowerCase().includes(query)));
    grid.replaceChildren(...(entries.length ? entries.map(marketCard) : [
      el("p", { class: "hint" }, query || page === "发现" ? "没有匹配的插件。" : "还未安装插件，可从「发现」页添加。"),
    ]));
    marketStatus.textContent = page === "发现" ? syncing ? "正在更新社区目录…" : market.source : "";
  }
  search.oninput = drawEntries;

  const importPanel = el("details", { class: "market-import" }, el("summary", {}, "从 GitHub 地址导入"),
    el("article", { class: "repository-entry" }, field("GitHub 地址", url), choices,
      el("div", { class: "repository-actions" }, importGithub), githubStatus));
  const presetPanel = el("section", { "aria-labelledby": "connection-plugins-heading" },
    el("h2", { id: "connection-plugins-heading" }, "连接插件"), control("重新检测", reload), feedback, list);

  const tabs = el("div", { class: "market-tabs", "aria-label": "插件市场视图" });
  const views = ["发现", "已安装", "Agent 预设"].map((name) => {
    const button = control(name, () => {
      page = name;
      for (const tab of tabs.children) tab.setAttribute("aria-pressed", String(tab === button));
      if (page === "Agent 预设") {
        content.replaceChildren(presetPanel);
        void reload();
      } else {
        content.replaceChildren(search, ...(page === "发现" ? [filters, marketStatus] : []),
          grid, ...(page === "发现" ? [importPanel] : []));
        drawEntries();
      }
    });
    return button;
  });
  tabs.append(...views);
  views[0].click();
  marketStatus.textContent = "正在读取插件目录…";
  void app.getMarketplace(false).then(update).then(async () => {
    syncing = true;
    drawEntries();
    const next = await app.getMarketplace(true);
    syncing = false;
    update({ ...market, catalog: next.catalog, source: next.source });
  }).catch(() => { marketStatus.textContent = "无法读取插件目录，请重新打开插件市场。"; });
  return el("div", { class: "repository" }, tabs, content);
}

function applyMarketTheme(theme) {
  if (theme) document.documentElement.dataset.marketTheme = theme;
  else delete document.documentElement.dataset.marketTheme;
}
