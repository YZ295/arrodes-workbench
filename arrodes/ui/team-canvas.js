function createTeamCanvas(updateSendButton) {
  const starter = {
    nodes: [
      { id: "coordinator", x: .03, y: .42 },
      { id: "research", x: .49, y: .12 },
      { id: "execute", x: .49, y: .71 },
      { id: "reviewer", x: .97, y: .42 },
    ],
    edges: [],
  };
  const ns = "http://www.w3.org/2000/svg";
  function svg(tag, attributes) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  const button = (text, action, label = text, attrs = {}) =>
    el("button", { type: "button", class: "tool", "aria-label": label, onclick: action, ...attrs }, text);
  const palette = el("div", { class: "canvas-palette" });
  const error = el("p", { class: "error-text canvas-error", role: "alert" });
  const mode = el("span", { class: "canvas-mode", role: "status" });
  const info = el("div", { class: "canvas-info" });
  const transfers = el("div", { class: "canvas-transfers", "aria-label": "交接记录" });
  const nodes = el("div", { class: "canvas-nodes" });
  const edges = svg("g", {});
  const planes = svg("g", {});
  const graphics = svg("svg", { class: "canvas-links", "aria-hidden": "true" });
  const defs = svg("defs", {});
  const arrow = svg("marker", {
    id: "canvas-arrow", markerWidth: 6, markerHeight: 6, refX: 5, refY: 3, orient: "auto",
  });
  arrow.append(svg("path", { d: "M0 0L6 3 0 6Z", fill: "context-stroke" }));
  defs.append(arrow);
  graphics.append(defs, edges, planes);
  const stage = el("div", { class: "canvas-stage" }, graphics, nodes);
  stage.onclick = (event) => {
    if (pendingFrom && !event.target.closest(".canvas-node")) { pendingFrom = undefined; draw(); }
  };
  const create = button("＋ 新建 Agent", () => openTeamRoles(true), "新建 Agent");
  const root = el("section", { class: "team-canvas", "aria-label": "协作画布" },
    el("header", { class: "canvas-header" }, el("h2", {}, "协作画布"), mode, create),
    el("div", { class: "canvas-body" }, palette, stage), error, info, transfers,
  );

  let workspaceId;
  let conversationId;
  let saved = null;
  let roles = [];
  let skills = [];
  let loading = false;
  let saving = false;
  let busy = false;
  let pendingFrom;
  let selectedTransfer;
  let status = new Map();
  let planned = new Map();
  let handoffs = [];
  let helping = new Set();
  const positions = () => (saved ?? starter).nodes;
  const roleExecutors = () => saved?.roleExecutors ?? (saved?.coordinatorExecutor ? { coordinator: saved.coordinatorExecutor } : {});
  const executorFor = (role) => roleExecutors()[role.id] ?? role.executor ?? "builtin";
  const name = (id) => roles.find((role) => role.id === id)?.name ?? id;
  const editable = () => !busy && !loading && !saving;

  function visibleNodes() {
    const result = [...positions()];
    const used = new Set(result.map(({ id }) => id));
    for (const { roleId } of status.values()) {
      if (!roleId || used.has(roleId)) continue;
      used.add(roleId);
      result.push({ id: roleId, x: .22 + (result.length % 4) * .16, y: .96, temporary: true });
    }
    return result;
  }

  function place(node, point) {
    node.style.left = `calc(10px + ${point.x * 100}% - ${point.x} * (var(--agent-width) + 20px))`;
    node.style.top = `calc(${point.y * 100}% - ${point.y} * var(--agent-height))`;
  }

  function pathBetween(from, to) {
    const first = nodes.querySelector(`[data-agent="${CSS.escape(from)}"]`);
    const last = nodes.querySelector(`[data-agent="${CSS.escape(to)}"]`);
    if (!first || !last) return;
    if (first === last) {
      const x = first.offsetLeft + first.offsetWidth / 2;
      const y = first.offsetTop + first.offsetHeight;
      return `M${x - 15},${y} C${x - 45},${y + 28} ${x + 45},${y + 28} ${x + 15},${y}`;
    }
    const assist = to === "coordinator";
    const x = first.offsetLeft + (assist ? 0 : first.offsetWidth);
    const a = first.offsetTop + first.offsetHeight / 2;
    const z = last.offsetLeft + (assist ? last.offsetWidth : 0);
    const b = last.offsetTop + last.offsetHeight / 2;
    return connectionPath(x, a, z, b, assist ? -1 : 1);
  }

  function connectionPath(x, y, endX, endY, direction = 1) {
    const bend = Math.max(24, Math.abs(endX - x) * .48) * direction;
    return `M${x},${y} C${x + bend},${y} ${endX - bend},${endY} ${endX},${endY}`;
  }

  function drawEdges() {
    if (!stage.isConnected) return;
    const links = new Map();
    const add = (from, to, kind) => {
      if (from && to) links.set(JSON.stringify([from, to]), { from, to, kind });
    };
    for (const task of planned.values()) {
      if (!task.dependsOn.length) add("coordinator", task.roleId, "planned");
      for (const parent of task.dependsOn) add(planned.get(parent)?.roleId, task.roleId, "planned");
    }
    for (const { from, to } of saved?.edges ?? []) add(from, to, "configured");
    for (const from of helping) add(from, "coordinator", "assist");
    for (const { from, to } of handoffs) add(from, to, "delivered");
    if (selectedTransfer) add(selectedTransfer.from, selectedTransfer.to, "selected");
    edges.replaceChildren(...Array.from(links.values(), ({ from, to, kind }) => {
      const path = pathBetween(from, to);
      return path && svg("path", { d: path, class: `canvas-link ${kind}`, "marker-end": "url(#canvas-arrow)" });
    }).filter(Boolean));
  }
  new ResizeObserver(drawEdges).observe(stage);

  async function save(graph) {
    if (!editable()) return;
    const id = workspaceId;
    saving = true;
    updateSendButton();
    error.textContent = "";
    try {
      const result = await window.arrodes.saveCanvas(id, {
        roleExecutors: roleExecutors(), roleSettings: saved?.roleSettings ?? {}, ...graph,
      });
      if (id !== workspaceId) return false;
      if (!result.ok) { error.textContent = result.error; return false; }
      saved = result.graph;
      pendingFrom = undefined;
      return true;
    } catch {
      if (id === workspaceId) error.textContent = "无法保存画布，请重试。";
      return false;
    } finally {
      if (id === workspaceId) { saving = false; draw(); updateSendButton(); }
    }
  }

  const clamp = (value) => Math.max(0, Math.min(1, value));
  function addRole(id, clientX, clientY) {
    const current = positions();
    const role = roles.find((entry) => entry.id === id);
    if (!editable() || current.some((node) => node.id === id) || !role?.access) return;
    const rect = stage.getBoundingClientRect();
    const sample = nodes.firstElementChild;
    const width = sample?.offsetWidth ?? 120;
    const height = sample?.offsetHeight ?? 56;
    const x = clientX === undefined ? .13 + (current.length % 4) * .18
      : clamp((clientX - rect.left - width / 2) / Math.max(1, rect.width - width));
    const y = clientY === undefined ? .95
      : clamp((clientY - rect.top - height / 2) / Math.max(1, rect.height - height));
    void save({ nodes: [...current, { id, x, y, skillIds: role.skillIds ?? [] }], edges: saved?.edges ?? [], configured: true });
  }

  stage.ondragover = (event) => {
    if (editable() && event.dataTransfer.types.includes("application/x-arrodes-role")) event.preventDefault();
  };
  stage.ondrop = (event) => {
    event.preventDefault();
    addRole(event.dataTransfer.getData("application/x-arrodes-role"), event.clientX, event.clientY);
  };

  function moveNode(handle, node, point) {
    const savePosition = (x, y) => save({
      nodes: positions().map((entry) => entry.id === point.id ? { ...entry, x, y } : entry),
      edges: saved?.edges ?? [],
      configured: saved?.configured ?? false,
    });
    handle.onkeydown = (event) => {
      const step = { ArrowLeft: [-.04, 0], ArrowRight: [.04, 0], ArrowUp: [0, -.08], ArrowDown: [0, .08] }[event.key];
      if (!step || !editable()) return;
      event.preventDefault();
      void savePosition(clamp(point.x + step[0]), clamp(point.y + step[1]));
    };
    handle.onpointerdown = (event) => {
      if (!editable() || event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      let next = point;
      handle.onpointermove = ({ clientX, clientY }) => {
        if (next === point && Math.hypot(clientX - startX, clientY - startY) < 4) return;
        next = { x: clamp(point.x + (clientX - startX) / Math.max(1, stage.clientWidth - node.offsetWidth)),
          y: clamp(point.y + (clientY - startY) / Math.max(1, stage.clientHeight - node.offsetHeight)) };
        place(node, next);
        drawEdges();
      };
      handle.onpointerup = () => {
        handle.onpointermove = null;
        if (next !== point) void savePosition(next.x, next.y);
      };
      handle.onpointercancel = () => { handle.onpointermove = null; place(node, point); drawEdges(); };
    };
  }

  function stateOf(id) {
    const tasks = [...status.values()].filter(({ roleId }) => roleId === id);
    const states = tasks.map((task) => task.status);
    const priority = ["running", "waiting_assist", "failed", "pending", "cancelled", "done"];
    const key = priority.find((value) => states.includes(value)) ?? "idle";
    const labels = {
      running: "执行中", waiting_assist: "等待协助", failed: "未通过",
      pending: "等待分派", cancelled: "已取消", done: "完成", idle: "就绪",
    };
    return { key, label: id === "coordinator" && key === "idle" && planned.size ? "已分工" : labels[key], tasks };
  }

  function connect(from, to) {
    pendingFrom = undefined;
    void save({ nodes: positions(), edges: [...(saved?.edges ?? []), { from, to }], configured: true });
  }

  function connectionPort(id, direction, lock) {
    const output = direction === "out";
    const label = output ? `从${name(id)}连线` : `连接到${name(id)}`;
    let dragged = false;
    const port = button("", () => {
      if (dragged) { dragged = false; return; }
      if (output) {
        pendingFrom = pendingFrom === id ? undefined : id;
        error.textContent = "";
        draw();
      } else if (pendingFrom) {
        connect(pendingFrom, id);
      }
    }, label, {
      class: "canvas-port", "data-port": direction, "data-port-agent": id,
      "data-canvas-focus": `port-${direction}-${id}`, title: output ? "发送 · 拖到接收圆点" : "接收",
      ...(output ? { "aria-pressed": String(pendingFrom === id) } : {}),
    });
    port.disabled = lock;
    if (output) port.onpointerdown = (event) => {
      if (event.button !== 0 || !editable()) return;
      dragged = false;
      port.setPointerCapture(event.pointerId);
      const start = port.getBoundingClientRect();
      const preview = svg("path", { class: "canvas-link preview", d: "" });
      port.onpointermove = (move) => {
        if (!dragged && Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) < 5) return;
        if (!dragged) graphics.append(preview);
        dragged = true;
        const area = stage.getBoundingClientRect();
        const x = start.left + start.width / 2 - area.left;
        const y = start.top + start.height / 2 - area.top;
        const endX = move.clientX - area.left;
        const endY = move.clientY - area.top;
        preview.setAttribute("d", connectionPath(x, y, endX, endY));
      };
      const finish = () => {
        port.onpointermove = null;
        preview.remove();
      };
      port.onpointerup = (up) => {
        finish();
        if (!dragged) return;
        const target = document.elementFromPoint(up.clientX, up.clientY)?.closest('[data-port="in"]');
        if (target && stage.contains(target)) connect(id, target.dataset.portAgent);
      };
      port.onpointercancel = finish;
    };
    return port;
  }

  function skillPicker(selected, saveButton) {
    const list = el("div", { class: "canvas-skill-list" });
    const message = el("p", { class: "error-text", role: "alert" });
    const feedback = el("p", { class: "hint", role: "status" });
    const renderList = () => list.replaceChildren(...skills.map(({ id, name, description, triggers }) => {
      const box = el("input", { type: "checkbox" });
      box.checked = selected.has(id);
      box.onchange = () => {
        if (box.checked) selected.add(id);
        else selected.delete(id);
      };
      return el("label", {}, box, el("span", {}, el("strong", {}, name),
        ...(description ? [el("small", {}, description)] : []),
        ...(triggers?.length ? [el("small", {}, `适用场景：${triggers.join("、")}`)] : [])));
    }));
    function register(result) {
      if (result.skills) {
        skills = result.skills;
        if (selected.size < 6) selected.add(result.id);
        renderList();
        feedback.textContent = `已导入 ${skills.find(({ id }) => id === result.id)?.name ?? "Skill"}`;
      }
    }
    const githubUrl = el("input", { type: "url", placeholder: "https://github.com/…", "aria-label": "GitHub 地址" });
    const scenarios = el("input", { maxlength: "320", placeholder: "例如：退款审计，重复退款" });
    const githubChoices = el("div", { class: "canvas-github-choices" });
    const githubButton = el("button", { type: "button", class: "tool", onclick: importGithub }, "导入 GitHub");
    let choice;
    function lockImport(disabled) {
      importer.disabled = saveButton.disabled = githubButton.disabled = githubUrl.disabled = scenarios.disabled = disabled;
      if (choice) choice.disabled = disabled;
    }
    async function importGithub() {
      message.textContent = "";
      feedback.textContent = "";
      const input = choice ? choice.value : githubUrl.value.trim();
      if (!input) { message.textContent = choice ? "请选择要导入的 Skill。" : "请输入 GitHub 地址。"; return; }
      lockImport(true);
      feedback.textContent = "正在读取 GitHub…";
      try {
        const result = await window.arrodes.importGithubSkill(input, scenarios.value);
        feedback.textContent = "";
        if (!result.ok) { message.textContent = result.error; return; }
        if (result.choices) {
          choice = el("select", { "aria-label": "选择 Skill" }, el("option", { value: "" }, "选择 Skill"),
            ...result.choices.map(({ path, url }) => el("option", { value: url }, path)));
          githubChoices.replaceChildren(choice);
          githubButton.textContent = "导入所选 Skill";
          choice.focus();
        } else {
          resetGithubChoices();
          githubUrl.value = "";
          register(result);
        }
      } catch {
        feedback.textContent = "";
        message.textContent = "无法从 GitHub 导入 Skill，请重试。";
      } finally {
        lockImport(false);
      }
    }
    function resetGithubChoices() {
      choice = undefined;
      githubChoices.replaceChildren();
      githubButton.textContent = "导入 GitHub";
    }
    githubUrl.oninput = resetGithubChoices;
    const githubForm = el("div", { class: "canvas-github-skill", onkeydown: (event) => {
      if (event.key === "Enter" && event.target === githubUrl) { event.preventDefault(); void importGithub(); }
    } },
      el("label", {}, "GitHub 地址", githubUrl), githubButton, githubChoices);

    const importer = button("导入 SKILL.md", async () => {
      lockImport(true);
      message.textContent = "";
      feedback.textContent = "";
      try {
        const result = await window.arrodes.importTeamSkill(scenarios.value);
        if (!result.ok) { message.textContent = result.error; return; }
        register(result);
      } catch {
        message.textContent = "无法导入 Skill，请重试。";
      } finally {
        lockImport(false);
      }
    });
    renderList();
    return {
      panel: el("div", { class: "canvas-skill-picker" },
        el("label", {}, "适用场景（可选，以逗号分隔）", scenarios),
        githubForm, feedback, message, list, importer),
      lock: lockImport,
    };
  }

  function showSkills(point) {
    if (!editable()) return;
    const selected = new Set(point.skillIds ?? []);
    const saveButton = button("保存", async () => {
      picker.lock(true);
      const ok = await save({
        nodes: positions().map((entry) => entry.id === point.id ? { ...entry, skillIds: [...selected] } : entry),
        edges: saved?.edges ?? [], configured: saved?.configured ?? false,
      });
      if (ok) dialog.close();
      else saveError.textContent = error.textContent || "无法保存 Skill，请重试。";
      picker.lock(false);
    }, "保存", { class: "primary" });
    const picker = skillPicker(selected, saveButton);
    const saveError = el("p", { class: "error-text", role: "alert" });
    const dialog = el("dialog", { class: "dialog role-dialog", "aria-labelledby": "canvas-skill-title" },
      el("h2", { id: "canvas-skill-title" }, `${name(point.id)} · Skill`), picker.panel, saveError,
      el("div", { class: "actions" },
        button("取消", () => dialog.close()), saveButton));
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  async function showExecutor(role, onSaved) {
    if (!editable()) return;
    const workspace = workspaceId;
    const optionsForWorkspace = await window.arrodes.getTeamExecutors().catch(() => executors);
    if (workspace !== workspaceId || !editable() || document.getElementById("role-executor-title")) return;
    executors = optionsForWorkspace;
    const selected = executorFor(role);
    const candidates = executors.map((option) =>
      role.access === "write" && option.supportsWrite === false
        ? { ...option, available: false, reason: "仅支持只读" } : option);
    const options = candidates.map(({ id, name, available, reason }) =>
      el("option", { value: id, ...(available ? {} : { disabled: "" }) },
        available ? name : `${name}（${reason ?? "待接入"}）`));
    const select = el("select", { id: "role-executor-choice", "aria-label": "执行器" }, ...options);
    select.value = selected;
    const current = saved?.roleSettings?.[role.id] ?? {};
    const model = el("input", { value: current.modelId ?? "", placeholder: "沿用执行器默认模型", maxlength: "150" });
    const instructions = el("textarea", { rows: "4", maxlength: "6000", placeholder: "填写职责补充、验收标准或运维要求" });
    instructions.value = current.instructions ?? "";
    const memory = el("input", { type: "checkbox" });
    memory.checked = current.memory === "persistent";
    const memoryField = el("label", { class: "role-access" }, memory, "延续这个角色的原生会话");
    const memoryHint = el("p", { class: "hint" }, "每个角色独立延续历史对话；工具、Skill 和记忆遵循该 Agent 自己的配置。");
    const details = el("p", { class: "hint" }, "设置按当前工作区和角色保存。");
    const message = el("p", { class: "error-text", role: "alert" });
    const saveButton = button("保存", async () => {
      select.disabled = saveButton.disabled = true;
      const ok = await save({
        nodes: positions(), edges: saved?.edges ?? [], configured: saved?.configured ?? false,
        roleExecutors: { ...roleExecutors(), [role.id]: select.value },
        roleSettings: { ...(saved?.roleSettings ?? {}), [role.id]: {
          instructions: instructions.value, modelId: model.value, memory: candidates.find(({id})=>id===select.value)?.supportsSession && memory.checked ? "persistent" : "ephemeral",
        } },
      });
      if (ok) { dialog.close(); onSaved?.(); }
      else {
        message.textContent = error.textContent || "无法保存执行器，请重试。";
        select.disabled = false;
        saveButton.disabled = !candidates.some(({ id, available }) => id === select.value && available);
      }
    }, "保存", { class: "primary" });
    select.onchange = () => {
      const option = candidates.find(({ id }) => id === select.value);
      saveButton.disabled = !option?.available;
      memory.disabled = !option?.supportsSession;
      memoryHint.hidden = !option?.supportsSession;
      model.placeholder = select.value === "builtin" ? "沿用 Arrodes 默认模型" : select.value === "dsh" ? "留空沿用 DSH；覆盖格式 provider/model" : "留空使用该 Agent 自己配置的模型";
      model.disabled = !option?.supportsModel;
      if (model.disabled) model.value = "";
      details.textContent = option?.detail ?? "";
    };
    select.onchange();
    const dialog = el("dialog", { class: "dialog role-dialog", "aria-labelledby": "role-executor-title" },
      el("h2", { id: "role-executor-title" }, `${role.name} · 执行器`),
      field("执行器", select), field("模型（可选）", model), field("角色指令", instructions), memoryField, memoryHint,
      details, message,
      el("div", { class: "actions" }, button("取消", () => dialog.close()), saveButton));
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  function draw() {
    const focus = document.activeElement?.getAttribute("data-canvas-focus");
    const lock = !editable();
    create.disabled = lock;
    mode.textContent = loading ? "读取中" : saved?.configured ? "按画布分工" : "自动分工";
    palette.replaceChildren(el("p", {}, "可用 Agent"));
    for (const role of roles.filter(({ id, access }) => access && !positions().some((node) => node.id === id))) {
      const entry = button(role.name, () => addRole(role.id), `添加${role.name}`, { draggable: String(!lock), title: role.description });
      entry.disabled = lock;
      entry.ondragstart = (event) => {
        event.dataTransfer.setData("application/x-arrodes-role", role.id);
        event.dataTransfer.effectAllowed = "copy";
      };
      palette.append(entry);
    }
    if (palette.childElementCount === 1) palette.append(el("span", {}, "拖入或新建 Agent"));

    nodes.replaceChildren(...visibleNodes().map((point) => {
      const { id, temporary } = point;
      const role = roles.find((entry) => entry.id === id);
      const status = stateOf(id);
      const handle = button(name(id), () => {}, `移动${name(id)}`, {
        class: "canvas-grip", "data-canvas-focus": `move-${id}`, title: role?.description ?? name(id),
      });
      handle.disabled = lock || temporary;
      const configured = (point.skillIds ?? []).map((skillId) => skills.find(({ id }) => id === skillId)?.name).filter(Boolean);
      const head = el("div", { class: "canvas-node-head" }, handle);
      if (!temporary) {
        const skill = button(configured.length ? `Skill ${configured.length}` : "Skill", () => showSkills(point),
          `配置${name(id)} 的 Skill`, { class: "canvas-skill-button", title: configured.join("、") || "选择角色 Skill" });
        skill.disabled = lock;
        head.append(skill);
      }
      const footer = el("div", { class: "canvas-node-footer" }, el("span", {}, status.label));
      if (!temporary && role) {
        const executor = executorFor(role);
        const label = executor === "builtin" ? "内置" : executors.find((option) => option.id === executor)?.name ?? executor;
        const choice = button(label, () => showExecutor(role), `配置${name(id)} 的执行器`, {
          class: "canvas-skill-button canvas-executor-button", title: `执行器：${label}`, "data-canvas-focus": `executor-${id}`,
        });
        choice.disabled = lock;
        footer.append(choice);
      }
      const node = el("article", { class: `canvas-node ${status.key}`, "data-agent": id }, head, footer);
      if (status.tasks.length) node.title = status.tasks.map(({ title }) => title).filter(Boolean).join("\n");
      place(node, point);
      moveNode(handle, node, point);
      if (role?.access && !temporary) {
        const remove = button("×", () => save({
          nodes: positions().filter((entry) => entry.id !== id),
          edges: (saved?.edges ?? []).filter(({ from, to }) => from !== id && to !== id),
          configured: true,
        }), `移除${role.name}`, { class: "canvas-icon" });
        remove.disabled = lock;
        node.lastChild.append(remove);
      }
      if (!temporary && id !== "coordinator") node.append(connectionPort(id, "in", lock));
      if (!temporary && id !== "reviewer") node.append(connectionPort(id, "out", lock));
      return node;
    }));
    info.replaceChildren(...(saved?.edges ?? []).map(({ from, to }) => {
      const label = `${name(from)} → ${name(to)}`;
      const chip = button(`${label} ×`, () => save({
        nodes: positions(), edges: saved.edges.filter((edge) => edge.from !== from || edge.to !== to),
        configured: true,
      }), `删除连线：${label}`);
      chip.disabled = lock;
      return chip;
    }));
    // 交接标签：跳过自指（同一角色的协助续跑），同向去重保留最后一次并显示次数
    const grouped = new Map();
    for (const event of handoffs) {
      if (event.from === event.to) continue;
      grouped.set(`${event.from}→${event.to}`, event);
    }
    transfers.replaceChildren(...[...grouped.values()].map((event) => {
      const count = handoffs.filter(({ from, to }) => from === event.from && to === event.to).length;
      const label = `${name(event.from)} → ${name(event.to)}${count > 1 ? ` ×${count}` : ""}`;
      return button(label, () => showTransfer(event), label, { title: `交接 · ${count} 次` });
    }));
    if (focus) [...root.querySelectorAll("[data-canvas-focus]")]
      .find((node) => node.getAttribute("data-canvas-focus") === focus)?.focus({ preventScroll: true });
    drawEdges();
  }

  function showTransfer(event) {
    selectedTransfer = event;
    drawEdges();
    const id = workspaceId;
    const preview = el("div", { class: "canvas-preview" });
    const dialog = el("dialog", { class: "dialog role-dialog", "aria-labelledby": "transfer-title" },
      el("h2", { id: "transfer-title" }, `${name(event.from)} → ${name(event.to)}`),
      el("div", { class: "canvas-artifacts" }, ...event.artifacts.map(({ kind, ref, summary }) =>
        kind === "file" ? button(ref, async () => {
          const result = await window.arrodes.canvasArtifact(id, ref);
          preview.replaceChildren(result.ok
            ? el("div", {}, ...(result.preview === undefined ? [] : [el("pre", {}, result.preview),
              ...(result.truncated ? [el("p", {}, "仅显示文件开头")] : [])]),
            button("在文件夹显示", async () => {
              const revealed = await window.arrodes.canvasArtifact(id, ref, true);
              if (!revealed.ok) preview.append(el("p", { role: "alert" }, revealed.error));
            }))
            : el("p", { role: "alert" }, result.error));
        }, `打开 ${ref}`) : el("p", {}, summary ?? ref))),
      preview,
      el("div", { class: "actions" }, button("关闭", () => dialog.close())),
    );
    dialog.addEventListener("close", () => {
      selectedTransfer = undefined;
      dialog.remove();
      drawEdges();
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  function fly({ from, to }) {
    if (!stage.isConnected || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const path = pathBetween(from, to);
    if (!path) return;
    const flight = svg("g", { "data-flight": "", "data-from": from, "data-to": to });
    flight.append(svg("path", { class: "canvas-plane", d: "M8 0L-7 -5-3 0-7 5ZM-3 0H4" }),
      svg("animateMotion", { path, rotate: "auto", begin: "indefinite", dur: "850ms", fill: "freeze" }));
    planes.append(flight);
    flight.lastChild.beginElement();
    setTimeout(() => flight.remove(), 850);
  }

  function receive(event, live = true) {
    if (event.type === "plan") {
      resetRun();
      error.textContent = "";
      pendingFrom = undefined;
      for (const task of event.tasks) {
        planned.set(task.taskId, task);
        status.set(task.taskId, { ...task, status: "pending" });
      }
    }
    const statuses = { "task.assigned": "running", "task.resumed": "running", "assist.requested": "waiting_assist" };
    const next = event.type === "task.finished" ? (event.passed ? "done" : "failed") : statuses[event.type];
    if (next && event.roleId) status.set(event.taskId, { ...status.get(event.taskId), roleId: event.roleId, status: next });
    if (event.type === "assist.requested" && event.roleId) helping.add(event.roleId);
    if (event.type === "task.resumed") helping.delete(event.roleId);
    const delivery = event.type === "task.handoff" || event.type === "assignment";
    if (delivery && event.from && event.to && event.from !== event.to) handoffs.push(event);
    if (event.type === "done") {
      helping.clear();
      for (const task of event.tasks) status.set(task.taskId, { ...status.get(task.taskId), ...task });
    }
    if (live) {
      draw();
      if (delivery && event.from && event.to) fly(event);
    }
  }

  function resetRun() {
    status = new Map();
    planned = new Map();
    handoffs = [];
    helping = new Set();
    selectedTransfer = undefined;
    planes.replaceChildren();
  }

  return {
    skillPicker,
    root,
    showExecutor,
    executorFor,
    get pending() { return saving || loading; },
    refreshRoles(catalog) { roles = catalog; draw(); },
    refreshExecutors(catalog) { executors = catalog; draw(); },
    refreshSkills(catalog) { skills = catalog; draw(); },
    receive,
    sync(workspace, conversation, history, running, liveEvents) {
      const busyChanged = busy !== running;
      busy = running;
      const workspaceChanged = workspace !== workspaceId;
      const conversationChanged = conversation !== conversationId;
      if (workspaceChanged || conversationChanged) {
        conversationId = conversation;
        pendingFrom = undefined;
        error.textContent = "";
        resetRun();
        const latest = history.findLast(({ collaboration }) => Array.isArray(collaboration?.canvasEvents));
        for (const event of latest?.collaboration.canvasEvents ?? []) receive(event, false);
        for (const event of liveEvents ?? []) receive(event, false);
      }
      if (workspaceChanged) {
        workspaceId = workspace;
        saved = null;
        roles = [];
        skills = [];
        executors = [];
        saving = false;
        loading = true;
        window.arrodes.getCanvas(workspace).then(({ graph, roles: catalog, skills: library, executors: options }) => {
          if (workspace !== workspaceId) return;
          saved = graph;
          roles = catalog;
          skills = library;
          executors = options;
        }).catch(() => {
          if (workspace === workspaceId) error.textContent = "无法读取画布，请切换工作区后重试。";
        }).finally(() => {
          if (workspace === workspaceId) { loading = false; draw(); updateSendButton(); }
        });
      }
      if (workspaceChanged || conversationChanged || busyChanged) draw();
    },
  };
}
