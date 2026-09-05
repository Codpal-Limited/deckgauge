import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { AzureDevOpsConfigSchema, type AzureDevOpsConfig } from './azure-devops-config-schema.js';

export { AzureDevOpsConfigSchema, type AzureDevOpsConfig } from './azure-devops-config-schema.js';

export class AdoConfigNotFoundError extends Error {
  constructor(path: string) {
    super(`Azure DevOps config file not found at ${path}`);
    this.name = 'AdoConfigNotFoundError';
  }
}

export function loadAzureDevOpsConfig(path: string): AzureDevOpsConfig {
  if (!fs.existsSync(path)) {
    throw new AdoConfigNotFoundError(path);
  }

  const content = fs.readFileSync(path, 'utf-8');
  const parsed = yaml.load(content);

  return AzureDevOpsConfigSchema.parse(parsed);
}
