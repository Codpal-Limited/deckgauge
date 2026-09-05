import * as fs from "fs";
import * as yaml from "js-yaml";
import { JiraConfigSchema, type JiraConfig } from "./jira-config-schema.js";

export { JiraConfigSchema, type JiraConfig } from "./jira-config-schema.js";

export class ConfigNotFoundError extends Error {
  constructor(path: string) {
    super(`Jira config file not found at ${path}`);
    this.name = "ConfigNotFoundError";
  }
}

export function loadJiraConfig(path: string): JiraConfig {
  if (!fs.existsSync(path)) {
    throw new ConfigNotFoundError(path);
  }

  const content = fs.readFileSync(path, "utf-8");
  const parsed = yaml.load(content);

  return JiraConfigSchema.parse(parsed);
}
