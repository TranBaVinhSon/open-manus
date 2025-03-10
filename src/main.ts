#!/usr/bin/env ts-node

import { Agent } from './agent/agent';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: agent "Your task command here"');
    process.exit(1);
  }
  const task = args.join(' ');
  const agent = new Agent({ task });
  await agent.run();
}

main().catch((err) => {
  console.error('Error running agent:', err);
  process.exit(1);
});
