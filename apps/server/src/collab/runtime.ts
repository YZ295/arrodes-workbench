import { ContractError, ERROR_CODES } from "@aew/contracts";

/**
 * 多 Agent 协作运行时（REQ-COLLAB-001..008）。
 *
 * 平台化关键：**计划来自配置，执行来自可注册的 executor**。
 * 这里不含任何分析语义——分析团队只是注册进来的一个 executor。
 */

export interface AgentSpec {
  id: string;
  name: string;
  responsibility: string;
  tools: string[];
  model?: string;
  capacity?: number;
}

export interface TaskSpec {
  taskId: string;
  assignee: string;
  dependsOn?: string[];
  /** 验收方式：用来挑选 executor 内置的校验。 */
  acceptance?: string;
  /** 说明文字，进入分工记录。 */
  deliverable?: string;
}

export interface TeamConfig {
  teamId: string;
  name: string;
  coordinator: string;
  agents: AgentSpec[];
  tasks: TaskSpec[];
}

export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "waiting_assist"
  | "done"
  | "failed"
  | "cancelled";

export interface ArtifactRef {
  taskId: string;
  kind: string;
  /** executor 给的稳定引用；下游只能通过它读取。 */
  ref: string;
  summary?: string;
}

export interface VerificationResult {
  passed: boolean;
  /** 未执行的检查项可以缺省（undefined），不要求所有项都有结论。 */
  checks: Record<string, boolean | undefined>;
  reason?: string;
}

export interface CollabTask {
  taskId: string;
  assignee: string;
  dependsOn: string[];
  deliverable: string;
  acceptance: string;
  status: TaskStatus;
  attempt: number;
  artifacts: ArtifactRef[];
  verification: VerificationResult | null;
  assistFor?: string;
}

export interface AssistRequest {
  taskId: string;
  needs: string;
  missingInput: string;
  expected: string;
}

export type CollabEvent =
  | { type: "collab.plan"; tasks: Array<{ taskId: string; assignee: string; dependsOn: string[] }> }
  | { type: "task.assigned"; taskId: string; assignee: string }
  | { type: "task.finished"; taskId: string; artifacts: string[]; passed: boolean }
  | { type: "task.handoff"; fromTask: string; toTask: string; artifactRefs: string[] }
  | { type: "assist.requested"; taskId: string; needs: string }
  | { type: "assist.resolved"; taskId: string; assistTaskId: string; action: string }
  | { type: "task.resumed"; taskId: string }
  | { type: "verification.summary"; passed: number; failed: number; accepted: string[] };

export interface ExecutorContext {
  task: CollabTask;
  upstream: ArtifactRef[];
  workspaceDir: string;
  signal?: AbortSignal;
  /** 任务需要协助时抛出，由运行时转成 waiting_assist。 */
  requestAssist?: (request: Omit<AssistRequest, "taskId">) => never;
}

export interface TaskExecutor {
  execute(context: ExecutorContext): Promise<{
    artifacts: ArtifactRef[];
    verification: VerificationResult;
  }>;
}

export class AssistNeeded extends Error {
  constructor(
    readonly needs: string,
    readonly missingInput: string,
    readonly expected: string,
  ) {
    super(`ASSIST_NEEDED: ${needs}`);
    this.name = "AssistNeeded";
  }
}

/** 配置校验：Agent 存在性、依赖存在性、成环、工具白名单。 */
export function validateTeam(
  team: TeamConfig,
  allowedTools: ReadonlySet<string> = new Set(),
): void {
  const agentIds = new Set(team.agents.map((agent) => agent.id));
  if (!agentIds.has(team.coordinator)) {
    throw new ContractError(ERROR_CODES.INVALID_TASK_REQUEST, `协调者不存在: ${team.coordinator}`);
  }
  const taskIds = new Set(team.tasks.map((task) => task.taskId));
  if (taskIds.size !== team.tasks.length) {
    throw new ContractError(ERROR_CODES.INVALID_TASK_REQUEST, "任务 id 重复");
  }
  for (const task of team.tasks) {
    if (!agentIds.has(task.assignee)) {
      throw new ContractError(
        ERROR_CODES.INVALID_TASK_REQUEST,
        `任务 ${task.taskId} 引用了不存在的 Agent: ${task.assignee}`,
      );
    }
    for (const dependency of task.dependsOn ?? []) {
      if (!taskIds.has(dependency)) {
        throw new ContractError(
          ERROR_CODES.INVALID_TASK_REQUEST,
          `任务 ${task.taskId} 依赖不存在的任务: ${dependency}`,
        );
      }
    }
  }
  const cycle = findCycle(team.tasks);
  if (cycle) {
    throw new ContractError(
      ERROR_CODES.INVALID_TASK_REQUEST,
      `任务依赖成环: ${cycle.join(" → ")}`,
    );
  }
  if (allowedTools.size > 0) {
    for (const agent of team.agents) {
      for (const tool of agent.tools) {
        if (!allowedTools.has(tool)) {
          throw new ContractError(
            ERROR_CODES.INVALID_TASK_REQUEST,
            `Agent ${agent.id} 申请了未注册的工具: ${tool}`,
          );
        }
      }
    }
  }
}

