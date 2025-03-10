import { z } from 'zod';

export interface Tool {
  name: string;
  description: string;
  execute: (args: any) => Promise<any>;
  schema: z.ZodObject<any>;
}

export interface Step {
  id: number;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  tool?: string;
  input?: any;
  output?: any;
  error?: string;
}

export interface ExecutionPlan {
  goal: string;
  steps: Step[];
  currentStep: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
}

export interface AgentContext {
  goal: string;
  memory: Map<string, any>;
  plan: ExecutionPlan;
  tools: Map<string, Tool>;
}

export interface AgentConfig {
  maxSteps: number;
  model: string;
  temperature: number;
  apiKey: string;
}
