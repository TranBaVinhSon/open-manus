#!/usr/bin/env ts-node

import { Agent } from './agent/agent';
import { Command } from 'commander';

const program = new Command();

program
  .name('open-manus')
  .description(
    'General AI agent CLI tool with planning and tool-using capabilities',
  )
  .version('0.0.1');

program
  .option('-t, --task <task>', 'The task to execute')
  .action(async (options) => {
    const task = options.task;
    if (!task) {
      console.error('Error: Task is required. Use -t or --task option.');
      process.exit(1);
    }
    const agent = new Agent({ task });
    await agent.run();
  });

program.parse();