/** 返回环路径（用于错误信息），无环返回 null。 */
export function findCycle(tasks: Array<{ taskId: string; dependsOn?: string[] }>): string[] | null {
  const graph = new Map<string, string[]>();
  for (const task of tasks) graph.set(task.taskId, task.dependsOn ?? []);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const walk = (node: string): string[] | null => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const task of tasks) {
    const found = walk(task.taskId);
    if (found) return found;
  }
  return null;
}

export interface CollabRunResult {
  runId: string;
  status: "done" | "failed" | "cancelled";
  tasks: CollabTask[];
  events: CollabEvent[];
  summary: { passed: number; failed: number; accepted: string[]; failedTasks: string[] };
}

/**
 * 一次协作运行。调度规则：
 * - 依赖全部 done 才可派发；
 * - 无依赖关系（或依赖已满足）的任务**并发**执行；
 * - 任务请求协助时转 waiting_assist，由 `planAssist` 决定插什么任务，完成后 `resumed`；
 * - 已完成任务不因协助重算（用 `attempt` 与产物计数验证）。
 */
export class CollabRuntime {
  private readonly tasks: CollabTask[];
  private readonly events: CollabEvent[] = [];
  private readonly dispatched = new Set<string>();
  private cancelled = false;

  constructor(
    readonly runId: string,
    private readonly team: TeamConfig,
    private readonly executor: TaskExecutor,
    private readonly workspaceDir = process.cwd(),
    private readonly hooks: {
      onEvent?: (event: CollabEvent, seq: number) => void;
      onTasks?: (tasks: CollabTask[]) => void;
    } = {},
  ) {
    this.tasks = team.tasks.map((task) => ({
      taskId: task.taskId,
      assignee: task.assignee,
      dependsOn: task.dependsOn ?? [],
      deliverable: task.deliverable ?? "",
      acceptance: task.acceptance ?? "default",
      status: "pending",
      attempt: 0,
      artifacts: [],
      verification: null,
    }));
    this.emit({
      type: "collab.plan",
      tasks: this.tasks.map((task) => ({
        taskId: task.taskId,
        assignee: task.assignee,
        dependsOn: task.dependsOn,
      })),
    });
  }

  private emit(event: CollabEvent): void {
    this.events.push(event);
    this.hooks.onEvent?.(event, this.events.length);
    this.hooks.onTasks?.(this.getTasks());
  }

  private byId(taskId: string): CollabTask | undefined {
    return this.tasks.find((task) => task.taskId === taskId);
  }

  /** 幂等键：同一任务同一 attempt 只能派发一次。 */
  private keyOf(task: CollabTask): string {
    return `${this.runId}:${task.taskId}:${task.attempt}`;
  }

  cancel(): void {
    this.cancelled = true;
    for (const task of this.tasks) {
      if (task.status === "pending" || task.status === "assigned" || task.status === "running" || task.status === "waiting_assist") {
        task.status = "cancelled";
      }
    }
  }

  getTasks(): CollabTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  getEvents(): CollabEvent[] {
    return [...this.events];
  }

  private ready(): CollabTask[] {
    return this.tasks.filter((task) => {
      if (task.status !== "pending") return false;
      if (this.dispatched.has(this.keyOf(task))) return false;
      return task.dependsOn.every((dependency) => this.byId(dependency)?.status === "done");
    });
  }

  private upstreamOf(task: CollabTask): ArtifactRef[] {
    return task.dependsOn.flatMap((dependency) => this.byId(dependency)?.artifacts ?? []);
  }

  private async runOne(task: CollabTask): Promise<void> {
    if (this.cancelled) return;
    this.dispatched.add(this.keyOf(task));
    task.status = "assigned";
    this.emit({ type: "task.assigned", taskId: task.taskId, assignee: task.assignee });
    task.status = "running";
    this.hooks.onTasks?.(this.getTasks());

    const upstream = this.upstreamOf(task);
    for (const dependency of task.dependsOn) {
      const artifacts = this.byId(dependency)?.artifacts;
      if (artifacts?.length) {
        this.emit({
          type: "task.handoff",
          fromTask: dependency,
          toTask: task.taskId,
          artifactRefs: artifacts.map((artifact) => artifact.ref),
        });
      }
    }

    try {
      const result = await this.executor.execute({
        task,
        upstream,
        workspaceDir: this.workspaceDir,
        requestAssist: (request) => {
          throw new AssistNeeded(request.needs, request.missingInput, request.expected);
        },
      });
      task.artifacts = result.artifacts;
      task.verification = result.verification;
      task.status = "done";
      this.emit({
        type: "task.finished",
        taskId: task.taskId,
        artifacts: result.artifacts.map((artifact) => artifact.ref),
        passed: result.verification.passed,
      });
    } catch (error) {
      if (error instanceof AssistNeeded) {
        task.status = "waiting_assist";
        this.emit({ type: "assist.requested", taskId: task.taskId, needs: error.needs });
        await this.resolveAssist(task, error);
        return;
      }
      task.status = "failed";
      task.verification = {
        passed: false,
        checks: {},
        reason: error instanceof Error ? error.message : String(error),
      };
      this.emit({ type: "task.finished", taskId: task.taskId, artifacts: [], passed: false });
    }
  }

