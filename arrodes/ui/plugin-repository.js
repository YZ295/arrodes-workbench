function pluginRepository() {
  const app = window.arrodes;
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

  const skillStatus = el("p", { class: "hint", role: "status" });
  const install = control("导入接续项目", async () => {
    const result = await action(install, skillStatus, "正在导入…",
      () => app.importProjectResume(), "已导入，可在角色的 Skill 设置中启用。");
    if (result?.ok) teamCanvas.refreshSkills(result.skills);
  });
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
  void reload();
  return el("div", { class: "repository" },
    el("section", { "aria-labelledby": "connection-plugins-heading" },
      el("h2", { id: "connection-plugins-heading" }, "连接插件"),
      control("重新检测", reload), feedback, list),
    el("section", { "aria-labelledby": "repository-skills-heading" },
      el("h2", { id: "repository-skills-heading" }, "技能"),
      el("div", { class: "repository-list" },
        el("article", { class: "repository-entry" }, el("h3", {}, "接续项目"),
          el("p", { class: "hint" }, "读取工作区进度记录，找出阻塞和下一步。"),
          el("div", { class: "repository-actions" }, install), skillStatus),
        el("article", { class: "repository-entry" }, el("h3", {}, "GitHub 技能"),
          field("GitHub 地址", url), choices, el("div", { class: "repository-actions" }, importGithub), githubStatus))));
}
