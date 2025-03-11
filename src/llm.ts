import dotenv from 'dotenv';
import chalk from 'chalk';
import { openai } from '@ai-sdk/openai';
import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import { Step } from './types';

dotenv.config();

// Default models
const DEFAULT_MODEL = process.env.DEFAULT_LLM_MODEL || 'gpt-4o';

export async function getChatCompletion(
  messages: { role: string; content: string }[],
): Promise<string> {
  try {
    const { text } = await generateText({
      model: openai(DEFAULT_MODEL),
      system:
        'You are a helpful assistant that can answer questions and help with tasks.',
      prompt: messages.map((msg) => `${msg.role}: ${msg.content}`).join('\n\n'),
    });

    return text;
  } catch (error) {
    console.error(chalk.red(`Error from LLM: ${(error as Error).message}`));
    throw error;
  }
}

/**
 * Generate a plan for executing a complex task
 */
export async function generatePlan(task: string): Promise<Step[]> {
  const { object } = await generateObject({
    model: openai(DEFAULT_MODEL),
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
    prompt: `You are a strategic planning assistant that breaks down complex tasks into coherent, meaningful subtasks.

      TASK: "${task}"

      GUIDELINES FOR CREATING AN EFFECTIVE PLAN:
      1. Create substantial, logically sequenced subtasks.
      2. Each subtask must:
         - Be a complete unit of work with clear deliverables
         - Contain sufficient context to be executed independently
         - Build logically on previous subtasks when appropriate
      3. Ensure subtasks are substantial enough - avoid breaking tasks down too granularly
      4. Eliminate redundancy between subtasks
      5. Consider the overall workflow and how subtasks connect to achieve the main objective
      
      For each subtask, include:
      - A descriptive title that clearly states the objective
      - Comprehensive context including any relevant information from the main task
      - Any dependencies on previous subtasks
      - Success criteria that will indicate completion
      
      Focus on creating a coherent plan where each subtask contributes meaningfully to the overall goal.`,
  });

  return object.steps;
}