  /**
   * 协助处置：插入一个协助任务，完成后原任务继续。
   * 协助任务本身也走依赖校验，形成环则拒绝并保持原任务 waiting_assist。
   */
  private async resolveAssist(task: CollabTask, error: AssistNeeded): Promise<void> {
    const assistTaskId = `${task.taskId}::assist`;
    if (this.byId(assistTaskId)) {
      task.status = "failed";
      task.verification = { passed: false, checks: {}, reason: "协助任务重复" };
      return;
    }
    const candidate: CollabTask = {
      taskId: assistTaskId,
      assignee: this.team.coordinator,
      dependsOn: [],
      deliverable: `协助：${error.needs}`,
      acceptance: "assist",
      status: "pending",
      attempt: 0,
      artifacts: [],
      verification: null,
      assistFor: task.taskId,
    };
    // 模拟协调决策：新增协助任务，并让原任务依赖它。
    const proposed = [...this.tasks, candidate].map((item) =>
      item.taskId === task.taskId ? { ...item, dependsOn: [...item.dependsOn, assistTaskId] } : item,
    );
    const cycle = findCycle(proposed);
    if (cycle) {
      // 环无法自动消解；留 waiting_assist 会让整轮永远等待，因此收敛为 failed 并记录环路径。
      task.status = "failed";
      task.verification = { passed: false, checks: {}, reason: `协助依赖成环: ${cycle.join(" → ")}` };
      this.emit({ type: "assist.resolved", taskId: task.taskId, assistTaskId, action: "rejected_cycle" });
      this.emit({ type: "task.finished", taskId: task.taskId, artifacts: [], passed: false });
      return;
    }
    this.tasks.push(candidate);
    task.dependsOn = [...task.dependsOn, assistTaskId];
    this.emit({ type: "assist.resolved", taskId: task.taskId, assistTaskId, action: "new_task" });

    await this.runOne(candidate);

    if (candidate.status === "done" && candidate.verification?.passed) {
      // 续跑：attempt 递增，但已完成产物保留，不重算
      task.attempt += 1;
      task.status = "pending";
      this.hooks.onTasks?.(this.getTasks());
      this.emit({ type: "task.resumed", taskId: task.taskId });
      await this.runOne(task);
      return;
    }

    // 协助没成功：原任务必须收敛成明确终态。
    // 停在 waiting_assist 会让 run() 一直等下去（没有外部决策者来唤醒它）。
    task.status = "failed";
    task.verification = {
      passed: false,
      checks: {},
      reason: `协助未完成：${candidate.verification?.reason ?? `协助任务状态 ${candidate.status}`}`,
    };
    this.emit({ type: "task.finished", taskId: task.taskId, artifacts: [], passed: false });
  }

  async run(): Promise<CollabRunResult> {
    // 并发派发：每轮把能跑的ready任务一起发出
    for (;;) {
      if (this.cancelled) break;
      const ready = this.ready();
      if (ready.length === 0) {
        const inFlight = this.tasks.some(
          (task) => task.status === "running" || task.status === "assigned",
        );
        if (!inFlight) {
          // 没有在途任务却还有等待协助的：说明协助链路已经断了。
          // 必须收敛，不能靠轮询等一个不会到来的外部决策。
          for (const stuck of this.tasks.filter((task) => task.status === "waiting_assist")) {
            stuck.status = "failed";
            stuck.verification = {
              passed: false,
              checks: {},
              reason: "协助请求无人处理，任务终止",
            };
            this.emit({ type: "task.finished", taskId: stuck.taskId, artifacts: [], passed: false });
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      await Promise.all(ready.map((task) => this.runOne(task)));
    }

    const accepted = this.tasks
      .filter((task) => task.status === "done" && task.verification?.passed)
      .map((task) => task.taskId);
    const failedTasks = this.tasks
      .filter((task) => task.status === "failed" || (task.status === "done" && !task.verification?.passed))
      .map((task) => task.taskId);

    this.emit({
      type: "verification.summary",
      passed: accepted.length,
      failed: failedTasks.length,
      accepted,
    });

    const status: CollabRunResult["status"] = this.cancelled
      ? "cancelled"
      : failedTasks.length > 0
        ? "failed"
        : "done";

    return {
      runId: this.runId,
      status,
      tasks: this.getTasks(),
      events: this.getEvents(),
      summary: { passed: accepted.length, failed: failedTasks.length, accepted, failedTasks },
    };
  }
}
