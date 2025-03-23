import { z } from 'zod';

// Agent Types
export interface AgentOptions {
  task: string;
}

// Tool Types
export interface Tool {
  name: string;
  description: string;
  execute: (params: any) => Promise<any>;
  parameters: any;
}

// Step Types
export interface Step {
  id: number;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  result?: any;
}

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
}

// File Operation Types
export interface FileOperationResult {
  success: boolean;
  message: string;
  data?: any;
}

// Terminal Operation Types
export interface TerminalResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

export type FormatReportType = 'md' | 'html' | 'mdx';
