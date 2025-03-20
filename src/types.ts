export interface CliOptions {
  // Add your CLI options interface here
}

// Agent Types
export interface AgentOptions {
  task: string;
  llmModel?: string;
  maxSteps?: number;
}

// Tool Types
export interface Tool {
  name: string;
  description: string;
  execute: (params: any) => Promise<any>;
  query?: (query: string) => Promise<string[]>;
  navigate?: (url: string) => Promise<void>;
  writeFile?: (filename: string, content: string) => Promise<void>;
}

// Step Types
export interface Step {
  id: number;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  params?: Record<string, any>;
  result?: any;
}

// Plan Types
export interface Plan {
  task: string;
  steps: Step[];
  currentStepIndex: number;
  completed: boolean;
}

// Result Types
export interface AgentResult {
  plan: Plan;
  finalAnswer: string;
  duration: number;
}

// Search Results Type
export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
}

export interface SearchResults {
  results: SearchResultItem[];
  numberOfResults?: number;
  query: string;
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
