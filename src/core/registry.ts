import type { Tool } from "./tools.js";

/**
 * Maps a tool name to its schema and executor.
 * Register more tools by calling `register`. Names must be unique.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  register(tool: Tool): this {
    const name = tool.schema.name;
    if (this.byName.has(name)) {
      throw new Error(`Tool "${name}" is already registered.`);
    }
    this.byName.set(name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  list(): Tool[] {
    return [...this.byName.values()];
  }
}
