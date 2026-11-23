import { existsSync, readFileSync } from "node:fs";

const packagedRules = new URL("./CLAUDE.md", import.meta.url);
const sourceRules = new URL("../../CLAUDE.md", import.meta.url);
export const projectRules = readFileSync(existsSync(packagedRules) ? packagedRules : sourceRules, "utf8");

const workflows = [
  [/写方案|改需求/, "project-plan-review"],
  [/\breview\b|代码审查|提交前检查/i, "project-code-review"],
  [/整理文档/, "project-doc-cleanup"],
];

export function projectWorkflow(text = "") {
  const root = existsSync(packagedRules) ? "./project-skills/" : "../../.agents/skills/";
  return workflows.filter(([trigger]) => trigger.test(text)).map(([, name]) =>
    readFileSync(new URL(`${root}${name}/SKILL.md`, import.meta.url), "utf8")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()
  ).join("\n\n");
}
