import { searchTool } from './search';
import { fileOperationsTool } from './file';
import { Tool } from '../types';
import { browserTool } from './browser';
import { javascriptExecutorTool } from './javascript-executor';

// Export all tools
export const tools: Record<string, Tool> = {
  search: searchTool,
  browser: browserTool,
  fileOperations: fileOperationsTool,
  javascriptExecutor: javascriptExecutorTool,
};

// Get tool by name
export const getToolByName = (name: string): Tool | undefined => {
  return tools[name];
};

// Get all available tools
export const getAllTools = (): Tool[] => {
  return Object.values(tools);
};

export { searchTool, browserTool, fileOperationsTool, javascriptExecutorTool };
