#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import dotenv from 'dotenv';
import { Agent } from './agent/agent';
import { AgentOptions } from './types';

dotenv.config();

// Define the CLI program
const program = new Command();

program
  .name('ai-agent')
  .description(
    'General AI agent CLI tool with planning and tool-using capabilities',
  )
  .version('1.0.0');

// Define the main command
program
  .requiredOption('-t, --task <task>', 'The task to perform')
  .action(async (options: any) => {
    // Check for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        chalk.red('Error: OPENAI_API_KEY environment variable is not set'),
      );
      console.log('Please set it in your .env file or environment variables');
      process.exit(1);
    }

    // Check for Exa.ai API key
    if (!process.env.EXA_API_KEY) {
      console.warn(
        chalk.yellow('Warning: EXA_API_KEY environment variable is not set'),
      );
      console.log('Search functionality will not work properly');
    }

    let userTask = options.task;

    // Now task is required via commander

    // Confirm API key availability based on the task
    if (
      userTask?.toLowerCase().includes('search') &&
      !process.env.EXA_API_KEY
    ) {
      console.warn(
        chalk.yellow(
          'This task may require search capabilities, but EXA_API_KEY is not set.',
        ),
      );
      console.log(
        'Search functionality may not work properly. Use at your own risk.',
      );
    }

    // Configure agent options
    const agentOptions: AgentOptions = {
      task: userTask!,
      llmModel: options.model,
      maxSteps: parseInt(options.steps, 10),
    };

    // Create and run the agent
    const agent = new Agent(agentOptions);
    const spinner = ora('Running AI agent...').start();

    try {
      const result = await agent.run();
    } catch (error) {
      spinner.fail(`AI agent failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Parse command line arguments and execute
program.parse(process.argv);
