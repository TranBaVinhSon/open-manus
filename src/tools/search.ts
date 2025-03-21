import { SearchResultItem, Tool } from '../types';
import dotenv from 'dotenv';
import Exa from 'exa-js';
import { z } from 'zod';

dotenv.config();
const apiKey = process.env.EXA_API_KEY;
if (!apiKey) {
  throw new Error('EXA_API_KEY is not set in the environment variables');
}
const exa = new Exa(apiKey);

// Exa.ai search tool
export const searchTool: Tool = {
  name: 'search',
  description: 'Search the web to get latest information on any topic.',
  parameters: z.object({
    query: z.string().describe('The search query'),
  }),
  execute: async (params: {
    query: string;
    numberOfResults: number;
  }): Promise<SearchResultItem[]> => {
    const { query, numberOfResults } = params;
    const exaResults = await exa.searchAndContents(query, {
      type: 'neural',
      useAutoprompt: true,
      numResults: numberOfResults || 5,
      text: true,
      // highlights: true,
      // summary: true,
    });

    return exaResults.results.map((result: any) => ({
      title: result.title,
      url: result.url,
      content: result.text,
    }));
  },
};
