import dotenv from 'dotenv';
import chalk from 'chalk';
import { openai } from '@ai-sdk/openai';
import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import { Step } from './types';

dotenv.config();

// Default models
const DEFAULT_MODEL = process.env.DEFAULT_LLM_MODEL || 'gpt-4o-mini';

export async function getChatCompletion(
  messages: { role: string; content: string }[],
  model?: string,
): Promise<string> {
  try {
    const { text } = await generateText({
      model: openai(model || DEFAULT_MODEL),
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
