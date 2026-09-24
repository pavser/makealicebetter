import { Injectable, Logger } from '@nestjs/common';

/**
 * What a tool may return. Kept compatible with the Agents SDK's `AgentToolOutput`
 * so handlers can be passed straight to `sessions.stream({ toolHandlers })`.
 */
export type ToolResult = string | object | null;

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

export interface RegisteredTool {
  name: string;
  description: string;
  handler: ToolHandler;
}

export interface ToolExecutionResult {
  success: boolean;
  output?: ToolResult;
  error?: string;
}

/**
 * Registry of application function tools the saved Agent may call.
 *
 * Empty by default: the Agent's own tools (web search, MCP, connectors) are
 * configured in the OpenAI Platform and executed by OpenAI, so nothing is
 * needed here for them. This exists so that adding a local tool later
 * (Home Assistant, calendar, custom HTTP API) is a one-line registration.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  /** Handlers in the shape the Agents SDK expects for `sessions.stream({ toolHandlers })`. */
  handlers(): Record<string, ToolHandler> {
    return Object.fromEntries([...this.tools].map(([name, tool]) => [name, tool.handler]));
  }

  /**
   * Runs a tool requested by the Agent. An unknown tool is a normal outcome, not
   * a crash: the caller reports the failure back so the session can move on.
   */
  async execute(name: string, args: unknown): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      this.logger.warn(`Agent requested unknown tool "${name}"`);
      return { success: false, error: `Tool "${name}" is not available` };
    }

    try {
      const output = await tool.handler((args ?? {}) as Record<string, unknown>);
      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tool "${name}" failed: ${message}`);
      return { success: false, error: 'Tool execution failed' };
    }
  }
}
