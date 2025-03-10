import dotenv from 'dotenv';
import chalk from 'chalk';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { Step } from './types';
import OpenAI from 'openai';

dotenv.config();

// Default models
const DEFAULT_MODEL = process.env.DEFAULT_LLM_MODEL || 'gpt-4o-mini';

// Initialize OpenAI client for direct API access when needed
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Tracks the active model
let activeModel = DEFAULT_MODEL;

/**
 * Set the active model for the LLM
 */
export function setActiveModel(model: string): void {
  activeModel = model;
  console.log(chalk.blue(`Active model set to: ${model}`));
}

/**
 * Get the current active model
 */
export function getActiveModel(): string {
  return activeModel;
}

/**
 * Convert custom message format to OpenAI's required format
 */
function convertToOpenAIMessages(
  messages: { role: string; content: string }[],
) {
  return messages.map((msg) => ({
    role: msg.role as 'system' | 'user' | 'assistant',
    content: msg.content,
  }));
}

/**
 * Get chat completion with text streaming support
 */
export async function getChatCompletion(
  messages: { role: string; content: string }[],
  model?: string,
  onProgress?: (content: string) => void,
): Promise<string> {
  const selectedModel = model || activeModel;

  try {
    if (onProgress) {
      // For streaming, use OpenAI client directly
      const stream = await openaiClient.chat.completions.create({
        model: selectedModel,
        messages: convertToOpenAIMessages(messages),
        stream: true,
      });

      let fullContent = '';
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullContent += content;
        if (content) onProgress(fullContent);
      }
      return fullContent;
    } else {
      // Non-streaming response using Vercel AI SDK
      const response = await openaiClient.chat.completions.create({
        model: selectedModel,
        messages: convertToOpenAIMessages(messages),
      });

      return response.choices[0]?.message?.content || '';
    }
  } catch (error) {
    console.error(chalk.red(`Error from LLM: ${(error as Error).message}`));
    throw error;
  }
}

/**
 * Get chat completion specifically for reasoning tasks (uses stronger model)
 */
export async function getReasoningCompletion(
  messages: { role: string; content: string }[],
): Promise<string> {
  return getChatCompletion(messages, DEFAULT_MODEL);
}

/**
 * Generate a plan for executing a complex task
 */
export async function generatePlan(task: string): Promise<Step[]> {
  const { object } = await generateObject({
    model: openai('gpt-4o'),
    schema: z.object({
      steps: z.array(
        z.object({
          id: z.number(),
          description: z.string(),
          status: z
            .enum(['pending', 'running', 'completed', 'failed'])
            .default('pending'),
          params: z.record(z.any()).optional(),
        }),
      ),
    }),
    prompt: `You are a planning assistant that divides complex tasks into manageable subtasks.
      Break down this task into manageable subtasks: "${task}".
      Each subtask should be a self-contained unit of work that an AI agent can handle using all available tools.
      Don't specify which exact tool to use for each subtask - the AI agent will determine that.
      For each subtask, provide:
      - A clear description of the goal to be achieved
      - Any relevant context or constraints
      Focus on WHAT needs to be accomplished, not HOW to do it.`,
  });

  return object.steps;
}
